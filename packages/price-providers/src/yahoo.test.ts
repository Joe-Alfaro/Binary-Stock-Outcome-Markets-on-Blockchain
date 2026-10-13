import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PriceSourceError, createYahooSource } from './index.js'
import type { NormalizedPrice, SettlementInputs } from './index.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  assertClose,
  assertNormalizedShape,
  barAt,
  blankBars,
  chartOf,
  confOf,
  dropBars,
  fakeFetch,
  readFixtureText,
  readYahooFixture,
  valueOf,
  yahooRoute,
} from './test-support.js'
import type { Route, YahooChartFixture } from './test-support.js'

const AFTER_CLOSE = CLOSE_TS + 15 * 60
const MINUTE = 60

function aaplMinute() {
  return readYahooFixture('AAPL-2026-10-09-1m.json')
}

function aaplDaily() {
  return readYahooFixture('AAPL-2026-10-09-1d.json')
}

function yahoo(route: Route, now = AFTER_CLOSE) {
  const { fetch, calls } = fakeFetch(route)
  const source = createYahooSource({ fetch, now: () => now, timeoutMs: 1_000 })
  return { source, calls }
}

function yahooWith(minute: YahooChartFixture, daily = aaplDaily(), now = AFTER_CLOSE) {
  return yahoo(yahooRoute(minute, daily), now)
}

/** The quote has not caught up with the close yet, so only the bars can settle. */
function delayedQuote(fixture: YahooChartFixture): YahooChartFixture {
  chartOf(fixture).meta.regularMarketTime = CLOSE_TS - MINUTE
  return fixture
}

function officialOf(inputs: SettlementInputs | null): NormalizedPrice[] {
  assert.ok(inputs, 'expected settlement inputs')
  return inputs.updates.filter((update) => update.officialClose)
}

async function rejectsWithCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PriceSourceError, `expected PriceSourceError, got ${String(error)}`)
    assert.equal(error.code, code)
    return true
  })
}

describe('yahoo source: official close (R39)', () => {
  it('publishes regularMarketPrice at regularMarketTime as the official close', async () => {
    const fixture = aaplMinute()
    const { meta } = chartOf(fixture)
    const inputs = await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS)

    assert.ok(inputs)
    assert.equal(inputs.ticker, 'AAPL')
    assert.equal(inputs.closeTs, CLOSE_TS)
    const official = officialOf(inputs)
    assert.equal(official.length, 1)
    const close = official[0]
    assert.ok(close)
    assertNormalizedShape(close)
    assert.equal(close.ticker, 'AAPL')
    assert.equal(close.session, 'regular')
    assert.equal(close.publishTime, meta.regularMarketTime)
    assertClose(valueOf(close), meta.regularMarketPrice)
  })

  it('queries the chart endpoint for the ticker with 1-minute bars and a browser User-Agent', async () => {
    const { source, calls } = yahooWith(aaplMinute())
    await source.prepareClose('AAPL', CLOSE_TS)

    const chartCall = calls.find((call) => call.url.searchParams.get('interval') === '1m')
    assert.ok(chartCall, 'requested 1-minute bars')
    assert.match(chartCall.url.hostname, /finance\.yahoo\.com$/)
    assert.equal(chartCall.url.pathname, '/v8/finance/chart/AAPL')
    assert.match(chartCall.headers.get('user-agent') ?? '', /Mozilla/)
  })

  it('works for a second ticker', async () => {
    const fixture = readYahooFixture('MSFT-2026-10-09-1m.json')
    const inputs = await yahooWith(fixture).source.prepareClose('MSFT', CLOSE_TS)

    const official = officialOf(inputs)
    assert.equal(official.length, 1)
    assert.equal(official[0]?.ticker, 'MSFT')
    assertClose(valueOf(official[0] as NormalizedPrice), chartOf(fixture).meta.regularMarketPrice)
  })

  it('never publishes after-hours prices', async () => {
    const fixture = aaplMinute()
    const { meta, timestamp, quote } = chartOf(fixture)
    const postMarketPrices = timestamp
      .map((ts, i) => (ts > CLOSE_TS ? [quote.open[i], quote.close[i]] : []))
      .flat()
      .filter((price): price is number => typeof price === 'number')
    assert.equal(typeof meta.postMarketPrice, 'number', 'fixture carries an after-hours price')
    postMarketPrices.push(meta.postMarketPrice as number)

    const inputs = await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS)

    assert.ok(inputs)
    assert.ok(inputs.updates.length > 0)
    inputs.updates.forEach((update) => {
      assert.equal(update.session, 'regular')
      assert.ok(update.publishTime <= CLOSE_TS + 300, 'no update from deep in the post-market')
      postMarketPrices.forEach((price) => {
        assert.notEqual(valueOf(update), price, `published after-hours price ${price}`)
      })
    })
  })

  it('does not treat a quote stamped before close_ts as the official close', async () => {
    const inputs = await yahooWith(delayedQuote(aaplMinute())).source.prepareClose('AAPL', CLOSE_TS)

    assert.equal(officialOf(inputs).length, 0)
  })

  it('does not treat a quote from the next session as this close', async () => {
    const fixture = aaplMinute()
    const { meta } = chartOf(fixture)
    meta.regularMarketTime = CLOSE_TS + 17.5 * 60 * 60 // 09:30 ET the next morning
    meta.regularMarketPrice = 251.13

    const inputs = await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS)

    assert.equal(officialOf(inputs).length, 0)
    inputs?.updates.forEach((update) => assert.notEqual(valueOf(update), 251.13))
  })

  it('returns null before the regular session has ended', async () => {
    const fixture = aaplMinute()
    chartOf(fixture).meta.regularMarketTime = CLOSE_TS - 10 * MINUTE
    const { source } = yahooWith(fixture, aaplDaily(), CLOSE_TS - 10 * MINUTE)

    assert.equal(await source.prepareClose('AAPL', CLOSE_TS), null)
  })
})

