/**
 * The deployed worker end to end on a local validator with both programs (R40, R46, R47): the
 * real `startWorker`, configured only through its environment, against the real programs. Nothing
 * here publishes a close or a price itself, and nothing uses the admin fallback.
 *
 * Runs with the other Anchor integration tests (`anchor test`). Locally, against your own
 * validator (see the header of `lifecycle.test.ts`):
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:<rpc port> ANCHOR_WALLET=~/.config/solana/id.json \
 *     npx mocha --node-option import=tsx --timeout 1000000 tests/worker.test.ts
 */
import { PublicKey } from '@solana/web3.js'
import type { Keypair } from '@solana/web3.js'
import { expect } from 'chai'
import { createAlerter } from '../services/automation/src/alerts/index.js'
import type { Alert, AlertSink } from '../services/automation/src/alerts/index.js'
import { isTradingDay, tradingDayTimes } from '../services/automation/src/calendar/index.js'
import { createAnchorChainClient } from '../services/automation/src/chain/index.js'
import { createHealthState } from '../services/automation/src/health.js'
import { auditInvariants } from '../services/automation/src/invariants.js'
import { systemClock } from '../services/automation/src/jobs/index.js'
import type { Clock } from '../services/automation/src/jobs/index.js'
import { recordingLogger } from '../services/automation/src/jobs/test-support.js'
import { isRegularSessionOpen } from '../services/automation/src/relay/session.js'
import { startWorker } from '../services/automation/src/worker.js'
import type { Worker } from '../services/automation/src/worker.js'
import {
  UNIT,
  accountExists,
  bootstrap,
  chainNow,
  closeRecordPda,
  connection,
  createMarket,
  enableDemoMode,
  fetchMarket,
  fetchTickerDay,
  freshWallet,
  meridian,
  mintPair,
  oracle,
  tickerBytes,
  waitUntil,
} from './support/meridian.js'
import type { Roles, TestMarket } from './support/meridian.js'

/** The tickers the offline mock relay source has recordings of. */
const MOCK_TICKERS = ['AAPL', 'MSFT'] as const
const SECOND_MS = 1_000

const secretJson = (keypair: Keypair) => JSON.stringify([...keypair.secretKey])
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function latestPricePda(signer: PublicKey, ticker: string) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('latest'), signer.toBuffer(), Buffer.from(tickerBytes(ticker))],
    oracle.programId,
  )[0]
}

function recordingSink(): AlertSink & { sent: Alert[] } {
  const sent: Alert[] = []
  return {
    name: 'recording',
    sent,
    async send(alert) {
      sent.push(alert)
    },
  }
}

/** Polls `check` every second until it returns a value, failing after `timeoutMs`. */
async function eventually<T>(
  what: string,
  timeoutMs: number,
  check: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value !== null) return value
    if (Date.now() > deadline) expect.fail(`${what} within ${timeoutMs / SECOND_MS} s`)
    await sleep(SECOND_MS)
  }
}

/**
 * The wall clock, moved back into a regular session when the test runs outside one, so the
 * live-price loop runs whatever the time of day. Moving back keeps every publish time in the past,
 * which the program accepts.
 */
function inSessionClock(): Clock {
  const nowSecs = Math.floor(Date.now() / 1000)
  if (isRegularSessionOpen(nowSecs)) return systemClock
  const today = new Date()
  const day = Array.from({ length: 10 }, (_, back) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
      new Date(today.getTime() - back * 86_400_000),
    ),
  ).find((candidate) => isTradingDay(candidate) && tradingDayTimes(candidate).closeTs < nowSecs)
  if (day === undefined) throw new Error('no trading day in the last 10 days')
  const offsetMs = (tradingDayTimes(day).tradingOpenTs + 3600) * 1000 - Date.now()
  return {
    now: () => Date.now() + offsetMs,
    sleep: (ms, signal) => systemClock.sleep(ms, signal),
  }
}

