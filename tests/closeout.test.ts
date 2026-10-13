/**
 * R52 on a local validator: after settlement, a wallet with resting orders on both sides runs the
 * SDK's `buildCloseOutAndRedeem` exactly as built (each transaction signed by the wallet alone, at
 * most 1232 bytes, sent in order) and ends with no resting orders, zero Yes and No, and the exact
 * USDC payout. The orders themselves go through the SDK's trade builders, so they are the real
 * ones the app places.
 *
 * Runs with the other integration tests (`anchor test`); see `lifecycle.test.ts` for running
 * against your own validator.
 */
import {
  buildBuyNoTransaction,
  buildBuyYesTransaction,
  buildCloseOutAndRedeem,
} from '@meridian/sdk'
import type { CloseOutContext } from '@meridian/sdk'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { expect } from 'chai'
import {
  UNIT,
  balances,
  bootstrap,
  chainNow,
  connection,
  createMarket,
  enableDemoMode,
  expectVault,
  fetchMarket,
  freshWallet,
  publishRelayClose,
  sendSdkTransaction,
  settleMarket,
  tradeContext,
  waitUntil,
  walletBook,
} from './support/meridian.js'
import type { TestMarket } from './support/meridian.js'

const usdc = (dollars: number) => BigInt(Math.round(dollars * 1_000_000))
const tokens = (n: number) => BigInt(n) * UNIT

/** Resting orders for the split case: more than one close-out transaction holds (about 22). */
const SPLIT_BIDS = 12
const SPLIT_ASKS = 12

/** What `buildCloseOutAndRedeem` needs, from the wallet's live balances, book seat and outcome. */
async function closeOutContext(owner: PublicKey, market: TestMarket): Promise<CloseOutContext> {
  const [held, book, state, { blockhash }] = await Promise.all([
    balances(owner, market),
    walletBook(owner, market),
    fetchMarket(market),
    connection.getLatestBlockhash('confirmed'),
  ])
  let outcome: CloseOutContext['outcome'] = null
  if (state.outcome) outcome = 'yes' in state.outcome ? 'Yes' : 'No'
  return {
    owner,
    market: market.accounts,
    outcome,
    walletYesBaseUnits: held.yes,
    walletNoBaseUnits: held.no,
    restingOrders: book.restingOrders,
    seat: book.seat,
    recentBlockhash: blockhash,
  }
}

/** A Yes bid of `qty` at `priceCents`, through the SDK's Buy Yes limit. */
async function restBid(wallet: Keypair, market: TestMarket, priceCents: number, qty: number) {
  await sendSdkTransaction(
    buildBuyYesTransaction(await tradeContext(wallet.publicKey, market), {
      kind: 'Limit',
      priceCents,
      qty,
    }),
    wallet,
  )
}

/** A Buy No limit: mints `qty` pairs and rests their Yes as an ask at `yesAskCents`. */
async function restAsk(wallet: Keypair, market: TestMarket, yesAskCents: number, qty: number) {
  await sendSdkTransaction(
    buildBuyNoTransaction(await tradeContext(wallet.publicKey, market), {
      kind: 'Limit',
      noPriceCents: 100 - yesAskCents,
      qty,
    }),
    wallet,
  )
}

