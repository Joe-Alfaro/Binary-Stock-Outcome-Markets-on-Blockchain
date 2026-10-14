// R67: the Alpaca source's REST side, against recorded fixtures (D67 provenance). No test here
// opens a network connection: every request goes to a fake fetch.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PriceSourceError, createAlpacaSource } from './index.js'
import type { AlpacaSourceOptions } from './index.js'
import {
  ALPACA_CLOSE_TS as CLOSE_TS,
  ALPACA_OPEN_TS as OPEN_TS,
  KEYS,
  TICKERS,
  alpacaRoute,
  barAt,
  fixtures,
  readAlpacaText,
  unixOf,
  withoutBars,
} from './alpaca-test-support.js'
import type { AlpacaRouteSpec } from './alpaca-test-support.js'
import {
  assertClose,
  assertNormalizedShape,
  confOf,
  fakeFetch,
  jsonResponse,
  valueOf,
} from './test-support.js'
import type { RecordedCall, Route } from './test-support.js'

const MINUTE = 60
/** 2026-10-14 11:00 ET: the 2026-10-13 session is over and the next one is running. */
const NEXT_MORNING = Date.parse('2026-10-14T15:00:00Z') / 1000
/** Late enough after the close that the free plan serves SIP data for it. */
const AFTER_SIP_DELAY = CLOSE_TS + 20 * MINUTE

function setup(route: Route, start = AFTER_SIP_DELAY, options: Partial<AlpacaSourceOptions> = {}) {
  const { fetch, calls } = fakeFetch(route)
  const clock = { now: start }
  const source = createAlpacaSource({
    ...KEYS,
    fetch,
    now: () => clock.now,
    tickers: TICKERS,
    ...options,
  })
  return { source, calls, clock }
}

function fullRoute(overrides: AlpacaRouteSpec = {}): Route {
  return alpacaRoute({
    bars: {
      '1Day:sip': fixtures.daily(),
      '1Min:sip': fixtures.closeSip(),
      '1Min:iex': fixtures.closeIex(),
    },
    ...overrides,
  })
}

function dailyClose(ticker: string, day: string): number {
  const bar = fixtures.daily().bars[ticker]?.find((entry) => entry.t.startsWith(day))
  assert.ok(bar, `fixture has a ${ticker} daily bar for ${day}`)
  return bar.c
}

function barsRequests(calls: RecordedCall[], timeframe: string) {
  return calls.filter(
    (call) =>
      call.url.pathname === '/v2/stocks/bars' &&
      call.url.searchParams.get('timeframe') === timeframe,
  )
}

async function rejection(promise: Promise<unknown>): Promise<PriceSourceError> {
  try {
    await promise
  } catch (error) {
    assert.ok(
      error instanceof PriceSourceError,
      `expected a PriceSourceError, got ${String(error)}`,
    )
    return error
  }
  return assert.fail('expected a rejection')
}

function assertNoSecrets(text: string) {
  assert.ok(!text.includes(KEYS.keyId), 'text leaks the key id')
  assert.ok(!text.includes(KEYS.secretKey), 'text leaks the secret')
}

describe('Alpaca fixtures (R67)', () => {
  it('the SIP daily close of 2026-10-13 is the official closing print', () => {
    const official = fixtures.closeTrades().trades.AAPL?.find((trade) => trade.c.includes('M'))
    assert.ok(official, 'the trades fixture holds the market-center official close')
    assert.equal(dailyClose('AAPL', '2026-10-13'), official.p)
  })

  it('the 16:00 minute bar is after-hours trading and differs from the official close', () => {
    const closing = barAt(fixtures.closeSip(), 'AAPL', CLOSE_TS)
    assert.notEqual(closing.c, dailyClose('AAPL', '2026-10-13'))
  })
})

