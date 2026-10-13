/**
 * Validator measurements and the R6 donation scenario, on the same local validator as the
 * lifecycle tests (see `lifecycle.test.ts` for how to run them against your own validator).
 *
 * - R6: 5 USDC sent straight to a vault, then mint, merge, trade, settle and redeem in one
 *   scenario, with exact payouts; the donation is never paid out.
 * - R19: one taker order sweeping the maximum number of fills stays under 1.4M compute units on
 *   the validator (LiteSVM measures the same in `programs/meridian/tests/orderbook_limits.rs`).
 * - R19: the rent figures the README states match the accounts `create_strike_market` creates.
 */
import { buildBuyYesTransaction, buildSellYesTransaction } from '@meridian/sdk'
import type { Keypair } from '@solana/web3.js'
import { PublicKey, TransactionInstruction } from '@solana/web3.js'
import { expect } from 'chai'
import type { Context } from 'mocha'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BN,
  TICKERS,
  UNIT,
  ata,
  balances,
  bootstrap,
  chainNow,
  connection,
  createMarket,
  enableDemoMode,
  fetchMarket,
  freshWallet,
  meridian,
  mintPair,
  publishRelayClose,
  redeemAll,
  sendLegacy,
  sendSdkTransaction,
  settleFunds,
  settleMarket,
  tokenBalance,
  tradeContext,
  waitUntil,
} from './support/meridian.js'
import type { TestMarket } from './support/meridian.js'

const usdc = (dollars: number) => BigInt(Math.round(dollars * 1_000_000))
const tokens = (n: number) => BigInt(n) * UNIT

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
/** The per-transaction compute ceiling, which the SDK builders also request. */
const MAX_TX_COMPUTE_UNITS = 1_400_000
/** On-chain capacities (R19, `state/orderbook.rs`). */
const BOOK_SIDE_CAPACITY = 32
const MAX_FILLS_PER_ORDER = 16
/** About 49 strike markets a trading day across the seven tickers (R19). */
const MARKETS_PER_DAY = 49

/** Steps share chain state; once one fails the rest are skipped, as in the lifecycle suite. */
function scenario() {
  let failed = false
  return function step(title: string, fn: () => Promise<void>) {
    it(title, async function (this: Context) {
      if (failed) this.skip()
      try {
        await fn()
      } catch (error) {
        failed = true
        throw error
      }
    })
  }
}

/** A plain SPL Token `Transfer`, outside Meridian. */
function splTransfer(from: PublicKey, to: PublicKey, owner: PublicKey, amount: bigint) {
  const data = Buffer.alloc(9)
  data.writeUInt8(3, 0)
  data.writeBigUInt64LE(amount, 1)
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  })
}

function mergePair(user: Keypair, market: TestMarket, n: number) {
  const m = market.accounts
  return meridian.methods
    .mergePair(new BN(n))
    .accountsPartial({
      user: user.publicKey,
      market: m.market,
      yesMint: m.yesMint,
      noMint: m.noMint,
      vault: m.vault,
      userUsdc: ata(user.publicKey, m.usdcMint),
      userYes: ata(user.publicKey, m.yesMint),
      userNo: ata(user.publicKey, m.noMint),
    })
    .signers([user])
    .rpc()
}

// Custom close times need demo mode, which the lifecycle suite also turns on.
before(async () => {
  const { admin } = await bootstrap()
  expect(await enableDemoMode(admin), 'demo mode turned on').to.equal(true)
})