describe('R52 close out orders and redeem after settlement, with the SDK builder', () => {
  let single: TestMarket
  let split: TestMarket
  let singleWallet: Keypair
  let splitWallet: Keypair

  before(async () => {
    const { admin } = await bootstrap()
    await enableDemoMode(admin)
    const now = await chainNow()
    // One ticker-day, two strikes below the replayed MSFT close of $521.58, so both settle Yes.
    // The close leaves time to place every order first.
    const closeTs = now + 90
    const params = { ticker: 'MSFT', tradingDay: '2026-11-16', closeTs, openTs: now - 60 }
    single = await createMarket({ ...params, strike: 52_000n })
    split = await createMarket({ ...params, strike: 51_900n })

    // Single: a bid of 3 at 30¢, then a Buy No 2 limit whose Yes rests as an ask at 60¢.
    singleWallet = await freshWallet(single, { usdc: usdc(10) })
    await restBid(singleWallet, single, 30, 3)
    await restAsk(singleWallet, single, 60, 2)
    // Another wallet buys 1 of the 2 resting Yes, so the seat also holds $0.60 of proceeds.
    const buyer = await freshWallet(single, { usdc: usdc(5) })
    await sendSdkTransaction(
      buildBuyYesTransaction(await tradeContext(buyer.publicKey, single), {
        kind: 'Market',
        priceCents: 60,
        qty: 1,
      }),
      buyer,
    )

    // Split: 12 bids of 1 at 20¢ to 31¢, and 12 Buy No limits whose Yes rests at 61¢ to 72¢.
    splitWallet = await freshWallet(split, { usdc: usdc(60) })
    for (let i = 0; i < SPLIT_BIDS; i++) await restBid(splitWallet, split, 20 + i, 1)
    for (let i = 0; i < SPLIT_ASKS; i++) await restAsk(splitWallet, split, 61 + i, 1)

    await waitUntil(closeTs + 1)
    expect((await publishRelayClose(single)).status).to.equal('published')
    await settleMarket(single)
    await settleMarket(split)
  })

  it('one transaction cancels both sides, settles funds and redeems: no orders, Yes 0, No 0, exact USDC', async () => {
    expect('yes' in ((await fetchMarket(single)).outcome ?? {}), '$521.58 ≥ $520.00').to.equal(true)
    // $10 − $0.90 escrowed for the bid − $2 for the pairs.
    expect(await balances(singleWallet.publicKey, single), 'before').to.deep.equal({
      usdc: usdc(7.1),
      yes: 0n,
      no: tokens(2),
    })
    const before = await walletBook(singleWallet.publicKey, single)
    expect(before.restingOrders.map((o) => [o.side, o.priceCents, o.qty])).to.deep.equal([
      ['Bid', 30, 3],
      ['Ask', 60, 1],
    ])

    const plan = buildCloseOutAndRedeem(await closeOutContext(singleWallet.publicKey, single))
    expect(plan.split, 'two resting orders fit one transaction').to.equal(false)
    expect(plan.transactions).to.have.length(1)
    for (const tx of plan.transactions) await sendSdkTransaction(tx, singleWallet)

    // + $0.90 bid escrow + $0.60 fill proceeds + $1 for the 1 winning Yes; the 2 No pay nothing.
    expect(await balances(singleWallet.publicKey, single), 'after').to.deep.equal({
      usdc: usdc(9.6),
      yes: 0n,
      no: 0n,
    })
    const after = await walletBook(singleWallet.publicKey, single)
    expect(after.restingOrders, 'no resting orders').to.deep.equal([])
    expect(after.seat, 'nothing left in the seat').to.satisfy(
      (seat: typeof after.seat) =>
        seat === null || (seat.freeYesBaseUnits === 0n && seat.freeUsdcBaseUnits === 0n),
    )
    // Only the buyer's 1 Yes is still outstanding.
    await expectVault(single, usdc(1))
  })

  it('too many orders for one transaction: the split plan, signed and sent in order, ends the same way', async () => {
    // $60 − $3.06 escrowed for the bids (20¢ + … + 31¢) − $12 for the pairs.
    expect(await balances(splitWallet.publicKey, split), 'before').to.deep.equal({
      usdc: usdc(44.94),
      yes: 0n,
      no: tokens(SPLIT_ASKS),
    })
    expect((await walletBook(splitWallet.publicKey, split)).restingOrders).to.have.length(
      SPLIT_BIDS + SPLIT_ASKS,
    )

    const plan = buildCloseOutAndRedeem(await closeOutContext(splitWallet.publicKey, split))
    expect(plan.split, '24 resting orders need more than one transaction').to.equal(true)
    expect(plan.transactions.length).to.be.greaterThan(1)
    for (const tx of plan.transactions) await sendSdkTransaction(tx, splitWallet)

    // Back to the $60 it started with: every escrow returned and 12 winning Yes paid $1 each.
    expect(await balances(splitWallet.publicKey, split), 'after').to.deep.equal({
      usdc: usdc(60),
      yes: 0n,
      no: 0n,
    })
    expect((await walletBook(splitWallet.publicKey, split)).restingOrders).to.deep.equal([])
    await expectVault(split, 0n)
  })
})
