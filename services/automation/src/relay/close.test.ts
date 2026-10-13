import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMockSource, relayConfidence } from '@meridian/price-providers'
import { createRelayPublisher, tradingDayNumber } from './index.js'
import {
  RELAY_SIGNER,
  captureLog,
  createFakeClock,
  createFakeOracle,
  createScriptedSource,
  edt,
  findValueLog,
  price,
} from './test-support.js'
import type { CloseScript, FakeCloseSource } from './test-support.js'
import type { Clock } from './types.js'
import type { PriceProvider } from '@meridian/price-providers'

const DAY = '2026-10-12'
const DAY_NUMBER = 20_261_012
const CLOSE = edt(DAY, '16:00:00')
const TICKERS = ['AAPL', 'MSFT', 'NVDA']

function setupWith(start: number, source: (clock: Clock) => PriceProvider, tickers = TICKERS) {
  const clock = createFakeClock(start)
  const oracle = createFakeOracle(clock)
  const log = captureLog()
  const publisher = createRelayPublisher({
    oracle,
    source: source(clock),
    tickers,
    clock,
    log: log.write,
  })
  return { clock, oracle, log, publisher }
}

function setup(start: number, script: CloseScript) {
  let source: FakeCloseSource | undefined
  const rest = setupWith(start, (clock) => {
    source = createScriptedSource(clock, script)
    return source
  })
  assert.ok(source)
  return { ...rest, source }
}

const official: CloseScript = (ticker, closeTs) => [
  price(ticker, 245.27, closeTs, { officialClose: true }),
]
const pairOnly: CloseScript = (ticker, closeTs) => [
  price(ticker, 245.1, closeTs - 1),
  price(ticker, 245.3, closeTs + 1),
]

describe('tradingDayNumber', () => {
  it('encodes YYYY-MM-DD as the YYYYMMDD close record seed', () => {
    assert.equal(tradingDayNumber('2026-10-12'), 20_261_012)
    assert.equal(tradingDayNumber('2027-01-04'), 20_270_104)
  })
})

describe('R40 close publishing: timing', () => {
  it('does nothing before close_ts and does not ask the source', async () => {
    const { oracle, source, publisher } = setup(CLOSE - 1, official)
    const outcome = await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.equal(outcome.status, 'too-early')
    assert.equal(oracle.calls.length, 0)
    assert.equal(createdAsks(source), 0)
  })
})

describe('R40 close publishing: shapes', () => {
  it('publishes the official close as one PriceUpdate, then the CloseRecord', async () => {
    const { oracle, publisher } = setup(CLOSE + 30, official)
    const outcome = await publisher.publishClose('AAPL', DAY, CLOSE)

    assert.deepEqual(outcome, { ticker: 'AAPL', status: 'published', shape: 'official' })
    assert.deepEqual(
      oracle.calls.map((call) => call.method),
      ['publishPrice', 'publishClose'],
    )
    const [update] = oracle.calls[0]?.updates ?? []
    assert.equal(update?.officialClose, true)
    assert.equal(update?.publishTime, CLOSE)
    assert.equal(update?.price, 2_452_700_000_000n)
    assert.deepEqual(oracle.calls[1]?.close, {
      ticker: 'AAPL',
      tradingDay: DAY_NUMBER,
      closeTs: CLOSE,
      updates: [update],
    })
  })

  it('publishes the official close from the recorded mock RelaySource', async () => {
    const { oracle, publisher } = setupWith(CLOSE + 60, () => createMockSource(), ['AAPL', 'MSFT'])
    const outcomes = await Promise.all([
      publisher.publishClose('AAPL', DAY, CLOSE),
      publisher.publishClose('MSFT', DAY, CLOSE),
    ])
    assert.deepEqual(
      outcomes.map((outcome) => [outcome.ticker, outcome.status, outcome.shape]),
      [
        ['AAPL', 'published', 'official'],
        ['MSFT', 'published', 'official'],
      ],
    )
    const closes = oracle.calls.filter((call) => call.method === 'publishClose')
    const byTicker = Object.fromEntries(
      closes.map((call) => [call.close?.ticker, call.close?.updates[0]?.price]),
    )
    assert.deepEqual(byTicker, { AAPL: 2_452_700_000_000n, MSFT: 5_215_800_000_000n })
    closes.forEach((call) => assert.equal(call.close?.updates[0]?.publishTime, CLOSE))
  })

  it('waits up to close_ts + 180 s for an official close before using the interpolation pair', async () => {
    const { clock, oracle, publisher } = setup(CLOSE + 179, pairOnly)
    const early = await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.equal(early.status, 'pending')
    assert.equal(oracle.calls.length, 0)

    await clock.sleep(1)
    const outcome = await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.deepEqual(outcome, { ticker: 'AAPL', status: 'published', shape: 'interpolation' })
    assert.deepEqual(
      oracle.calls.map((call) => call.method),
      ['publishPrice', 'publishPrice', 'publishClose'],
    )
    const close = oracle.calls[2]?.close
    assert.deepEqual(
      close?.updates.map((update) => update.publishTime),
      [CLOSE - 1, CLOSE + 1],
    )
    assert.equal(close?.tradingDay, DAY_NUMBER)
  })

  it('publishes an official close as soon as the source has one, without waiting', async () => {
    const { oracle, publisher } = setup(CLOSE + 5, official)
    const outcome = await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.equal(outcome.status, 'published')
    assert.equal(outcome.shape, 'official')
    assert.equal(oracle.calls.at(-1)?.method, 'publishClose')
  })

  it('reports pending when the source has no shape yet', async () => {
    const { oracle, publisher } = setup(CLOSE + 600, () => null)
    const outcome = await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.equal(outcome.status, 'pending')
    assert.equal(oracle.calls.length, 0)
  })

  it('reports an error without throwing when the source fails', async () => {
    const { oracle, publisher } = setup(CLOSE + 30, () => {
      throw new Error('HTTP 429')
    })
    const outcome = await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.equal(outcome.status, 'error')
    assert.equal(oracle.calls.length, 0)
  })
})

