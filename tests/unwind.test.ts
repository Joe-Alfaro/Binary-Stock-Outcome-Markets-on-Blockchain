/**
 * R28 [G] on a local validator: a wallet holding Yes and No because of a resting Buy No limit
 * cancels and closes out before settlement with the SDK's `buildCancelOrder` and
 * `buildCloseOutPosition`, sent exactly as built (one wallet signature, at most 1232 bytes).
 * The Buy No itself goes through the SDK's `buildBuyNoTransaction`, so the resting order is the
 * real one.
 *
 * Runs with the other integration tests (`anchor test`); see `lifecycle.test.ts` for running
 * against your own validator.
 */
import {
  buildBuyNoTransaction,
  buildBuyYesTransaction,
  buildCancelOrder,
  buildCloseOutPosition,
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
  sendSdkTransaction,
  tradeContext,
  walletBook,
} from './support/meridian.js'
import type { TestMarket } from './support/meridian.js'

const usdc = (dollars: number) => BigInt(Math.round(dollars * 1_000_000))
const tokens = (n: number) => BigInt(n) * UNIT

/** What the unwind builders need, from the wallet's live balances and book seat. */
async function unwindContext(owner: PublicKey, market: TestMarket): Promise<CloseOutContext> {
  const [held, book, { blockhash }] = await Promise.all([
    balances(owner, market),
    walletBook(owner, market),
    connection.getLatestBlockhash('confirmed'),
  ])
  return {
    owner,
    market: market.accounts,
    outcome: null,
    walletYesBaseUnits: held.yes,
    walletNoBaseUnits: held.no,
    restingOrders: book.restingOrders,
    seat: book.seat,
    recentBlockhash: blockhash,
  }
}

/** A fresh wallet with $10 that places a Buy No 5 limit at 40¢: its Yes rests as an ask at 60¢. */
async function restingBuyNo(market: TestMarket): Promise<Keypair> {
  const wallet = await freshWallet(market, { usdc: usdc(10) })
  await sendSdkTransaction(
    buildBuyNoTransaction(await tradeContext(wallet.publicKey, market), {
      kind: 'Limit',
      noPriceCents: 40,
      qty: 5,
    }),
    wallet,
  )
  expect(await balances(wallet.publicKey, market), 'holds No, Yes escrowed').to.deep.equal({
    usdc: usdc(5),
    yes: 0n,
    no: tokens(5),
  })
  const book = await walletBook(wallet.publicKey, market)
  expect(book.restingOrders.map((o) => [o.side, o.priceCents, o.qty])).to.deep.equal([
    ['Ask', 60, 5],
  ])
  return wallet
}

async function sendPlan(
  plan: { transactions: Parameters<typeof sendSdkTransaction>[0][] },
  wallet: Keypair,
) {
  for (const tx of plan.transactions) await sendSdkTransaction(tx, wallet)
}

describe('R28 [G] unwind a resting Buy No before settlement, with the SDK builders', () => {
  const markets: TestMarket[] = []

  before(async () => {
    const { admin } = await bootstrap()
    await enableDemoMode(admin)
    const now = await chainNow()
    // One strike per scenario, so no scenario's orders meet another's. Open for the whole run.
    for (const strike of [18_000n, 18_100n, 18_200n]) {
      markets.push(
        await createMarket({
          ticker: 'NVDA',
          tradingDay: '2026-11-09',
          strike,
          closeTs: now + 3600,
          openTs: now - 60,
        }),
      )
    }
  })

  function marketAt(index: number): TestMarket {
    const market = markets[index]
    if (!market) throw new Error(`no market ${index}`)
    return market
  }

  it('Close out position: one transaction cancels, settles and merges; Yes 0, No 0, USDC restored', async () => {
    const market = marketAt(0)
    const wallet = await restingBuyNo(market)

    const plan = buildCloseOutPosition(await unwindContext(wallet.publicKey, market))
    expect(plan.split, 'one transaction for one resting order').to.equal(false)
    await sendPlan(plan, wallet)

    expect(await balances(wallet.publicKey, market)).to.deep.equal({
      usdc: usdc(10),
      yes: 0n,
      no: 0n,
    })
    expect((await walletBook(wallet.publicKey, market)).restingOrders).to.deep.equal([])
    expect('open' in (await fetchMarket(market)).status, 'still before settlement').to.equal(true)
    await expectVault(market, 0n)
  })

  it('Cancel order returns the Yes to the wallet; Close out position then merges it', async () => {
    const market = marketAt(1)
    const wallet = await restingBuyNo(market)
    const [order] = (await walletBook(wallet.publicKey, market)).restingOrders
    if (!order) throw new Error('no resting order')

    await sendSdkTransaction(
      buildCancelOrder(await unwindContext(wallet.publicKey, market), order.orderId),
      wallet,
    )
    expect(await balances(wallet.publicKey, market), 'after cancel').to.deep.equal({
      usdc: usdc(5),
      yes: tokens(5),
      no: tokens(5),
    })
    expect((await walletBook(wallet.publicKey, market)).restingOrders).to.deep.equal([])

    await sendPlan(buildCloseOutPosition(await unwindContext(wallet.publicKey, market)), wallet)
    expect(await balances(wallet.publicKey, market), 'after close out').to.deep.equal({
      usdc: usdc(10),
      yes: 0n,
      no: 0n,
    })
    await expectVault(market, 0n)
  })

  it('after a partial fill, closes out the rest and keeps only the No that was bought', async () => {
    const market = marketAt(2)
    const wallet = await restingBuyNo(market)
    // Another wallet buys 2 of the 5 resting Yes at 60¢.
    const buyer = await freshWallet(market, { usdc: usdc(5) })
    await sendSdkTransaction(
      buildBuyYesTransaction(await tradeContext(buyer.publicKey, market), {
        kind: 'Market',
        priceCents: 60,
        qty: 2,
      }),
      buyer,
    )

    await sendPlan(buildCloseOutPosition(await unwindContext(wallet.publicKey, market)), wallet)

    // $5 left + $1.20 from the 2 Yes sold + $3 from merging the 3 pairs back.
    expect(await balances(wallet.publicKey, market)).to.deep.equal({
      usdc: usdc(9.2),
      yes: 0n,
      no: tokens(2),
    })
    expect((await walletBook(wallet.publicKey, market)).restingOrders).to.deep.equal([])
    await expectVault(market, usdc(2))
  })
})
