import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PriceSourceError, createMockSource, createYahooSource } from './index.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  fakeFetch,
  jsonResponse,
  readFixtureText,
  readYahooFixture,
} from './test-support.js'
import type { Route } from './test-support.js'

const HOUR = 60 * 60
/** 2026-10-09 10:00 ET. */
const MID_SESSION = CLOSE_TS - 6 * HOUR
const AAPL_PRICE = 2_452_700_000_000n

/** The recorded AAPL chart with its live quote stamped at `time`. */
function quotedAt(time: number) {
  const fixture = readYahooFixture('AAPL-2026-10-09-1m.json')
  const result = fixture.chart.result[0]
  assert.ok(result)
  result.meta.regularMarketTime = time
  return fixture
}

function setup(route: Route, now: number) {
  const clock = { now }
  const { fetch, calls } = fakeFetch(route)
  const source = createYahooSource({ fetch, now: () => clock.now, timeoutMs: 1_000 })
  return { source, calls, clock }
}

describe('yahoo source: latest price (R47)', () => {
  it('returns regularMarketPrice at regularMarketTime during the regular session', async () => {
    const { source, calls } = setup(() => jsonResponse(quotedAt(MID_SESSION)), MID_SESSION + 20)
    assert.deepEqual(await source.latest('AAPL'), {
      ticker: 'AAPL',
      price: AAPL_PRICE,
      conf: 0n,
      expo: -10,
      publishTime: MID_SESSION,
      session: 'regular',
      officialClose: false,
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url.searchParams.get('interval'), '1d')
  })

  const outside: [string, number, number][] = [
    ['a pre-market quote', CLOSE_TS - 9 * HOUR, CLOSE_TS - 9 * HOUR + 20],
    ['a post-market quote', CLOSE_TS + HOUR, CLOSE_TS + HOUR + 20],
    ['the previous session’s quote', MID_SESSION - 24 * HOUR, MID_SESSION],
  ]
  outside.forEach(([label, quoteTime, now]) => {
    it(`returns null for ${label}`, async () => {
      const { source } = setup(() => jsonResponse(quotedAt(quoteTime)), now)
      assert.equal(await source.latest('AAPL'), null)
    })
  })

  it('backs off after a 429 without touching the network, then tries again', async () => {
    const rateLimited = () =>
      new Response(readFixtureText('yahoo/rate-limited.txt'), { status: 429 })
    const { source, calls, clock } = setup(rateLimited, MID_SESSION)
    const isRateLimited = (error: unknown) =>
      error instanceof PriceSourceError && error.code === 'rate-limited'

    await assert.rejects(source.latest('AAPL'), isRateLimited)
    assert.equal(calls.length, 2, 'one request per host')
    clock.now += 29
    await assert.rejects(source.latest('AAPL'), isRateLimited)
    assert.equal(calls.length, 2, 'called the network while backing off')
    clock.now += 1
    await assert.rejects(source.latest('AAPL'), isRateLimited)
    assert.equal(calls.length, 4)
  })
})

describe('mock source: latest price (R47)', () => {
  it('replays the recorded price stamped at the current time, offline', async () => {
    const realFetch = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('the mock source must not use the network')
    }) as typeof fetch
    try {
      const update = await createMockSource({ now: () => MID_SESSION }).latest('AAPL')
      assert.equal(update?.price, AAPL_PRICE)
      assert.equal(update?.publishTime, MID_SESSION)
      assert.equal(update?.session, 'regular')
      assert.equal(update?.officialClose, false)
    } finally {
      globalThis.fetch = realFetch
    }
  })
})