describe('R40 confidence', () => {
  it('publishes half the bid-ask spread for the official close', async () => {
    // Bid 245.26, ask 245.28: half the spread is $0.01, or 10^8 at expo -10.
    const halfSpread = relayConfidence({ bid: 245.26, ask: 245.28, barHigh: 245.5, barLow: 245 })
    assert.ok(halfSpread !== null && Math.abs(halfSpread - 0.01) < 1e-9)
    const { oracle, publisher } = setup(CLOSE + 30, (ticker, closeTs) => [
      price(ticker, 245.27, closeTs, { officialClose: true, conf: 100_000_000n }),
    ])
    await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.equal(oracle.calls[0]?.updates[0]?.conf, 100_000_000n)
    assert.equal(oracle.calls[1]?.close?.updates[0]?.conf, 100_000_000n)
  })

  it('publishes half the 1-minute bar high-low range for the interpolation pair', async () => {
    // Bars 245.00-245.20 and 245.20-245.60: half ranges $0.10 and $0.20.
    assert.equal(relayConfidence({ barHigh: 245.2, barLow: 245 })?.toFixed(2), '0.10')
    assert.equal(relayConfidence({ barHigh: 245.6, barLow: 245.2 })?.toFixed(2), '0.20')
    const { oracle, publisher } = setup(CLOSE + 180, (ticker, closeTs) => [
      price(ticker, 245.1, closeTs - 1, { conf: 1_000_000_000n }),
      price(ticker, 245.3, closeTs + 1, { conf: 2_000_000_000n }),
    ])
    await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.deepEqual(
      oracle.calls
        .filter((call) => call.method === 'publishPrice')
        .map((call) => call.updates[0]?.conf),
      [1_000_000_000n, 2_000_000_000n],
    )
    assert.deepEqual(
      oracle.calls.at(-1)?.close?.updates.map((update) => update.conf),
      [1_000_000_000n, 2_000_000_000n],
    )
  })
})

describe('R40 one canonical close record per (signer, ticker, trading day)', () => {
  it('skips a ticker whose close record already exists, without asking the source', async () => {
    const { oracle, source, publisher } = setup(CLOSE + 30, official)
    oracle.closes.add(`AAPL:${DAY_NUMBER}`)
    const outcome = await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.equal(outcome.status, 'already-published')
    assert.equal(oracle.calls.length, 0)
    assert.equal(createdAsks(source), 0)
  })

  it('is idempotent across repeated calls', async () => {
    const { oracle, publisher } = setup(CLOSE + 30, official)
    const first = await publisher.publishClose('AAPL', DAY, CLOSE)
    const second = await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.equal(first.status, 'published')
    assert.equal(second.status, 'already-published')
    assert.equal(oracle.calls.filter((call) => call.method === 'publishClose').length, 1)
    assert.equal(oracle.calls.filter((call) => call.method === 'publishPrice').length, 1)
  })

  it('finishes a half-done close without republishing an existing PriceUpdate', async () => {
    const { oracle, publisher } = setup(CLOSE + 30, official)
    // A crash after publish_price and before publish_close leaves the update on-chain.
    oracle.prices.add(`AAPL:${CLOSE}`)
    const outcome = await publisher.publishClose('AAPL', DAY, CLOSE)
    assert.equal(outcome.status, 'published')
    assert.deepEqual(
      oracle.calls.map((call) => call.method),
      ['publishClose'],
    )
  })

  it('publishes a separate record for each trading day', async () => {
    const nextClose = edt('2026-10-13', '16:00:00')
    const { clock, oracle, publisher } = setup(CLOSE + 30, official)
    await publisher.publishClose('AAPL', DAY, CLOSE)
    await clock.sleep(nextClose + 30 - clock.now())
    const outcome = await publisher.publishClose('AAPL', '2026-10-13', nextClose)
    assert.equal(outcome.status, 'published')
    assert.deepEqual(
      oracle.calls
        .filter((call) => call.method === 'publishClose')
        .map((call) => call.close?.tradingDay),
      [DAY_NUMBER, 20_261_013],
    )
  })
})