describe('Alpaca requests (R67)', () => {
  it('sends the key pair as headers and never in the URL', async () => {
    const { source, calls } = setup(fullRoute(), NEXT_MORNING)
    await source.previousClose('AAPL', '2026-10-13')

    assert.ok(calls.length > 0)
    calls.forEach((call) => {
      assert.equal(call.headers.get('APCA-API-KEY-ID'), KEYS.keyId)
      assert.equal(call.headers.get('APCA-API-SECRET-KEY'), KEYS.secretKey)
      assert.equal(call.url.origin, 'https://data.alpaca.markets')
      assertNoSecrets(call.url.toString())
    })
  })

  it('uses the configured REST base URL', async () => {
    const { source, calls } = setup(fullRoute(), NEXT_MORNING, { restUrl: 'http://127.0.0.1:9' })
    await source.previousClose('AAPL', '2026-10-13')
    assert.ok(calls.every((call) => call.url.origin === 'http://127.0.0.1:9'))
  })
})

describe('Alpaca previous close for strikes (R67)', () => {
  TICKERS.forEach((ticker) => {
    it(`${ticker}: the SIP daily close of the previous trading day`, async () => {
      const { source, calls } = setup(fullRoute(), NEXT_MORNING)

      const close = await source.previousClose(ticker, '2026-10-13')

      assert.deepEqual(close, {
        ticker,
        price: dailyClose(ticker, '2026-10-13'),
        tradingDay: '2026-10-13',
      })
      const [request] = barsRequests(calls, '1Day')
      assert.ok(request, 'asks for daily bars')
      assert.equal(request.url.searchParams.get('feed'), 'sip')
      assert.ok(request.url.searchParams.get('symbols')?.split(',').includes(ticker))
    })
  })

  it('takes the requested day, not the latest one', async () => {
    const { source } = setup(fullRoute(), NEXT_MORNING)
    const close = await source.previousClose('MSFT', '2026-10-12')
    assert.equal(close.price, dailyClose('MSFT', '2026-10-12'))
  })

  it('rejects as stale when the latest completed close is older than the day asked for', async () => {
    const { source } = setup(fullRoute(), NEXT_MORNING)
    const error = await rejection(source.previousClose('AAPL', '2026-10-14'))
    assert.equal(error.code, 'stale')
  })

  it('never counts a daily bar whose session is still running', async () => {
    const daily = fixtures.daily()
    const aapl = daily.bars.AAPL ?? []
    const last = aapl.at(-1)
    assert.ok(last)
    daily.bars.AAPL = [...aapl, { ...last, t: '2026-10-14T04:00:00Z', c: 345.31 }]
    const { source } = setup(alpacaRoute({ bars: { '1Day:sip': daily } }), NEXT_MORNING)

    const error = await rejection(source.previousClose('AAPL', '2026-10-14'))
    assert.equal(error.code, 'stale')
  })
})