/** Every JSON line the worker wrote. */
function parsedLines(lines: string[]): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>]
    } catch {
      return []
    }
  })
}

describe('worker end to end (R40, R46, R47)', () => {
  let roles: Roles
  let env: NodeJS.ProcessEnv
  let worker: Worker | undefined

  before(async () => {
    roles = await bootstrap()
    // Markets here close seconds after creation, which needs demo mode (R44).
    expect(await enableDemoMode(roles.admin), 'demo mode is available').to.equal(true)
    env = {
      SOLANA_RPC_URL: connection.rpcEndpoint,
      AUTOMATION_KEYPAIR: secretJson(roles.automation),
      RELAY_SIGNER_1_KEYPAIR: secretJson(roles.relay),
      RELAY_1_SOURCE: 'mock',
      MERIDIAN_PROGRAM_ID: meridian.programId.toBase58(),
      MERIDIAN_ORACLE_PROGRAM_ID: oracle.programId.toBase58(),
    }
  })

  afterEach(async () => {
    worker?.stop()
    await worker?.done
    worker = undefined
  })

  // Runs first: its clock may be moved back, and latest-price publish times must only increase.
  it('updates each ticker latest-price account at least every 60 s in the session (R47)', async () => {
    const health = createHealthState()
    worker = startWorker(health, env, {
      clock: inSessionClock(),
      log: () => {},
      alertSinks: [recordingSink()],
    })

    const first = await eventually(
      'a latest-price account for every mock ticker',
      45_000,
      async () => {
        const accounts = await Promise.all(
          MOCK_TICKERS.map((ticker) =>
            oracle.account.latestPrice.fetchNullable(latestPricePda(roles.relay.publicKey, ticker)),
          ),
        )
        return accounts.every((account) => account !== null) ? accounts : null
      },
    )
    first.forEach((account, index) => {
      expect(account?.signer.equals(roles.relay.publicKey)).to.equal(true)
      expect(account?.ticker).to.deep.equal(tickerBytes(MOCK_TICKERS[index] as string))
      expect(account?.price.toNumber()).to.be.greaterThan(0)
      expect(account?.officialClose).to.equal(false)
    })
    expect(health.snapshot().lastRelayPublishAt, 'the relay publish is in /healthz').to.not.equal(
      null,
    )

    // Overwritten in place with a newer price within 60 s (plus a transaction's slack).
    await eventually('a newer latest price for every mock ticker', 70_000, async () => {
      const accounts = await Promise.all(
        MOCK_TICKERS.map((ticker) =>
          oracle.account.latestPrice.fetchNullable(latestPricePda(roles.relay.publicKey, ticker)),
        ),
      )
      const newer = accounts.every(
        (account, index) =>
          account !== null &&
          account.publishTime.toNumber() > (first[index]?.publishTime.toNumber() ?? Infinity),
      )
      return newer ? true : null
    })
  })

  describe('after close', () => {
    const markets: TestMarket[] = []
    const lines: string[] = []
    const sink = recordingSink()
    const health = createHealthState()

    before(async () => {
      const now = await chainNow()
      for (const strike of [24_000n, 25_000n]) {
        markets.push(
          await createMarket({
            ticker: 'AAPL',
            tradingDay: '2026-11-09',
            strike,
            closeTs: now + 20,
            openTs: now - 60,
          }),
        )
      }
    })

    it('publishes the close record after close_ts and the markets settle from it, without the admin fallback (R40)', async () => {
      const first = markets[0] as TestMarket
      worker = startWorker(health, env, {
        log: (line) => lines.push(line),
        alertSinks: [sink],
      })

      // Nothing is published before close.
      expect(
        await accountExists(closeRecordPda(roles.relay.publicKey, first.ticker, first.tradingDay)),
      ).to.equal(false)
      await waitUntil(first.closeTs)

      await eventually('the relay close record', 90_000, async () =>
        (await accountExists(closeRecordPda(roles.relay.publicKey, first.ticker, first.tradingDay)))
          ? true
          : null,
      )
      await eventually('every market settled', 120_000, async () => {
        const states = await Promise.all(markets.map(fetchMarket))
        return states.every((state) => 'settled' in state.status) ? states : null
      })

      const states = await Promise.all(markets.map(fetchMarket))
      // The recorded AAPL close is $245.27: Yes at $240.00, No at $250.00.
      expect(states.map((state) => state.outcome !== null && 'yes' in state.outcome)).to.deep.equal(
        [true, false],
      )
      states.forEach((state) => expect('oracleSlot0' in state.settleSource).to.equal(true))
      const day = await fetchTickerDay(first)
      expect('oracleSlot0' in day.settleSource, 'settled from the relay, not the admin').to.equal(
        true,
      )

      // R40: every published value is logged, here through the worker's log.
      const entries = parsedLines(lines)
      const published = entries.find(
        (entry) =>
          entry.event === 'close-published' &&
          entry.ticker === 'AAPL' &&
          entry.closeTs === first.closeTs &&
          entry.signer === roles.relay.publicKey.toBase58(),
      )
      expect(published, 'close-published log line').to.not.equal(undefined)
      expect(
        entries.some(
          (entry) =>
            entry.event === 'price-published' &&
            entry.ticker === 'AAPL' &&
            entry.price === '2452700000000',
        ),
        'the published close value is logged',
      ).to.equal(true)
      expect(health.snapshot().lastRelayPublishAt).to.not.equal(null)
      expect(sink.sent.map((alert) => alert.kind)).to.not.include.members([
        'settlement_first_alert',
        'settlement_second_alert',
      ])
    })

    it('audits collateral and supply on-chain while it runs, alerting nothing on a healthy chain (R46)', async () => {
      // The worker from the previous test has been stopped; it ran for over a minute.
      const audits = parsedLines(lines).filter((entry) => entry.message === 'invariant audit')
      expect(audits.length, 'an "invariant audit" log line').to.be.greaterThan(0)
      const last = audits.at(-1) as Record<string, unknown>
      expect(last.markets).to.be.a('number').and.greaterThan(0)
      expect(last.violations).to.equal(0)
      expect(sink.sent.filter((alert) => alert.kind === 'invariant_failure')).to.deep.equal([])
    })
  })

  describe('collateral reads behind the invariant audit (R46)', () => {
    let market: TestMarket

    before(async () => {
      const now = await chainNow()
      market = await createMarket({
        ticker: 'MSFT',
        tradingDay: '2026-11-10',
        strike: 52_000n,
        closeTs: now + 3600,
        openTs: now - 60,
      })
      const holder = await freshWallet(market, { usdc: 5n * UNIT })
      await mintPair(holder, market, 3)
    })

    it('reads each market counters, vault balance and both supplies from the chain', async () => {
      const chain = createAnchorChainClient({
        connection,
        authority: roles.automation,
        idl: meridian.idl,
        oracleProgramId: oracle.programId,
      })
      const snapshots = await chain.listMarketCollateral()
      const snapshot = snapshots.find(
        (entry) => entry.address === market.accounts.market.toBase58(),
      )
      expect(snapshot).to.deep.equal({
        address: market.accounts.market.toBase58(),
        ticker: 'MSFT',
        tradingDay: '2026-11-10',
        status: 'open',
        outcome: null,
        collateral: 3n * UNIT,
        pairsOutstanding: 3n,
        vaultBalance: 3n * UNIT,
        yesSupply: 3n * UNIT,
        noSupply: 3n * UNIT,
      })

      const sink = recordingSink()
      const violations = await auditInvariants({
        chain,
        alerter: createAlerter({ sinks: [sink] }),
        log: recordingLogger(systemClock),
      })
      expect(violations).to.deep.equal([])
      expect(sink.sent).to.deep.equal([])
    })
  })
})