describe('vault donation: mint, merge, trade, settle and redeem in one scenario (R6)', () => {
  const step = scenario()
  const donation = usdc(5)
  let market: TestMarket
  let donor: Keypair
  let maker: Keypair
  let taker: Keypair

  /** The internal counter tracks only real collateral; the vault holds it plus the donation. */
  async function expectCollateral(expected: bigint) {
    const state = await fetchMarket(market)
    const collateral = BigInt(state.collateral.toString())
    expect(collateral, 'collateral counter').to.equal(expected)
    expect(await tokenBalance(market.accounts.vault), 'vault balance').to.equal(expected + donation)
    if ('open' in state.status) {
      expect(collateral, 'collateral == pairs_outstanding × UNIT').to.equal(
        BigInt(state.pairsOutstanding.toString()) * UNIT,
      )
    }
  }

  before(async () => {
    await bootstrap()
    const now = await chainNow()
    market = await createMarket({
      ticker: 'AAPL',
      tradingDay: '2026-11-12',
      strike: 24_000n,
      closeTs: now + 60,
      openTs: now - 60,
    })
  })

  step('anyone transfers 5 USDC straight into the vault with the token program', async () => {
    donor = await freshWallet(market, { usdc: donation })
    const m = market.accounts
    await sendLegacy(
      [splTransfer(ata(donor.publicKey, m.usdcMint), m.vault, donor.publicKey, donation)],
      [donor],
    )
    expect((await balances(donor.publicKey, market)).usdc).to.equal(0n)
    expect(await tokenBalance(m.vault)).to.equal(donation)
    expect(BigInt((await fetchMarket(market)).collateral.toString())).to.equal(0n)
  })

  step('a maker still mints 10 pairs for exactly $10', async () => {
    maker = await freshWallet(market, { usdc: usdc(20) })
    await mintPair(maker, market, 10)
    expect(await balances(maker.publicKey, market)).to.deep.equal({
      usdc: usdc(10),
      yes: tokens(10),
      no: tokens(10),
    })
    await expectCollateral(usdc(10))
  })

  step('the maker merges 2 pairs back for exactly $2', async () => {
    await mergePair(maker, market, 2)
    expect(await balances(maker.publicKey, market)).to.deep.equal({
      usdc: usdc(12),
      yes: tokens(8),
      no: tokens(8),
    })
    await expectCollateral(usdc(8))
  })

  step('the maker sells 4 Yes at 60¢ to a taker at market', async () => {
    await sendSdkTransaction(
      buildSellYesTransaction(await tradeContext(maker.publicKey, market), {
        kind: 'Limit',
        priceCents: 60,
        qty: 4,
      }),
      maker,
    )
    taker = await freshWallet(market, { usdc: usdc(5) })
    await sendSdkTransaction(
      buildBuyYesTransaction(await tradeContext(taker.publicKey, market), {
        kind: 'Market',
        priceCents: 60,
        qty: 4,
      }),
      taker,
    )
    await settleFunds(maker, market)
    expect(await balances(taker.publicKey, market)).to.deep.equal({
      usdc: usdc(2.6),
      yes: tokens(4),
      no: 0n,
    })
    expect(await balances(maker.publicKey, market)).to.deep.equal({
      usdc: usdc(14.4),
      yes: tokens(4),
      no: tokens(8),
    })
    await expectCollateral(usdc(8))
  })

  step('settles Yes at the relay close ($245.27 ≥ $240.00)', async () => {
    await waitUntil(market.closeTs + 1)
    expect((await publishRelayClose(market)).status).to.equal('published')
    await settleMarket(market)
    const state = await fetchMarket(market)
    expect('settled' in state.status).to.equal(true)
    expect(state.outcome !== null && 'yes' in state.outcome).to.equal(true)
    await expectCollateral(usdc(8))
  })

  step('both redeem exactly what they hold; the donation stays in the vault unpaid', async () => {
    expect(await redeemAll(maker, market), 'maker payout').to.equal(usdc(4))
    await expectCollateral(usdc(4))
    expect(await redeemAll(taker, market), 'taker payout').to.equal(usdc(4))
    await expectCollateral(0n)
    // Maker: 20 − 10 minted + 2 merged + 2.40 sold + 4 redeemed. Taker: 5 − 2.40 + 4.
    expect((await balances(maker.publicKey, market)).usdc).to.equal(usdc(18.4))
    expect((await balances(taker.publicKey, market)).usdc).to.equal(usdc(6.6))
    expect(await tokenBalance(market.accounts.vault)).to.equal(donation)
  })
})