describe('Alpaca settlement inputs around close_ts (R67, R33, D23)', () => {
  it('returns null before close without a request', async () => {
    const { source, calls } = setup(fullRoute(), CLOSE_TS - 1)
    assert.equal(await source.prepareClose('AAPL', CLOSE_TS), null)
    assert.equal(calls.length, 0)
  })

  TICKERS.forEach((ticker) => {
    it(`${ticker}: the official close is the SIP daily close, stamped at the close`, async () => {
      const { source, calls } = setup(fullRoute())

      const inputs = await source.prepareClose(ticker, CLOSE_TS)

      assert.ok(inputs, 'gives settlement inputs')
      assert.equal(inputs.ticker, ticker)
      assert.equal(inputs.closeTs, CLOSE_TS)
      assert.equal(inputs.updates.length, 1)
      const [official] = inputs.updates
      assert.ok(official)
      assertNormalizedShape(official)
      assert.equal(official.ticker, ticker)
      assert.equal(official.officialClose, true)
      assert.equal(official.session, 'regular')
      assertClose(valueOf(official), dailyClose(ticker, '2026-10-13'))
      assert.equal(confOf(official), 0)
      assert.ok(official.publishTime >= CLOSE_TS, 'stamped at or after close')
      assert.ok(official.publishTime < CLOSE_TS + 300, 'stamped within the close window')
      const daily = barsRequests(calls, '1Day')
      assert.ok(
        daily.length > 0 && daily.every((call) => call.url.searchParams.get('feed') === 'sip'),
      )
    })
  })

  it('never takes the after-hours 16:00 bar as the close', async () => {
    const { source } = setup(fullRoute())
    const inputs = await source.prepareClose('AAPL', CLOSE_TS)
    const afterHours = barAt(fixtures.closeSip(), 'AAPL', CLOSE_TS).c
    assert.ok(inputs)
    inputs.updates.forEach((update) => assert.notEqual(valueOf(update), afterHours))
  })

  it('without a daily bar, pairs the last regular minute with the closing bar open (D23)', async () => {
    const daily = withoutBars(fixtures.daily(), (ts) => ts >= unixOf('2026-10-13T00:00:00Z'))
    const { source, calls } = setup(
      fullRoute({ bars: { '1Day:sip': daily, '1Min:sip': fixtures.closeSip() } }),
    )

    const inputs = await source.prepareClose('AAPL', CLOSE_TS)

    const before = barAt(fixtures.closeSip(), 'AAPL', CLOSE_TS - MINUTE)
    const closing = barAt(fixtures.closeSip(), 'AAPL', CLOSE_TS)
    assert.ok(inputs, 'gives the bar pair')
    assert.deepEqual(
      inputs.updates.map((update) => [update.publishTime, update.officialClose, update.session]),
      [
        [CLOSE_TS - 1, false, 'regular'],
        [CLOSE_TS + 1, false, 'regular'],
      ],
    )
    const [first, second] = inputs.updates
    assert.ok(first && second)
    assertClose(valueOf(first), before.c)
    assertClose(valueOf(second), closing.o)
    // R40: half the 1-minute bar's high-low range.
    assertClose(confOf(first), (before.h - before.l) / 2)
    assertClose(confOf(second), (closing.h - closing.l) / 2)
    assert.ok(barsRequests(calls, '1Min').length > 0, 'asks for 1-minute bars')
  })

  it('gives no shape rather than use bars after the closing minute', async () => {
    const daily = withoutBars(fixtures.daily(), (ts) => ts >= unixOf('2026-10-13T00:00:00Z'))
    const minutes = withoutBars(fixtures.closeSip(), (ts) => ts === CLOSE_TS)
    const { source } = setup(alpacaRoute({ bars: { '1Day:sip': daily, '1Min:sip': minutes } }))

    assert.equal(await source.prepareClose('AAPL', CLOSE_TS), null)
  })

  it('never stamps an update past the closing bar', async () => {
    const daily = withoutBars(fixtures.daily(), (ts) => ts >= unixOf('2026-10-13T00:00:00Z'))
    const { source } = setup(
      alpacaRoute({ bars: { '1Day:sip': daily, '1Min:sip': fixtures.closeSip() } }),
    )
    const inputs = await source.prepareClose('MSFT', CLOSE_TS)
    assert.ok(inputs)
    inputs.updates.forEach((update) => assert.ok(update.publishTime <= CLOSE_TS + 1))
  })

  it('falls back to IEX while SIP is refused, and never calls that an official close', async () => {
    const { source, calls } = setup(fullRoute({ sipRefused: true }), CLOSE_TS + 5 * MINUTE)

    const inputs = await source.prepareClose('AAPL', CLOSE_TS)

    assert.ok(
      calls.some((call) => call.url.searchParams.get('feed') === 'iex'),
      'asks the IEX feed after the SIP refusal',
    )
    // The IEX feed has no bar after 15:59, so there is no closing bar to pair with yet.
    assert.equal(inputs, null)
  })
})