describe('R40 logging', () => {
  it('logs every published value with its source, signer and transaction signature', async () => {
    const { oracle, log, publisher } = setup(CLOSE + 180, (ticker, closeTs) =>
      ticker === 'AAPL'
        ? [price(ticker, 245.27, closeTs, { officialClose: true, conf: 100_000_000n })]
        : pairOnly(ticker, closeTs, CLOSE + 180),
    )
    await publisher.publishClose('AAPL', DAY, CLOSE)
    await publisher.publishClose('MSFT', DAY, CLOSE)

    const entries = log.entries()
    const priceCalls = oracle.calls.filter((call) => call.method === 'publishPrice')
    assert.equal(priceCalls.length, 3)
    priceCalls.forEach((call) => {
      const update = call.updates[0]
      assert.ok(update)
      const entry = findValueLog(entries, update, call.signature)
      assert.ok(entry, `no log line for ${update.ticker} at ${update.publishTime}`)
      assert.equal(entry.source, 'scripted')
      assert.equal(entry.signer, RELAY_SIGNER)
      assert.equal(entry.officialClose, update.officialClose)
      assert.notEqual(entry.replayed, true)
    })
    oracle.calls
      .filter((call) => call.method === 'publishClose')
      .forEach((call) => {
        const entry = entries.find(
          (line) => line.signature === call.signature && line.ticker === call.close?.ticker,
        )
        assert.ok(entry, `no log line for the ${call.close?.ticker} close record`)
        assert.equal(entry.tradingDay, DAY_NUMBER)
        assert.equal(entry.closeTs, CLOSE)
        assert.equal(entry.signer, RELAY_SIGNER)
      })
  })
})

describe('R40 close sequence after close_ts', () => {
  it('polls every 30 s from close_ts until each ticker is published; one failure delays no other', async () => {
    const msftReady = CLOSE + 90
    const { clock, oracle, source, publisher } = setup(CLOSE - 120, (ticker, closeTs, now) => {
      if (ticker === 'NVDA') throw new Error('HTTP 429')
      if (ticker === 'MSFT' && now < msftReady) return null
      return official(ticker, closeTs, now)
    })
    const deadline = CLOSE + 600
    const outcomes = await publisher.runCloses(DAY, CLOSE, deadline)

    const status = Object.fromEntries(outcomes.map((outcome) => [outcome.ticker, outcome.status]))
    assert.equal(status.AAPL, 'published')
    assert.equal(status.MSFT, 'published')
    assert.notEqual(status.NVDA, 'published')

    const closedAt = Object.fromEntries(
      oracle.calls
        .filter((call) => call.method === 'publishClose')
        .map((call) => [call.close?.ticker, call.at]),
    )
    assert.ok(closedAt.AAPL !== undefined && closedAt.AAPL >= CLOSE && closedAt.AAPL < CLOSE + 30)
    assert.ok(closedAt.MSFT !== undefined && closedAt.MSFT >= msftReady)
    assert.ok(closedAt.MSFT <= msftReady + 30, `MSFT closed at +${closedAt.MSFT - CLOSE}`)

    const nvdaAsks = source.asked.get('NVDA') ?? []
    assert.ok(
      nvdaAsks.every((at) => at >= CLOSE),
      'asked the source before close_ts',
    )
    assert.ok(nvdaAsks.length >= 19 && nvdaAsks.length <= 21, `${nvdaAsks.length} polls in 10 min`)
    nvdaAsks.slice(1).forEach((at, index) => {
      const gap = at - (nvdaAsks[index] ?? 0)
      assert.ok(gap >= 25 && gap <= 35, `poll gap ${gap} s`)
    })
    assert.ok(clock.now() <= deadline + 30)
  })

  it('returns as soon as every ticker is published', async () => {
    const { clock, publisher } = setup(CLOSE, official)
    const outcomes = await publisher.runCloses(DAY, CLOSE, CLOSE + 3600)
    assert.deepEqual(
      outcomes.map((outcome) => outcome.status),
      ['published', 'published', 'published'],
    )
    assert.ok(clock.now() < CLOSE + 30)
  })

  it('publishes exactly one record per ticker even when run twice', async () => {
    const { oracle, publisher } = setup(CLOSE, official)
    await publisher.runCloses(DAY, CLOSE, CLOSE + 600)
    const again = await publisher.runCloses(DAY, CLOSE, CLOSE + 600)
    assert.deepEqual(
      again.map((outcome) => outcome.status),
      ['already-published', 'already-published', 'already-published'],
    )
    const closes = oracle.calls.filter((call) => call.method === 'publishClose')
    assert.deepEqual(closes.map((call) => call.close?.ticker).sort(), [...TICKERS].sort())
  })
})

function createdAsks(source: FakeCloseSource): number {
  return [...source.asked.values()].reduce((sum, times) => sum + times.length, 0)
}
