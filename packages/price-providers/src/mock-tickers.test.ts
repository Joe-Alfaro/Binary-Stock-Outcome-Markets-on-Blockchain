// R39, R47, R50, R66: in mock mode (`RELAY_1_SOURCE=mock`, `make dev`) every one of the 7 Markets
// tickers gets prices: a live latest price, a previous close for strikes, settlement inputs for a
// close and a full session of 1-minute bars for the card chart. Values are plausible for each
// stock and deterministic. Fixtures follow D67's provenance rules.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createMockSource } from './index.js'
import type { IntradayPriceProvider } from './index.js'
import { FIXTURE_CLOSE_TS, valueOf } from './test-support.js'

const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'] as const

/**
 * Each stock's real recent level: its regular-session close on 2026-10-13 (GOOGL from GOOG).
 * Mock prices must sit within `BAND` of it, so the Markets grid looks like the real market.
 */
const RECENT_CLOSE: Record<(typeof TICKERS)[number], number> = {
  AAPL: 341.27,
  MSFT: 543.45,
  GOOGL: 349.52,
  AMZN: 258.58,
  NVDA: 228.52,
  META: 762.5,
  TSLA: 375.23,
}
const BAND = 0.3
/** A regular session's high-low range stays under this fraction of its low. */
const MAX_SESSION_RANGE = 0.15

const MINUTE = 60
/** Tuesday 2026-10-13, a full trading day (EDT, UTC-4). */
const SESSION_OPEN = Date.parse('2026-10-13T09:30:00-04:00') / 1000
const SESSION_CLOSE = Date.parse('2026-10-13T16:00:00-04:00') / 1000
/** Wednesday 2026-10-14, 11:00 ET: inside the regular session. */
const MID_SESSION = Date.parse('2026-10-14T11:00:00-04:00') / 1000

function assertPlausible(ticker: (typeof TICKERS)[number], price: number, what: string) {
  const level = RECENT_CLOSE[ticker]
  assert.ok(Number.isFinite(price) && price > 0, `${ticker} ${what} ${price} is not positive`)
  assert.ok(
    price >= level * (1 - BAND) && price <= level * (1 + BAND),
    `${ticker} ${what} ${price} is not within ${BAND * 100}% of its recent level ${level}`,
  )
}

/** The mock source's intraday series, failing the test if the source has none. */
function intradayOf(source: ReturnType<typeof createMockSource>) {
  const candidate = source as Partial<IntradayPriceProvider>
  assert.equal(typeof candidate.intraday, 'function', 'the mock source serves no intraday series')
  return candidate.intraday?.bind(source) as IntradayPriceProvider['intraday']
}