describe('Alpaca intraday 1-minute series (R67, R66)', () => {
  function sessionRoute() {
    return alpacaRoute({ bars: { '1Min:sip': fixtures.session() } })
  }

  it('returns a full regular session of 1-minute closes, oldest first', async () => {
    const { source, calls } = setup(sessionRoute(), NEXT_MORNING)

    const points = await source.intraday('AAPL', OPEN_TS, CLOSE_TS)

    const bars = fixtures.session().bars.AAPL ?? []
    assert.equal(points.length, 390)
    assert.deepEqual(
      points,
      bars.map((bar) => ({ t: unixOf(bar.t), price: bar.c })),
    )
    assert.equal(points[0]?.t, OPEN_TS)
    assert.equal(points.at(-1)?.t, CLOSE_TS - MINUTE)
    const [request] = barsRequests(calls, '1Min')
    assert.ok(request)
    assert.equal(request.url.searchParams.get('feed'), 'sip')
  })

  it('serves each ticker its own series', async () => {
    const { source } = setup(sessionRoute(), NEXT_MORNING)
    const msft = await source.intraday('MSFT', OPEN_TS, CLOSE_TS)
    const aapl = await source.intraday('AAPL', OPEN_TS, CLOSE_TS)
    assert.equal(msft.length, 390)
    assert.notDeepEqual(msft, aapl)
  })

  it('keeps only points inside the window', async () => {
    const { source } = setup(sessionRoute(), NEXT_MORNING)
    const from = OPEN_TS + 60 * MINUTE
    const to = OPEN_TS + 120 * MINUTE
    const points = await source.intraday('AAPL', from, to)
    assert.equal(points.length, 61)
    assert.ok(points.every((point) => point.t >= from && point.t <= to))
  })

  it('drops after-hours bars from a window that runs past the close', async () => {
    const { source } = setup(
      alpacaRoute({ bars: { '1Min:sip': fixtures.closeSip() } }),
      NEXT_MORNING,
    )
    const points = await source.intraday('AAPL', CLOSE_TS - 15 * MINUTE, CLOSE_TS + 15 * MINUTE)
    assert.equal(points.length, 15)
    assert.equal(points.at(-1)?.t, CLOSE_TS - MINUTE)
  })

  it('uses IEX for the last 15 minutes, which the free plan refuses on SIP', async () => {
    const { source, calls } = setup(fullRoute({ sipRefused: true }), CLOSE_TS + 5 * MINUTE)

    const points = await source.intraday('AAPL', CLOSE_TS - 15 * MINUTE, CLOSE_TS)

    const iex = fixtures.closeIex().bars.AAPL ?? []
    assert.deepEqual(
      points,
      iex.map((bar) => ({ t: unixOf(bar.t), price: bar.c })),
    )
    assert.ok(calls.some((call) => call.url.searchParams.get('feed') === 'iex'))
  })

  it('follows next_page_token, a bounded number of times', async () => {
    const bars = fixtures.session().bars.AAPL ?? []
    const pages = [bars.slice(0, 200), bars.slice(200)]
    const { source, calls } = setup((url) => {
      const page = url.searchParams.get('page_token') === 'p2' ? 1 : 0
      return jsonResponse({
        bars: { AAPL: pages[page] },
        next_page_token: page === 0 ? 'p2' : null,
      })
    }, NEXT_MORNING)

    const points = await source.intraday('AAPL', OPEN_TS, CLOSE_TS)

    assert.equal(points.length, 390)
    assert.equal(calls.length, 2)
  })

  it('stops paging when the API keeps sending a next page', async () => {
    const bars = fixtures.session().bars.AAPL ?? []
    const { source, calls } = setup(
      () => jsonResponse({ bars: { AAPL: bars.slice(0, 10) }, next_page_token: 'again' }),
      NEXT_MORNING,
    )
    await source.intraday('AAPL', OPEN_TS, CLOSE_TS).catch(() => undefined)
    assert.ok(calls.length <= 20, `stopped paging after ${calls.length} requests`)
  })
})

function status(code: number, body: string, headers: Record<string, string> = {}): Route {
  return () => new Response(body, { status: code, headers })
}