describe('maximum sweep compute on the local validator (R19)', () => {
  const step = scenario()
  let market: TestMarket

  before(async () => {
    await bootstrap()
    const now = await chainNow()
    market = await createMarket({
      ticker: 'MSFT',
      tradingDay: '2026-11-13',
      strike: 52_000n,
      closeTs: now + 1800,
      openTs: now - 60,
    })
  })

  async function rest(wallet: Keypair, side: 'ask' | 'bid', priceCents: number, qty: number) {
    const context = await tradeContext(wallet.publicKey, market)
    const order = { kind: 'Limit' as const, priceCents, qty }
    await sendSdkTransaction(
      side === 'ask'
        ? buildSellYesTransaction(context, order)
        : buildBuyYesTransaction(context, order),
      wallet,
    )
  }

  step('fills both sides: one maker per fill at its own price, then a full book', async () => {
    // 16 makers asking 2 Yes each at 40¢..55¢, so every fill touches a different seat.
    for (let i = 0; i < MAX_FILLS_PER_ORDER; i++) {
      const maker = await freshWallet(market, { usdc: usdc(2) })
      await mintPair(maker, market, 2)
      await rest(maker, 'ask', 40 + i, 2)
    }
    const filler = await freshWallet(market, { usdc: usdc(BOOK_SIDE_CAPACITY) })
    await mintPair(filler, market, BOOK_SIDE_CAPACITY - MAX_FILLS_PER_ORDER)
    for (let i = MAX_FILLS_PER_ORDER; i < BOOK_SIDE_CAPACITY; i++) await rest(filler, 'ask', 98, 1)
    const bidder = await freshWallet(market, { usdc: usdc(20) })
    for (let i = 0; i < BOOK_SIDE_CAPACITY; i++) await rest(bidder, 'bid', 1 + (i % 30), 1)
  })

  step('one market Buy Yes takes 16 fills under 1.4M compute units', async () => {
    // A market order locks qty × its limit price up front: 32 × 99¢.
    const taker = await freshWallet(market, { usdc: usdc(40) })
    const signature = await sendSdkTransaction(
      buildBuyYesTransaction(await tradeContext(taker.publicKey, market), {
        kind: 'Market',
        priceCents: 99,
        qty: 2 * MAX_FILLS_PER_ORDER,
      }),
      taker,
    )
    const tx = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    })
    const consumed = tx?.meta?.computeUnitsConsumed
    expect(consumed, 'computeUnitsConsumed in the transaction meta').to.be.a('number')
    console.log(`      max sweep on the validator: ${consumed} compute units`)
    expect(consumed).to.be.below(MAX_TX_COMPUTE_UNITS)

    // 16 fills of 2 at 40¢..55¢: 32 Yes for 2 × (40 + … + 55)¢ = $15.20.
    expect(await balances(taker.publicKey, market)).to.deep.equal({
      usdc: usdc(40) - usdc(15.2),
      yes: tokens(32),
      no: 0n,
    })
  })
})

describe('rent per market and per day, as the README states it (R19)', () => {
  const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8').replace(
    /\s+/g,
    ' ',
  )

  /** The README's figure for `unit`, and its number of decimals. */
  function stated(unit: RegExp) {
    const match = new RegExp(`(\\d+\\.\\d+) SOL (?:in rent )?${unit.source}`, 'i').exec(readme)
    expect(match, `the README states rent as "<n.nn> SOL ${unit.source}"`).to.not.equal(null)
    const text = (match as RegExpExecArray)[1] as string
    return { value: Number(text), decimals: text.split('.')[1]?.length ?? 0 }
  }

  async function lamports(address: PublicKey) {
    const info = await connection.getAccountInfo(address, 'confirmed')
    expect(info, address.toBase58()).to.not.equal(null)
    return BigInt((info as { lamports: number }).lamports)
  }

  it('matches the lamports of every account create_strike_market creates', async () => {
    await bootstrap()
    const now = await chainNow()
    const market = await createMarket({
      ticker: 'AAPL',
      tradingDay: '2026-11-11',
      strike: 25_000n,
      closeTs: now + 600,
      openTs: now - 60,
    })
    const m = market.accounts
    let perMarket = 0n
    for (const address of [
      m.market,
      m.yesMint,
      m.noMint,
      m.vault,
      m.book,
      m.yesEscrow,
      m.usdcEscrow,
    ]) {
      perMarket += await lamports(address)
    }
    const tickerDay = await lamports(market.tickerDay)
    const perDay = perMarket * BigInt(MARKETS_PER_DAY) + tickerDay * BigInt(TICKERS.length)
    const sol = (l: bigint) => Number(l) / 1e9
    console.log(
      `      rent on the validator: ${sol(perMarket)} SOL per market, ${sol(perDay)} SOL per day`,
    )

    const market$ = stated(/per market/)
    expect(market$.decimals, 'per-market figure precision').to.be.at.least(3)
    expect(market$.value).to.equal(Number(sol(perMarket).toFixed(market$.decimals)))

    const day$ = stated(/per (?:trading )?day/)
    expect(day$.decimals, 'per-day figure precision').to.be.at.least(2)
    expect(day$.value).to.equal(Number(sol(perDay).toFixed(day$.decimals)))
  })
})
