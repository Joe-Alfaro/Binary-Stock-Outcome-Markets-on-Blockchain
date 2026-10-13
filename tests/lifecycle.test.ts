/**
 * R57 lifecycle integration tests on a local validator with both programs deployed, driven by
 * the SDK's transaction builders, the relay's Anchor oracle client and the automation jobs.
 *
 * Each scenario uses its own ticker and trading day, so ticker-days never share a `close_ts`.
 * Markets close a few seconds after creation (demo-style custom times) and the tests wait for
 * the validator clock to pass the close. The validator can't warp its clock at runtime, so the
 * admin fallback runs on shortened delays here; the exact +899/+900 and +3599/+3600 boundaries
 * are covered in LiteSVM by `programs/meridian/tests/settlement_admin.rs`.
 *
 * Locally, against your own validator on the package port block. Pubsub listens on the RPC port
 * plus one, so the faucet goes elsewhere:
 *   solana-test-validator --reset --rpc-port 8931 --faucet-port 8939 --gossip-port 8933 \
 *     --dynamic-port-range 8940-8970 \
 *     --upgradeable-program <meridian id> target/deploy/meridian.so <wallet> \
 *     --upgradeable-program <oracle id> target/deploy/meridian_oracle.so <wallet>
 *   anchor test --skip-build --skip-deploy --skip-local-validator --validator legacy \
 *     --provider.cluster http://127.0.0.1:8931
 */
import { createMockSource } from '@meridian/price-providers'
import {
  buildBuyNoTransaction,
  buildBuyYesTransaction,
  buildSellNoTransaction,
  buildSellYesTransaction,
  computeStrikes,
} from '@meridian/sdk'
import type { Keypair } from '@solana/web3.js'
import { expect } from 'chai'
import type { Context } from 'mocha'
import {
  isTradingDay,
  previousTradingDay,
  tradingDayTimes,
} from '../services/automation/src/calendar/index.js'
import { createAnchorChainClient } from '../services/automation/src/chain/index.js'
import {
  runMorningJob,
  runSettlementJob,
  systemClock,
} from '../services/automation/src/jobs/index.js'
import type { Clock } from '../services/automation/src/jobs/index.js'
import { usdToChainPrice } from '../services/automation/src/jobs/price.js'
import { recordingAlerter, recordingLogger } from '../services/automation/src/jobs/test-support.js'
import {
  ADMIN_FINALIZE_DELAY_SECS,
  ADMIN_PROPOSE_DELAY_SECS,
  BN,
  UNIT,
  accountExists,
  ata,
  balances,
  bootstrap,
  chainNow,
  connection,
  createMarket,
  enableDemoMode,
  expectError,
  expectOnePriceMonotone,
  expectVault,
  fetchMarket,
  fetchTickerDay,
  freshWallet,
  meridian,
  mintPair,
  oracle,
  publishRelayClose,
  redeemAll,
  sendSdkTransaction,
  settleFunds,
  settleMarket,
  tickerBytes,
  tradeContext,
  waitUntil,
} from './support/meridian.js'
import type { Roles, TestMarket } from './support/meridian.js'

/** Recorded closes the mock relay source replays: AAPL $245.27, MSFT $521.58. */
const usdc = (dollars: number) => BigInt(Math.round(dollars * 1_000_000))
const tokens = (n: number) => BigInt(n) * UNIT

/**
 * Steps of one scenario run in order and share chain state, so once one fails the rest of that
 * scenario are skipped instead of failing for the same reason.
 */
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

function isYes(outcome: { yes?: object; no?: object } | null) {
  return outcome !== null && 'yes' in outcome
}

