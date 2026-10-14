import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { PriceSourceError, createMockSource, createYahooSource } from './index.js'
import type { IntradayPoint } from './index.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  blankBars,
  chartOf,
  fakeFetch,
  jsonResponse,
  readFixtureText,
  readYahooFixture,
} from './test-support.js'

const MINUTE = 60

/**
 * The recording has bars from 3:50 PM to 4:10 PM ET on 2026-10-09. The window ends before the
 * close so it doesn't depend on whether the bar starting at 4:00 PM counts.
 */
const FROM = CLOSE_TS - 10 * MINUTE
const TO = CLOSE_TS - 2 * MINUTE

function assertOrderedWithin(points: IntradayPoint[], from: number, to: number) {
  points.forEach((point, i) => {
    assert.ok(point.t >= from && point.t <= to, `point ${point.t} inside [${from}, ${to}]`)
    assert.ok(Number.isFinite(point.price) && point.price > 0, 'price is a positive number')
    if (i > 0) assert.ok(point.t > (points[i - 1] as IntradayPoint).t, 'oldest first')
  })
}

// R66: the Markets chart's series comes from the relay source's 1-minute bars.
describe('yahoo source: intraday 1-minute series (R66)', () => {
  it('asks the chart API for 1-minute bars over the window, regular session only', async () => {
    const { fetch, calls } = fakeFetch(() =>
      jsonResponse(readYahooFixture('AAPL-2026-10-09-1m.json')),
    )
    const source = createYahooSource({ fetch, now: () => CLOSE_TS + 900, timeoutMs: 1_000 })

    await source.intraday('AAPL', FROM, TO)

    assert.equal(calls.length, 1)
    const params = (calls[0] as { url: URL }).url.searchParams
    assert.equal(params.get('interval'), '1m')
    assert.equal(params.get('period1'), String(FROM))
    assert.equal(params.get('period2'), String(TO))
    assert.notEqual(params.get('includePrePost'), 'true')
  })

  it('returns the bar closes inside the window, oldest first, skipping empty minutes', async () => {
    const fixture = readYahooFixture('AAPL-2026-10-09-1m.json')
    const blank = CLOSE_TS - 5 * MINUTE
    blankBars(fixture, [blank])
    const { fetch } = fakeFetch(() => jsonResponse(fixture))
    const source = createYahooSource({ fetch, now: () => CLOSE_TS + 900, timeoutMs: 1_000 })

    const points = await source.intraday('AAPL', FROM, TO)

    const { timestamp, quote } = chartOf(fixture)
    const expected = timestamp
      .map((t, i) => ({ t, price: quote.close[i] }))
      .filter((p): p is IntradayPoint => p.price != null && p.t >= FROM && p.t <= TO)
    assert.ok(expected.length > 5, 'the fixture has bars in the window')
    assert.deepEqual(points, expected)
    assert.equal(
      points.some((p) => p.t === blank),
      false,
    )
    assertOrderedWithin(points, FROM, TO)
  })

  it('rejects with a rate-limited error on HTTP 429', async () => {
    const { fetch } = fakeFetch(
      () => new Response(readFixtureText('yahoo/rate-limited.txt'), { status: 429 }),
    )
    const source = createYahooSource({ fetch, now: () => CLOSE_TS + 900, timeoutMs: 1_000 })

    await assert.rejects(
      source.intraday('AAPL', FROM, TO),
      (error: unknown) => error instanceof PriceSourceError && error.code === 'rate-limited',
    )
  })
})

describe('mock source: intraday 1-minute series (R66)', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error('the mock source must not use the network')
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('returns a non-empty series inside any requested session window, offline', async () => {
    // 2026-10-13, 9:30 AM to 11:00 AM ET.
    const from = Date.parse('2026-10-13T13:30:00Z') / 1000
    const to = Date.parse('2026-10-13T15:00:00Z') / 1000

    const points = await createMockSource().intraday('AAPL', from, to)

    assert.ok(points.length > 1, 'enough points to draw a line')
    assertOrderedWithin(points, from, to)
  })
})