describe('yahoo source: 1-minute bar fallback (R39, R40)', () => {
  it('pairs the last bar before close_ts with the closing bar after it', async () => {
    const fixture = delayedQuote(aaplMinute())
    const last = barAt(fixture, CLOSE_TS - MINUTE)
    const closing = barAt(fixture, CLOSE_TS)

    const inputs = await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS)

    assert.ok(inputs)
    assert.equal(inputs.updates.length, 2)
    const [before, after] = inputs.updates
    assert.ok(before && after)
    ;[before, after].forEach((update) => {
      assertNormalizedShape(update)
      assert.equal(update.ticker, 'AAPL')
      assert.equal(update.session, 'regular')
      assert.equal(update.officialClose, false)
    })
    // A bar's close is stamped in its last second, and the closing bar's open just after close_ts.
    assert.equal(before.publishTime, CLOSE_TS - 1)
    assertClose(valueOf(before), last.close as number)
    assert.equal(after.publishTime, CLOSE_TS + 1)
    assertClose(valueOf(after), closing.open as number)
  })

  it('sets confidence to half of each bar high-low range', async () => {
    const fixture = delayedQuote(aaplMinute())
    const last = barAt(fixture, CLOSE_TS - MINUTE)
    const closing = barAt(fixture, CLOSE_TS)

    const inputs = await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS)

    const [before, after] = inputs?.updates ?? []
    assert.ok(before && after)
    assertClose(confOf(before), ((last.high as number) - (last.low as number)) / 2)
    assertClose(confOf(after), ((closing.high as number) - (closing.low as number)) / 2)
  })

  it('skips a missing 15:59 bar and uses the 15:58 bar', async () => {
    const fixture = delayedQuote(aaplMinute())
    blankBars(fixture, [CLOSE_TS - MINUTE])
    const earlier = barAt(fixture, CLOSE_TS - 2 * MINUTE)

    const inputs = await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS)

    const before = inputs?.updates[0]
    assert.ok(before)
    assert.equal(before.publishTime, CLOSE_TS - MINUTE - 1)
    assertClose(valueOf(before), earlier.close as number)
  })

  it('accepts a bar ending within 300 s before close_ts', async () => {
    const fixture = delayedQuote(aaplMinute())
    blankBars(
      fixture,
      [1, 2, 3, 4].map((m) => CLOSE_TS - m * MINUTE),
    )
    const fifteenFiftyFive = barAt(fixture, CLOSE_TS - 5 * MINUTE)

    const inputs = await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS)

    const before = inputs?.updates[0]
    assert.ok(before)
    assert.equal(before.publishTime, CLOSE_TS - 241)
    assertClose(valueOf(before), fifteenFiftyFive.close as number)
  })

  it('returns null when no regular bar falls within 300 s before close_ts', async () => {
    const fixture = delayedQuote(aaplMinute())
    blankBars(
      fixture,
      [1, 2, 3, 4, 5].map((m) => CLOSE_TS - m * MINUTE),
    )

    assert.equal(await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS), null)
  })

  it('returns null rather than using a post-market bar when the closing bar is missing', async () => {
    const fixture = delayedQuote(aaplMinute())
    dropBars(fixture, [CLOSE_TS])

    assert.equal(await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS), null)
  })

  it('returns null when the chart has no bars yet', async () => {
    const fixture = delayedQuote(aaplMinute())
    const result = fixture.chart.result[0]
    assert.ok(result)
    delete result.timestamp
    result.indicators.quote = [{ open: [], high: [], low: [], close: [], volume: [] }]

    assert.equal(await yahooWith(fixture).source.prepareClose('AAPL', CLOSE_TS), null)
  })
})