describe('Alpaca HTTP 429 handling with bounded backoff (R67)', () => {
  const limited = () => status(429, readAlpacaText('rate-limited.json'))

  it('rejects with rate-limited', async () => {
    const { source } = setup(limited(), NEXT_MORNING)
    const error = await rejection(source.previousClose('AAPL', '2026-10-13'))
    assert.equal(error.code, 'rate-limited')
    assertNoSecrets(`${error.message} ${error.stack ?? ''}`)
  })

  it('fails fast without a request while backing off', async () => {
    const { source, calls } = setup(limited(), NEXT_MORNING)
    await rejection(source.previousClose('AAPL', '2026-10-13'))
    const sent = calls.length

    const error = await rejection(source.intraday('AAPL', OPEN_TS, CLOSE_TS))

    assert.equal(error.code, 'rate-limited')
    assert.equal(calls.length, sent, 'no request while backing off')
  })

  it('never backs off longer than 10 minutes, however many 429s in a row', async () => {
    const { source, calls, clock } = setup(limited(), NEXT_MORNING)
    const perCall = await Array.from({ length: 10 }).reduce<Promise<number[]>>(async (previous) => {
      const counts = await previous
      const before = calls.length
      await rejection(source.previousClose('AAPL', '2026-10-13'))
      clock.now += 10 * MINUTE + 1
      return [...counts, calls.length - before]
    }, Promise.resolve([]))
    assert.ok(
      perCall.every((count) => count >= 1),
      `every call after the backoff asks again: ${perCall}`,
    )
    assert.ok(
      perCall.every((count) => count <= 3),
      `at most 3 requests per call: ${perCall}`,
    )
  })

  it('recovers once the API answers again', async () => {
    let refuse = true
    const ok = fullRoute()
    const { source, clock } = setup(
      (url) => (refuse ? new Response('{}', { status: 429 }) : ok(url)),
      NEXT_MORNING,
    )
    await rejection(source.previousClose('AAPL', '2026-10-13'))
    refuse = false
    clock.now += 10 * MINUTE + 1
    const close = await source.previousClose('AAPL', '2026-10-13')
    assert.equal(close.price, dailyClose('AAPL', '2026-10-13'))
  })
})

describe('Alpaca auth failure and network errors (R67)', () => {
  it('rejects a 401 as unauthorized, naming the variables and not their values', async () => {
    const { source, calls } = setup(
      status(401, readAlpacaText('unauthorized.html'), { 'content-type': 'text/html' }),
      NEXT_MORNING,
    )

    const error = await rejection(source.previousClose('AAPL', '2026-10-13'))

    assert.equal(error.code, 'unauthorized')
    assert.match(error.message, /ALPACA_API_KEY/)
    assertNoSecrets(`${error.message} ${error.stack ?? ''}`)
    assert.ok(calls.length <= 2, `a bad key is not retried in a loop (${calls.length} requests)`)
  })

  it('rejects a 403 that is not the SIP refusal as unauthorized', async () => {
    const { source } = setup(
      status(403, JSON.stringify({ message: 'forbidden' }), { 'content-type': 'application/json' }),
      NEXT_MORNING,
    )
    const error = await rejection(source.previousClose('AAPL', '2026-10-13'))
    assert.equal(error.code, 'unauthorized')
  })

  it('rejects a network failure as http after at most 3 attempts', async () => {
    const { source, calls } = setup(() => {
      throw new TypeError('fetch failed')
    }, NEXT_MORNING)

    const error = await rejection(source.previousClose('AAPL', '2026-10-13'))

    assert.equal(error.code, 'http')
    assert.ok(calls.length >= 1 && calls.length <= 3, `${calls.length} attempts`)
    assertNoSecrets(`${error.message} ${error.stack ?? ''}`)
  })

  it('times out a request that never answers', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    const source = createAlpacaSource({
      ...KEYS,
      fetch: hang,
      now: () => NEXT_MORNING,
      timeoutMs: 20,
      tickers: TICKERS,
    })
    const error = await rejection(source.previousClose('AAPL', '2026-10-13'))
    assert.equal(error.code, 'timeout')
  })

  it('rejects a body that is not JSON as malformed', async () => {
    const { source } = setup(status(200, 'not json'), NEXT_MORNING)
    const error = await rejection(source.previousClose('AAPL', '2026-10-13'))
    assert.equal(error.code, 'malformed')
  })

  it('rejects bars of the wrong shape as malformed', async () => {
    const { source } = setup(
      () => jsonResponse({ bars: { AAPL: [{ t: 'yesterday', c: 'x' }] } }),
      NEXT_MORNING,
    )
    const error = await rejection(source.intraday('AAPL', OPEN_TS, CLOSE_TS))
    assert.equal(error.code, 'malformed')
  })
})