describe('lifecycle (R57)', () => {
  let roles: Roles

  before(async () => {
    roles = await bootstrap()
  })

  describe('full lifecycle: create, mint, trade, relay close, settle, redeem', () => {
    const step = scenario()
    const markets: TestMarket[] = []
    let demoModeAvailable = false
    let maker: Keypair
    let taker: Keypair
    let makerUsdcStart: bigint

    before(async () => {
      demoModeAvailable = await enableDemoMode(roles.admin)
      const now = await chainNow()
      const close = now + 45
      for (const strike of [24_000n, 24_527n, 25_000n]) {
        markets.push(
          await createMarket({
            ticker: 'AAPL',
            tradingDay: '2026-11-02',
            strike,
            closeTs: close,
            openTs: now - 60,
          }),
        )
      }
    })

    it('flags markets created in demo mode as demo (R44)', async () => {
      expect(demoModeAvailable, 'the program has an instruction to turn demo mode on').to.equal(
        true,
      )
      const state = await fetchMarket(markets[0] as TestMarket)
      expect(state.demo).to.equal(true)
    })

    step('creates the markets open, with the custom close a few seconds out', async () => {
      const market = markets[0] as TestMarket
      const state = await fetchMarket(market)
      expect('open' in state.status).to.equal(true)
      expect(state.closeTs.toNumber()).to.equal(market.closeTs)
      expect(state.tickerDay.equals(market.tickerDay)).to.equal(true)
      await expectVault(market, 0n)
    })

    step('a maker mints 10 pairs (R3, R6)', async () => {
      const market = markets[0] as TestMarket
      maker = await freshWallet(market, { usdc: usdc(20) })
      await mintPair(maker, market, 10)
      expect(await balances(maker.publicKey, market)).to.deep.equal({
        usdc: usdc(10),
        yes: tokens(10),
        no: tokens(10),
      })
      await expectVault(market, usdc(10))
      makerUsdcStart = usdc(20)
    })

    step('the maker quotes 4 Yes at 60¢ and a taker buys them at market', async () => {
      const market = markets[0] as TestMarket
      const ask = buildSellYesTransaction(await tradeContext(maker.publicKey, market), {
        kind: 'Limit',
        priceCents: 60,
        qty: 4,
      })
      await sendSdkTransaction(ask, maker)
      expect((await balances(maker.publicKey, market)).yes).to.equal(tokens(6))

      taker = await freshWallet(market, { usdc: usdc(5) })
      const buy = buildBuyYesTransaction(await tradeContext(taker.publicKey, market), {
        kind: 'Market',
        priceCents: 60,
        qty: 4,
      })
      await sendSdkTransaction(buy, taker)
      expect(await balances(taker.publicKey, market)).to.deep.equal({
        usdc: usdc(5) - usdc(2.4),
        yes: tokens(4),
        no: 0n,
      })

      await settleFunds(maker, market)
      expect((await balances(maker.publicKey, market)).usdc).to.equal(usdc(10) + usdc(2.4))
      // Trading moves no collateral and changes no supply (R7).
      await expectVault(market, usdc(10))
    })

    step('after close the relay publishes the canonical official close', async () => {
      const market = markets[0] as TestMarket
      await waitUntil(market.closeTs + 1)
      const outcome = await publishRelayClose(market)
      expect(outcome).to.deep.equal({ ticker: 'AAPL', status: 'published', shape: 'official' })
    })

    step('settle_market settles every strike at one price, monotone in strike (R31)', async () => {
      for (const market of markets) await settleMarket(market)
      await expectOnePriceMonotone(markets)
      const outcomes = await Promise.all(markets.map(fetchMarket))
      // $245.27 against $240.00, $245.27 (exactly at the strike pays Yes) and $250.00.
      expect(outcomes.map((state) => isYes(state.outcome))).to.deep.equal([true, true, false])
      const day = await fetchTickerDay(markets[0] as TestMarket)
      expect('oracleSlot0' in day.settleSource).to.equal(true)
    })

    step('both wallets redeem; the vault pays out exactly and ends empty (R5, R6)', async () => {
      const market = markets[0] as TestMarket
      expect(await redeemAll(maker, market)).to.equal(usdc(6))
      await expectVault(market, usdc(4))
      expect(await redeemAll(taker, market)).to.equal(usdc(4))
      await expectVault(market, 0n)
      // Maker: −10 minted, +2.40 sold, +6 redeemed. Taker: −2.40 bought, +4 redeemed.
      expect((await balances(maker.publicKey, market)).usdc).to.equal(
        makerUsdcStart - usdc(10) + usdc(2.4) + usdc(6),
      )
      expect((await balances(taker.publicKey, market)).usdc).to.equal(usdc(5) - usdc(2.4) + usdc(4))
    })
  })

  describe('the four trade paths, each by a fresh wallet with one signature (R23-R27)', () => {
    const step = scenario()
    let market: TestMarket
    let askMaker: Keypair
    let bidMaker: Keypair
    const traders: Keypair[] = []

    before(async () => {
      const now = await chainNow()
      market = await createMarket({
        ticker: 'MSFT',
        tradingDay: '2026-11-03',
        strike: 52_000n,
        closeTs: now + 60,
        openTs: now - 60,
      })
    })

    /** A fresh wallet has none of this market's token accounts and no seat. */
    async function expectFresh(wallet: Keypair, ...mints: ('yesMint' | 'noMint' | 'usdcMint')[]) {
      for (const mint of mints) {
        expect(
          await accountExists(ata(wallet.publicKey, market.accounts[mint])),
          `${mint} account before the trade`,
        ).to.equal(false)
      }
    }

    step('makers rest a Yes ask at 60¢ and a Yes bid at 40¢, 5 each', async () => {
      askMaker = await freshWallet(market, { usdc: usdc(10) })
      await mintPair(askMaker, market, 10)
      await expectVault(market, usdc(10))
      await sendSdkTransaction(
        buildSellYesTransaction(await tradeContext(askMaker.publicKey, market), {
          kind: 'Limit',
          priceCents: 60,
          qty: 5,
        }),
        askMaker,
      )
      bidMaker = await freshWallet(market, { usdc: usdc(10) })
      await sendSdkTransaction(
        buildBuyYesTransaction(await tradeContext(bidMaker.publicKey, market), {
          kind: 'Limit',
          priceCents: 40,
          qty: 5,
        }),
        bidMaker,
      )
      expect((await balances(bidMaker.publicKey, market)).usdc).to.equal(usdc(8))
    })

    step('Buy Yes at market: 2 Yes for $1.20 (R23)', async () => {
      const wallet = await freshWallet(market, { usdc: usdc(5) })
      await expectFresh(wallet, 'yesMint', 'noMint')
      await sendSdkTransaction(
        buildBuyYesTransaction(await tradeContext(wallet.publicKey, market), {
          kind: 'Market',
          priceCents: 60,
          qty: 2,
        }),
        wallet,
      )
      expect(await balances(wallet.publicKey, market)).to.deep.equal({
        usdc: usdc(3.8),
        yes: tokens(2),
        no: 0n,
      })
      await expectVault(market, usdc(10))
      traders.push(wallet)
    })

    step('Sell Yes at market: 2 Yes for $0.80 into a new USDC account (R24)', async () => {
      const wallet = await freshWallet(market, { yes: tokens(3), source: askMaker })
      await expectFresh(wallet, 'usdcMint', 'noMint')
      await sendSdkTransaction(
        buildSellYesTransaction(await tradeContext(wallet.publicKey, market), {
          kind: 'Market',
          priceCents: 40,
          qty: 2,
        }),
        wallet,
      )
      expect(await balances(wallet.publicKey, market)).to.deep.equal({
        usdc: usdc(0.8),
        yes: tokens(1),
        no: 0n,
      })
      await expectVault(market, usdc(10))
      traders.push(wallet)
    })

    step(
      'Buy No at market, partly filled: 3 No at 60¢, the 2 unfilled pairs merged back (R25)',
      async () => {
        // Only 3 of the bid's 5 remain after the Sell Yes above.
        const wallet = await freshWallet(market, { usdc: usdc(10) })
        await expectFresh(wallet, 'yesMint', 'noMint')
        await sendSdkTransaction(
          buildBuyNoTransaction(await tradeContext(wallet.publicKey, market), {
            kind: 'Market',
            noPriceCents: 60,
            qty: 5,
          }),
          wallet,
        )
        // Effective cost is exactly $1.00 − 40¢ per filled No, and no Yes+No pair is left.
        expect(await balances(wallet.publicKey, market)).to.deep.equal({
          usdc: usdc(10) - usdc(1.8),
          yes: 0n,
          no: tokens(3),
        })
        await expectVault(market, usdc(13))
        traders.push(wallet)
      },
    )

    step(
      'Sell No, partly filled: No down by exactly the 3 filled, on-chain merge, no Yes left (R26)',
      async () => {
        // Only 3 of the ask's 5 remain after the Buy Yes above.
        const wallet = await freshWallet(market, { usdc: usdc(5), no: tokens(5), source: askMaker })
        await expectFresh(wallet, 'yesMint')
        await sendSdkTransaction(
          buildSellNoTransaction(await tradeContext(wallet.publicKey, market), {
            noPriceCents: 40,
            qty: 5,
          }),
          wallet,
        )
        expect(await balances(wallet.publicKey, market)).to.deep.equal({
          usdc: usdc(5) + usdc(1.2),
          yes: 0n,
          no: tokens(2),
        })
        await expectVault(market, usdc(10))
        traders.push(wallet)
      },
    )

    step('the book is empty and makers withdraw their proceeds', async () => {
      await settleFunds(askMaker, market)
      await settleFunds(bidMaker, market)
      // Ask maker: 10 minted, 5 Yes sold at 60¢, 3 Yes and 5 No moved to the traders.
      expect(await balances(askMaker.publicKey, market)).to.deep.equal({
        usdc: usdc(3),
        yes: tokens(2),
        no: tokens(5),
      })
      // Bid maker: bought 5 Yes at 40¢.
      expect(await balances(bidMaker.publicKey, market)).to.deep.equal({
        usdc: usdc(8),
        yes: tokens(5),
        no: 0n,
      })
    })

    step('settles at the relay close and every holder redeems (R6 after each redeem)', async () => {
      await waitUntil(market.closeTs + 1)
      expect((await publishRelayClose(market)).status).to.equal('published')
      await settleMarket(market)
      const state = await fetchMarket(market)
      expect(isYes(state.outcome), '$521.58 ≥ $520.00').to.equal(true)

      let vault = usdc(10)
      for (const wallet of [askMaker, bidMaker, ...traders]) {
        const held = await balances(wallet.publicKey, market)
        const paid = await redeemAll(wallet, market)
        expect(paid).to.equal(held.yes)
        vault -= paid
        await expectVault(market, vault)
      }
      expect(vault).to.equal(0n)
    })
  })

  describe('multi-user: A mints and quotes, B takes, both redeem', () => {
    const step = scenario()
    let market: TestMarket
    let userA: Keypair
    let userB: Keypair

    before(async () => {
      const now = await chainNow()
      market = await createMarket({
        ticker: 'AAPL',
        tradingDay: '2026-11-04',
        strike: 25_000n,
        closeTs: now + 40,
        openTs: now - 60,
      })
    })

    step('A mints 10 pairs and asks 4 Yes at 30¢', async () => {
      userA = await freshWallet(market, { usdc: usdc(10) })
      await mintPair(userA, market, 10)
      await expectVault(market, usdc(10))
      await sendSdkTransaction(
        buildSellYesTransaction(await tradeContext(userA.publicKey, market), {
          kind: 'Limit',
          priceCents: 30,
          qty: 4,
        }),
        userA,
      )
    })

    step('B buys the 4 Yes at market and A withdraws $1.20', async () => {
      userB = await freshWallet(market, { usdc: usdc(2) })
      await sendSdkTransaction(
        buildBuyYesTransaction(await tradeContext(userB.publicKey, market), {
          kind: 'Market',
          priceCents: 30,
          qty: 4,
        }),
        userB,
      )
      await settleFunds(userA, market)
      expect(await balances(userA.publicKey, market)).to.deep.equal({
        usdc: usdc(1.2),
        yes: tokens(6),
        no: tokens(10),
      })
      expect(await balances(userB.publicKey, market)).to.deep.equal({
        usdc: usdc(0.8),
        yes: tokens(4),
        no: 0n,
      })
      await expectVault(market, usdc(10))
    })

    step('settles No ($245.27 < $250.00); A redeems $10, B burns losing Yes for $0', async () => {
      await waitUntil(market.closeTs + 1)
      expect((await publishRelayClose(market)).status).to.equal('published')
      await settleMarket(market)
      expect(isYes((await fetchMarket(market)).outcome)).to.equal(false)

      expect(await redeemAll(userA, market)).to.equal(usdc(10))
      await expectVault(market, 0n)
      expect(await redeemAll(userB, market)).to.equal(0n)
      await expectVault(market, 0n)
      expect((await balances(userA.publicKey, market)).usdc).to.equal(usdc(11.2))
      expect((await balances(userB.publicKey, market)).usdc).to.equal(usdc(0.8))
    })
  })

  describe('admin fallback timing end to end (R36)', () => {
    const step = scenario()
    // Shortened from 900 s and 3600 s; the validator clock can't be warped at runtime.
    const proposeDelay = 6
    const finalizeDelay = 12
    let market: TestMarket
    let holder: Keypair

    async function setDelays(propose: number, finalize: number) {
      await meridian.methods
        .updateConfig({
          automationAuthority: null,
          oracleSlots: null,
          maxStalenessSecs: null,
          maxConfBps: null,
          adminProposeDelaySecs: propose,
          adminFinalizeDelaySecs: finalize,
        })
        .accountsPartial({ admin: roles.admin.publicKey })
        .signers([roles.admin])
        .rpc()
    }

    function propose(price: number) {
      return meridian.methods
        .proposeAdminPrice(tickerBytes(market.ticker), market.tradingDayNumber, new BN(price))
        .accountsPartial({ admin: roles.admin.publicKey, tickerDay: market.tickerDay })
        .signers([roles.admin])
        .rpc()
    }

    function finalize() {
      return meridian.methods
        .finalizeAdminSettle(tickerBytes(market.ticker), market.tradingDayNumber)
        .accountsPartial({ caller: roles.automation.publicKey, tickerDay: market.tickerDay })
        .signers([roles.automation])
        .rpc()
    }

    before(async () => {
      await setDelays(proposeDelay, finalizeDelay)
      const now = await chainNow()
      market = await createMarket({
        ticker: 'MSFT',
        tradingDay: '2026-11-05',
        strike: 52_000n,
        closeTs: now + 20,
        openTs: now - 60,
      })
      holder = await freshWallet(market, { usdc: usdc(2) })
      await mintPair(holder, market, 2)
      await expectVault(market, usdc(2))
    })

    after(async () => {
      await setDelays(ADMIN_PROPOSE_DELAY_SECS, ADMIN_FINALIZE_DELAY_SECS)
    })

    step('a proposal before close + propose delay fails', async () => {
      await waitUntil(market.closeTs)
      expect(await chainNow()).to.be.below(market.closeTs + proposeDelay)
      await expectError(propose(52_500), 'AdminProposeTooEarly')
    })

    step('from close + propose delay the admin proposes a price, readable on-chain', async () => {
      await waitUntil(market.closeTs + proposeDelay)
      await propose(52_500)
      const day = await fetchTickerDay(market)
      expect(day.pendingAdminPrice.toNumber()).to.equal(52_500)
      expect(day.pendingAdminAt.toNumber()).to.be.at.least(market.closeTs + proposeDelay)
      expect('open' in day.status).to.equal(true)
    })

    step('finalizing before close + finalize delay fails', async () => {
      expect(await chainNow()).to.be.below(market.closeTs + finalizeDelay)
      await expectError(finalize(), 'AdminFinalizeTooEarly')
    })

    step(
      'from close + finalize delay anyone finalizes; every strike settles at that price',
      async () => {
        await waitUntil(market.closeTs + finalizeDelay)
        await finalize()
        const day = await fetchTickerDay(market)
        expect('final' in day.status).to.equal(true)
        expect('admin' in day.settleSource).to.equal(true)
        expect(day.settlePrice.toNumber()).to.equal(52_500)
        expect(day.settleExpo).to.equal(-2)

        // No close record exists; settle_market copies the ticker-day's admin price.
        await settleMarket(market)
        const state = await fetchMarket(market)
        expect('admin' in state.settleSource).to.equal(true)
        expect(state.settlePrice.toNumber()).to.equal(52_500)
        expect(isYes(state.outcome), '$525.00 ≥ $520.00').to.equal(true)
        expect(await redeemAll(holder, market)).to.equal(usdc(2))
        await expectVault(market, 0n)
      },
    )
  })

  describe('automation jobs against the real chain client (R15, R37 smoke)', () => {
    /** Advances virtual time instantly, so a backoff never waits on the real clock. */
    function instantClock(startMs: number): Clock {
      let now = startMs
      return {
        now: () => now,
        async sleep(ms) {
          now += Math.max(0, ms)
        },
      }
    }

    function nextTradingDayEt(): string {
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
        new Date(),
      )
      let day = new Date(`${today}T12:00:00Z`)
      do {
        day = new Date(day.getTime() + 86_400_000)
      } while (!isTradingDay(day.toISOString().slice(0, 10)))
      return day.toISOString().slice(0, 10)
    }

    async function marketsOf(ticker: string, tradingDay: string) {
      const all = await meridian.account.market.all()
      const day = Number(tradingDay.replaceAll('-', ''))
      const bytes = tickerBytes(ticker)
      return all.filter(
        ({ account }) =>
          account.tradingDay === day && account.ticker.every((b, i) => b === bytes[i]),
      )
    }

    it('the morning job creates every strike for AAPL, and a rerun creates nothing (R15)', async () => {
      const tradingDay = nextTradingDayEt()
      const times = tradingDayTimes(tradingDay)
      const source = createMockSource()
      const previous = await source.previousClose('AAPL', previousTradingDay(tradingDay))
      const expected = computeStrikes(usdToChainPrice(previous.price))
      expect(expected.length).to.be.greaterThan(0)

      const chain = createAnchorChainClient({
        connection,
        authority: roles.automation,
        idl: meridian.idl,
        // Close records live under the deployed oracle program, whose ID follows the local keypair.
        oracleProgramId: oracle.programId,
      })
      const run = async () => {
        const clock = instantClock((times.mintOpenTs - 3 * 3600) * 1000)
        return runMorningJob({
          chain,
          provider: source,
          alerter: recordingAlerter(clock),
          clock,
          log: recordingLogger(clock),
          tradingDay,
          tickers: ['AAPL'],
        })
      }

      expect(await run()).to.deep.equal({ completeTickers: ['AAPL'], incompleteTickers: [] })
      const created = await marketsOf('AAPL', tradingDay)
      const dollars = created
        .map(({ account }) => {
          const scale = 10n ** BigInt(-account.strikeExpo)
          const strike = BigInt(account.strike.toString())
          expect(strike % scale, 'strike is whole dollars').to.equal(0n)
          return strike / scale
        })
        .sort((a, b) => Number(a - b))
      expect(dollars).to.deep.equal(expected)
      created.forEach(({ account }) => {
        expect(account.closeTs.toNumber()).to.equal(times.closeTs)
        expect(account.mintOpenTs.toNumber()).to.equal(times.mintOpenTs)
        expect(account.tradingOpenTs.toNumber()).to.equal(times.tradingOpenTs)
      })

      expect(await run()).to.deep.equal({ completeTickers: ['AAPL'], incompleteTickers: [] })
      expect((await marketsOf('AAPL', tradingDay)).length).to.equal(expected.length)
    })

    it('the settlement job finds open markets on-chain and settles them from the relay close (R37)', async () => {
      const now = await chainNow()
      const markets: TestMarket[] = []
      for (const strike of [24_000n, 25_000n]) {
        markets.push(
          await createMarket({
            ticker: 'AAPL',
            tradingDay: '2026-11-06',
            strike,
            closeTs: now + 15,
            openTs: now - 60,
          }),
        )
      }
      const first = markets[0] as TestMarket
      await waitUntil(first.closeTs + 1)
      expect((await publishRelayClose(first)).status).to.equal('published')

      const chain = createAnchorChainClient({
        connection,
        authority: roles.automation,
        idl: meridian.idl,
        // Close records live under the deployed oracle program, whose ID follows the local keypair.
        oracleProgramId: oracle.programId,
      })
      const alerter = recordingAlerter(systemClock)
      const controller = new AbortController()
      const job = runSettlementJob({
        chain,
        alerter,
        clock: systemClock,
        log: recordingLogger(systemClock),
        signal: controller.signal,
      })
      const deadline = Date.now() + 120_000
      try {
        for (;;) {
          const states = await Promise.all(markets.map(fetchMarket))
          if (states.every((state) => 'settled' in state.status)) break
          if (Date.now() > deadline) expect.fail('markets not settled within 120 s of close')
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      } finally {
        controller.abort()
        await job
      }

      const states = await Promise.all(markets.map(fetchMarket))
      expect(states.map((state) => isYes(state.outcome))).to.deep.equal([true, false])
      states.forEach((state) => expect('oracleSlot0' in state.settleSource).to.equal(true))
      expect(alerter.alerts).to.deep.equal([])
    })
  })
})