describe('yahoo source: previous close for strikes (R39, R15)', () => {
  it('returns the daily close dated the expected previous trading day', async () => {
    const { source, calls } = yahooWith(aaplMinute())

    const previous = await source.previousClose('AAPL', '2026-10-09')

    assert.deepEqual(previous, { ticker: 'AAPL', price: 245.27, tradingDay: '2026-10-09' })
    const dailyCall = calls.find((call) => call.url.searchParams.get('interval') === '1d')
    assert.ok(dailyCall, 'requested daily bars')
    assert.equal(dailyCall.url.pathname, '/v8/finance/chart/AAPL')
  })

  it("ignores today's partial bar during the session", async () => {
    const daily = readYahooFixture('MSFT-2026-10-12-1d-intraday.json')
    const { source } = yahooWith(aaplMinute(), daily, CLOSE_TS + 3 * 24 * 60 * 60 - 5 * 60 * 60)

    const previous = await source.previousClose('MSFT', '2026-10-09')

    assert.deepEqual(previous, { ticker: 'MSFT', price: 521.58, tradingDay: '2026-10-09' })
  })

  it('rejects as stale when the latest close is dated before the expected day', async () => {
    const { source } = yahooWith(aaplMinute())

    await rejectsWithCode(source.previousClose('AAPL', '2026-10-12'), 'stale')
  })
})

describe('yahoo source: failures (R39)', () => {
  function rateLimited() {
    return new Response(readFixtureText('yahoo/rate-limited.txt'), {
      status: 429,
      headers: { 'content-type': 'text/plain' },
    })
  }

  it('reports HTTP 429 as rate-limited', async () => {
    const { source } = yahoo(rateLimited)

    await rejectsWithCode(source.prepareClose('AAPL', CLOSE_TS), 'rate-limited')
    await rejectsWithCode(source.previousClose('AAPL', '2026-10-09'), 'rate-limited')
  })

  it('reports truncated JSON as malformed', async () => {
    const truncated = JSON.stringify(aaplMinute()).slice(0, 200)
    const { source } = yahoo(() => new Response(truncated, { status: 200 }))

    await rejectsWithCode(source.prepareClose('AAPL', CLOSE_TS), 'malformed')
  })

  it('reports JSON of the wrong shape as malformed', async () => {
    const { source } = yahoo(() => Response.json({ unexpected: true }))

    await rejectsWithCode(source.prepareClose('AAPL', CLOSE_TS), 'malformed')
    await rejectsWithCode(source.previousClose('AAPL', '2026-10-09'), 'malformed')
  })

  it('reports a non-numeric price as malformed', async () => {
    const fixture = aaplMinute()
    ;(chartOf(fixture).meta as Record<string, unknown>).regularMarketPrice = 'n/a'
    const { source } = yahooWith(fixture)

    await rejectsWithCode(source.prepareClose('AAPL', CLOSE_TS), 'malformed')
  })

  it('reports an unknown symbol as not-found', async () => {
    const body = readFixtureText('yahoo/not-found.json')
    const { source } = yahoo(() => new Response(body, { status: 404 }))

    await rejectsWithCode(source.prepareClose('ZZZZ', CLOSE_TS), 'not-found')
  })

  it('reports a server error as http', async () => {
    const { source } = yahoo(() => new Response('Internal Server Error', { status: 500 }))

    await rejectsWithCode(source.prepareClose('AAPL', CLOSE_TS), 'http')
  })

  it('times out a request that never answers', { timeout: 5_000 }, async () => {
    const { fetch } = fakeFetch(() => new Promise<Response>(() => {}))
    const hanging: typeof globalThis.fetch = (input, init) => {
      const pending = fetch(input, init)
      return new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        pending.then(resolve, reject)
      })
    }
    const source = createYahooSource({ fetch: hanging, now: () => AFTER_CLOSE, timeoutMs: 50 })

    await rejectsWithCode(source.prepareClose('AAPL', CLOSE_TS), 'timeout')
  })
})