describe('mock source covers all 7 tickers (R39, R47, R50, R66)', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error('the mock source must not use the network')
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  TICKERS.forEach((ticker) => {
    describe(ticker, () => {
      it('has a latest price during the regular session, stamped now (R47, R50)', async () => {
        const source = createMockSource({ now: () => MID_SESSION })

        const latest = await source.latest(ticker)

        assert.ok(latest, `${ticker} has no latest price`)
        assert.equal(latest.ticker, ticker)
        assert.equal(latest.session, 'regular')
        assert.equal(latest.publishTime, MID_SESSION)
        assert.equal(latest.officialClose, false)
        assertPlausible(ticker, valueOf(latest), 'latest price')
        assert.deepEqual(await source.latest(ticker), latest, 'latest is deterministic')
      })

      it('has a previous close for strikes, dated the requested day (R39)', async () => {
        const source = createMockSource()

        const previous = await source.previousClose(ticker, '2026-10-13')

        assert.equal(previous.ticker, ticker)
        assert.equal(previous.tradingDay, '2026-10-13')
        assertPlausible(ticker, previous.price, 'previous close')
        assert.deepEqual(await source.previousClose(ticker, '2026-10-13'), previous)
      })

      it('has settlement inputs with an official close for a close (R39)', async () => {
        const source = createMockSource()

        const inputs = await source.prepareClose(ticker, FIXTURE_CLOSE_TS)

        assert.ok(inputs, `${ticker} has no settlement inputs`)
        assert.equal(inputs.ticker, ticker)
        assert.equal(inputs.closeTs, FIXTURE_CLOSE_TS)
        assert.ok(inputs.updates.length > 0)
        inputs.updates.forEach((update) => {
          assert.equal(update.ticker, ticker)
          assertPlausible(ticker, valueOf(update), 'settlement price')
        })
        const official = inputs.updates.find((update) => update.officialClose)
        assert.ok(official, `${ticker} settlement inputs have no official close`)
        assert.ok(official.publishTime >= FIXTURE_CLOSE_TS)
        assert.deepEqual(await source.prepareClose(ticker, FIXTURE_CLOSE_TS), inputs)
      })

      it('has a 1-minute series for a full regular session (R66)', async () => {
        const intraday = intradayOf(createMockSource({ now: () => MID_SESSION }))

        const points = await intraday(ticker, SESSION_OPEN, SESSION_CLOSE)

        assert.ok(points.length >= 390, `${ticker} has ${points.length} bars, expected a session`)
        assert.equal(points[0]?.t, SESSION_OPEN, 'the series starts at the 9:30 open')
        assert.ok((points.at(-1)?.t ?? 0) >= SESSION_CLOSE - MINUTE, 'the series runs to close')
        points.forEach((point, i) => {
          assert.ok(point.t >= SESSION_OPEN && point.t <= SESSION_CLOSE)
          assert.equal(point.t % MINUTE, 0, 'bars start on the minute')
          if (i > 0) assert.equal(point.t - (points[i - 1]?.t ?? 0), MINUTE, 'one bar a minute')
          assertPlausible(ticker, point.price, `bar at ${point.t}`)
        })
        const prices = points.map((point) => point.price)
        const low = Math.min(...prices)
        const high = Math.max(...prices)
        assert.ok(
          (high - low) / low < MAX_SESSION_RANGE,
          `${ticker} session range ${low}-${high} is implausibly wide`,
        )
        assert.deepEqual(await intraday(ticker, SESSION_OPEN, SESSION_CLOSE), points)
      })
    })
  })

  it('gives each ticker its own price level', async () => {
    const source = createMockSource({ now: () => MID_SESSION })
    const levels = await Promise.all(
      TICKERS.map(async (ticker) => valueOf((await source.latest(ticker)) ?? assert.fail(ticker))),
    )
    assert.equal(new Set(levels).size, TICKERS.length, 'two tickers share a price')
  })
})

interface ProvenanceEntry {
  origin?: string
  recordFrom?: string
  note?: string
}

const FIXTURES = new URL('../fixtures/', import.meta.url)
const yahooFiles = readdirSync(new URL('yahoo/', FIXTURES))
const provenance = JSON.parse(readFileSync(new URL('provenance.json', FIXTURES), 'utf8')) as Record<
  string,
  ProvenanceEntry
>

/** The `<TICKER>-<YYYY-MM-DD>-<interval>.json` recordings the mock source replays. */
function mockRecordings(ticker: string) {
  return yahooFiles.filter((file) =>
    new RegExp(`^${ticker}-\\d{4}-\\d{2}-\\d{2}-1[md]\\.json$`).test(file),
  )
}

describe('mock fixtures for all 7 tickers follow D67 provenance (R39)', () => {
  TICKERS.forEach((ticker) => {
    it(`${ticker} has 1m and 1d recordings, each hand-written with a re-record request or recorded`, () => {
      const files = mockRecordings(ticker)
      assert.ok(
        files.some((file) => file.endsWith('-1m.json')),
        `${ticker} has no 1m recording`,
      )
      assert.ok(
        files.some((file) => file.endsWith('-1d.json')),
        `${ticker} has no 1d recording`,
      )
      files.forEach((file) => {
        const entry = provenance[`yahoo/${file}`]
        assert.ok(entry, `yahoo/${file} has no provenance entry`)
        if (entry.origin === 'recorded') return
        assert.equal(entry.origin, 'hand-written', `yahoo/${file} origin`)
        const interval = file.endsWith('-1m.json') ? '1m' : '1d'
        assert.match(
          entry.recordFrom ?? '',
          new RegExp(
            `^https://query[12]\\.finance\\.yahoo\\.com/v8/finance/chart/${ticker}\\?.*interval=${interval}\\b`,
          ),
          `yahoo/${file} recordFrom must request ${ticker} at ${interval}`,
        )
        assert.match(entry.note ?? '', /by hand|hand-written/i, `yahoo/${file} note`)
      })
    })
  })

  it('the fixtures README names every ticker the mock source covers and npm run record-fixtures', () => {
    const readme = readFileSync(new URL('README.md', FIXTURES), 'utf8')
    assert.match(readme, /npm run record-fixtures/)
    TICKERS.forEach((ticker) => assert.match(readme, new RegExp(`\\b${ticker}\\b`), ticker))
  })
})
