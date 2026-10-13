// R44: the demo relay replays a recorded real close from a past trading day. The AAPL close of
// 2026-10-12 was read from one live chart API response on that evening; its values were
// transcribed into `fixtures/yahoo/AAPL-2026-10-12-close.json`, so the provenance entry is
// `recorded-transcribed` (the response bytes were not kept, so there is no byte checksum).
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createDemoReplaySource, createRelaySource } from './index.js'
import { valueOf } from './test-support.js'

const FIXTURES = new URL('../fixtures/', import.meta.url)
const DEMO_FIXTURE = 'yahoo/AAPL-2026-10-12-close.json'

/** 2026-10-12 16:00:00 ET. */
const CLOSE_TS = 1_791_835_200
/** 2026-10-13 00:20 UTC is 19:20 CDT on 2026-10-12, when the response was read. */
const CAPTURE_WINDOW = [Date.parse('2026-10-13T00:00:00Z'), Date.parse('2026-10-13T01:00:00Z')]
/** A demo market closing at 2:07 PM ET the next day, not at a real close. */
const DEMO_CLOSE = CLOSE_TS + 24 * 60 * 60 - 113 * 60

interface ChartFixture {
  chart: {
    result: {
      meta: Record<string, unknown>
      timestamp?: number[]
      indicators: { quote: Record<string, (number | null)[]>[] }
    }[]
    error: unknown
  }
}

function demoFixture(): ChartFixture {
  const url = new URL(DEMO_FIXTURE, FIXTURES)
  assert.ok(existsSync(url), `${DEMO_FIXTURE} is missing`)
  return JSON.parse(readFileSync(url, 'utf8')) as ChartFixture
}

function demoResult() {
  const result = demoFixture().chart.result[0]
  assert.ok(result, `${DEMO_FIXTURE} has no chart result`)
  return result
}

describe('the recorded AAPL close of 2026-10-12 (R44)', () => {
  it('is a chart API response for AAPL with the transcribed close, time and previous close', () => {
    const { meta } = demoResult()
    assert.equal(meta.symbol, 'AAPL')
    assert.equal(meta.regularMarketPrice, 340.97)
    // 16:00:01 ET, after the close, so it is the official close.
    assert.equal(meta.regularMarketTime, 1_791_835_201)
    assert.equal(meta.chartPreviousClose, 336.64)
    assert.equal(meta.previousClose, 336.64)
    assert.equal(meta.exchangeTimezoneName, 'America/New_York')
    const period = meta.currentTradingPeriod as {
      regular?: { start?: number; end?: number; gmtoffset?: number }
    }
    assert.equal(period?.regular?.start, 1_791_811_800)
    assert.equal(period?.regular?.end, CLOSE_TS)
    assert.equal(period?.regular?.gmtoffset, -14_400)
  })

  it('holds exactly the last three transcribed one-minute bars', () => {
    const result = demoResult()
    assert.deepEqual(result.timestamp, [1_791_835_080, 1_791_835_140, 1_791_835_200])
    const quote = result.indicators.quote[0]
    assert.ok(quote, `${DEMO_FIXTURE} has no quote series`)
    assert.deepEqual(quote.close, [341.010009765625, 341.05999755859375, 340.9700012207031])
  })

  it('invents no bar values that were not transcribed', () => {
    const quote = demoResult().indicators.quote[0] ?? {}
    Object.entries(quote)
      .filter(([field]) => field !== 'close')
      .forEach(([field, series]) =>
        assert.ok(
          series.every((value) => value === null),
          `${field} was not transcribed, so it must be absent or null`,
        ),
      )
  })

  it('has a recorded-transcribed provenance entry with its capture time, request and note', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('provenance.json', FIXTURES), 'utf8'),
    ) as Record<
      string,
      { origin?: string; url?: string; capturedAt?: string; note?: string; recordFrom?: string }
    >
    const entry = manifest[DEMO_FIXTURE]
    assert.ok(entry, `${DEMO_FIXTURE} has no provenance entry`)
    assert.equal(entry.origin, 'recorded-transcribed')
    assert.match(
      entry.url ?? '',
      /^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\/AAPL\?interval=1m&range=1d$/,
    )
    const captured = Date.parse(entry.capturedAt ?? '')
    assert.ok(
      captured >= (CAPTURE_WINDOW[0] ?? 0) && captured <= (CAPTURE_WINDOW[1] ?? 0),
      `capturedAt ${String(entry.capturedAt)} is not the evening of 2026-10-12`,
    )
    assert.match(entry.note ?? '', /transcribed/i)
    assert.match(entry.note ?? '', /\bno\b[^.]*\bchecksum\b/i)
    assert.equal(entry.recordFrom, undefined, 'a recorded close is not hand-written')
  })
})

describe('the demo replay source (R44)', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error('the demo replay source must not use the network')
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('replays the recorded official close of 2026-10-12, re-stamped to the demo close_ts', async () => {
    const replayed = await createDemoReplaySource().prepareClose('AAPL', DEMO_CLOSE)
    assert.ok(replayed, 'no replayed close')
    assert.equal(replayed.closeTs, DEMO_CLOSE)
    const official = replayed.updates.find((update) => update.officialClose)
    assert.ok(official, 'the replay has no official close')
    assert.equal(official.price, 3_409_700_000_000n)
    assert.equal(valueOf(official), 340.97)
    // Recorded at close_ts + 1 s, so replayed at the demo close_ts + 1 s.
    assert.equal(official.publishTime, DEMO_CLOSE + 1)
  })

  it('is the source the relay builds in demo mode', async () => {
    const source = createRelaySource({ RELAY_1_SOURCE: 'mock', DEMO_MODE: 'true' })
    const replayed = await source.prepareClose('AAPL', DEMO_CLOSE)
    const official = replayed?.updates.find((update) => update.officialClose)
    assert.equal(official?.price, 3_409_700_000_000n)
  })

  it('leaves the mock source outside demo mode on its own fixtures', async () => {
    const source = createRelaySource({ RELAY_1_SOURCE: 'mock' })
    const replayed = await source.prepareClose('AAPL', DEMO_CLOSE)
    const official = replayed?.updates.find((update) => update.officialClose)
    assert.equal(official?.price, 2_452_700_000_000n)
  })
})
