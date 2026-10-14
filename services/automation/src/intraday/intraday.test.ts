// The route's session choice must not depend on the host's time zone.
process.env.TZ = 'Asia/Tokyo'

import assert from 'node:assert/strict'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, it } from 'node:test'
import { PriceSourceError } from '@meridian/price-providers'
import type { IntradayPoint } from '@meridian/price-providers'
import { createHealthServer, createHealthState } from '../health.js'
import { INTRADAY_CACHE_SECS, createIntradayService } from './index.js'
import type { IntradaySeries } from './index.js'

const MINUTE = 60
const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'] as const

function utc(iso: string): number {
  return Date.parse(iso) / 1000
}

interface UpstreamCall {
  ticker: string
  fromTs: number
  toTs: number
}

/**
 * A stand-in relay source. By default it answers with one bar per minute from 5 minutes before
 * the window to 5 minutes after it, like a provider that ignores the window's edges, so the route
 * has to trim the series itself.
 */
class FakeSource {
  calls: UpstreamCall[] = []
  answer: (call: UpstreamCall) => Promise<IntradayPoint[]> = async ({ fromTs, toTs }) =>
    minuteBars(fromTs - 5 * MINUTE, toTs + 5 * MINUTE)

  intraday(ticker: string, fromTs: number, toTs: number): Promise<IntradayPoint[]> {
    const call = { ticker, fromTs, toTs }
    this.calls.push(call)
    return this.answer(call)
  }
}

function minuteBars(fromTs: number, toTs: number): IntradayPoint[] {
  const start = Math.ceil(fromTs / MINUTE) * MINUTE
  const count = Math.floor((toTs - start) / MINUTE) + 1
  return Array.from({ length: count }, (_, i) => ({ t: start + i * MINUTE, price: 200 + i / 100 }))
}

let server: Server | undefined

afterEach(async () => {
  const open = server
  server = undefined
  await new Promise<void>((resolve) => (open ? open.close(() => resolve()) : resolve()))
})

async function serve(startTs: number, source = new FakeSource()) {
  const clock = { now: startTs }
  const intraday = createIntradayService({ source, tickers: TICKERS, now: () => clock.now })
  const listening = createHealthServer(createHealthState(), { intraday })
  server = listening
  await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`
  const get = (path: string) => fetch(`${baseUrl}${path}`)
  return { source, clock, get }
}

async function seriesOf(response: Response): Promise<IntradaySeries> {
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /application\/json/)
  return (await response.json()) as IntradaySeries
}

interface WindowCase {
  name: string
  now: number
  sessionDate: string
  live: boolean
  openTs: number
  endTs: number
  earlyClose: boolean
}

const WINDOW_CASES: WindowCase[] = [
  {
    name: 'weekday mid-session: today, open to now',
    now: utc('2026-10-13T15:00:00Z'),
    sessionDate: '2026-10-13',
    live: true,
    openTs: utc('2026-10-13T13:30:00Z'),
    endTs: utc('2026-10-13T15:00:00Z'),
    earlyClose: false,
  },
  {
    name: "before the open: the previous trading day's full session",
    now: utc('2026-10-14T12:00:00Z'),
    sessionDate: '2026-10-13',
    live: false,
    openTs: utc('2026-10-13T13:30:00Z'),
    endTs: utc('2026-10-13T20:00:00Z'),
    earlyClose: false,
  },
  {
    name: "after the close: today's full session",
    now: utc('2026-10-13T21:00:00Z'),
    sessionDate: '2026-10-13',
    live: false,
    openTs: utc('2026-10-13T13:30:00Z'),
    endTs: utc('2026-10-13T20:00:00Z'),
    earlyClose: false,
  },
  {
    name: "weekend: Friday's full session",
    now: utc('2026-10-17T16:00:00Z'),
    sessionDate: '2026-10-16',
    live: false,
    openTs: utc('2026-10-16T13:30:00Z'),
    endTs: utc('2026-10-16T20:00:00Z'),
    earlyClose: false,
  },
  {
    name: "holiday (Thanksgiving): the day before's full session",
    now: utc('2026-11-26T17:00:00Z'),
    sessionDate: '2026-11-25',
    live: false,
    openTs: utc('2026-11-25T14:30:00Z'),
    endTs: utc('2026-11-25T21:00:00Z'),
    earlyClose: false,
  },
  {
    name: 'early-close day after 1:00 PM ET: the session ends at 1:00 PM',
    now: utc('2026-11-27T19:00:00Z'),
    sessionDate: '2026-11-27',
    live: false,
    openTs: utc('2026-11-27T14:30:00Z'),
    endTs: utc('2026-11-27T18:00:00Z'),
    earlyClose: true,
  },
]

// R66: the worker's read-only price endpoint serves the Markets chart's series.
describe('GET /prices/intraday/<ticker>: session window (R66)', () => {
  WINDOW_CASES.forEach((c) => {
    it(c.name, async () => {
      const { source, get } = await serve(c.now)

      const series = await seriesOf(await get('/prices/intraday/AAPL'))

      assert.deepEqual(source.calls, [{ ticker: 'AAPL', fromTs: c.openTs, toTs: c.endTs }])
      const { points, ...window } = series
      assert.deepEqual(window, {
        ticker: 'AAPL',
        live: c.live,
        sessionDate: c.sessionDate,
        openTs: c.openTs,
        endTs: c.endTs,
        earlyClose: c.earlyClose,
      })
      // Trimmed to the window: the first point is the open's bar, the last the window's end.
      assert.deepEqual(
        points,
        minuteBars(c.openTs - 5 * MINUTE, c.endTs + 5 * MINUTE).filter(
          (p) => p.t >= c.openTs && p.t <= c.endTs,
        ),
      )
      assert.equal(points[0]?.t, c.openTs)
      assert.equal(points.at(-1)?.t, c.endTs)
    })
  })

  it('lets the browser read it from another origin', async () => {
    const { get } = await serve(utc('2026-10-13T15:00:00Z'))
    const response = await get('/prices/intraday/AAPL')
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
    await response.body?.cancel()
  })

  it('answers 404 for a ticker it does not list, without an upstream request', async () => {
    const { source, get } = await serve(utc('2026-10-13T15:00:00Z'))
    const response = await get('/prices/intraday/XYZ')
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'unknown-ticker' })
    assert.equal(source.calls.length, 0)
  })

  it('answers 503 unavailable when the session is outside the calendar data', async () => {
    // Friday 2026-01-02, 7:00 AM EST: the previous trading day is in 2025.
    const { source, get } = await serve(utc('2026-01-02T12:00:00Z'))
    const response = await get('/prices/intraday/AAPL')
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'unavailable' })
    assert.equal(source.calls.length, 0)
  })

  it('still answers /healthz', async () => {
    const { get } = await serve(utc('2026-10-13T15:00:00Z'))
    const response = await get('/healthz')
    assert.equal(response.status, 200)
    await response.body?.cancel()
  })
})

describe('GET /prices/intraday/<ticker>: caching (R66)', () => {
  it('makes at most one upstream request per ticker per 60 s', async () => {
    assert.equal(INTRADAY_CACHE_SECS, 60)
    const start = utc('2026-10-13T15:00:00Z')
    const { source, clock, get } = await serve(start)

    const first = await seriesOf(await get('/prices/intraday/AAPL'))
    clock.now = start + 30
    const second = await seriesOf(await get('/prices/intraday/AAPL'))
    clock.now = start + 59
    await seriesOf(await get('/prices/intraday/AAPL'))

    assert.equal(source.calls.length, 1)
    assert.deepEqual(second, first, 'served from the cache')

    clock.now = start + 60
    const third = await seriesOf(await get('/prices/intraday/AAPL'))
    assert.equal(source.calls.length, 2)
    assert.equal(third.endTs, start + 60, 'a fresh live window after 60 s')
  })

  it('caches each ticker separately', async () => {
    const { source, get } = await serve(utc('2026-10-13T15:00:00Z'))

    await seriesOf(await get('/prices/intraday/AAPL'))
    await seriesOf(await get('/prices/intraday/MSFT'))
    await seriesOf(await get('/prices/intraday/AAPL'))
    const msft = await seriesOf(await get('/prices/intraday/MSFT'))

    assert.deepEqual(
      source.calls.map((call) => call.ticker),
      ['AAPL', 'MSFT'],
    )
    assert.equal(msft.ticker, 'MSFT')
  })

  it('shares one upstream request between concurrent requests', async () => {
    const source = new FakeSource()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    const answer = source.answer
    source.answer = async (call) => {
      await gate
      return answer(call)
    }
    const { get } = await serve(utc('2026-10-13T15:00:00Z'), source)

    const pending = Promise.all([1, 2, 3].map(() => get('/prices/intraday/AAPL')))
    await new Promise((resolve) => setTimeout(resolve, 50))
    release()
    const responses = await pending

    await Promise.all(responses.map(seriesOf))
    assert.equal(source.calls.length, 1)
  })
})

describe('GET /prices/intraday/<ticker>: upstream failures (R66)', () => {
  it('answers 503 rate-limited on an upstream 429 and waits 60 s before asking again', async () => {
    const source = new FakeSource()
    source.answer = () => Promise.reject(new PriceSourceError('rate-limited', 'answered 429'))
    const start = utc('2026-10-13T15:00:00Z')
    const { clock, get } = await serve(start, source)

    const response = await get('/prices/intraday/AAPL')
    assert.equal(response.status, 503)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await response.json(), { error: 'rate-limited' })

    // No tight retries: the next requests inside 60 s get the same answer without a call.
    clock.now = start + 1
    const again = await get('/prices/intraday/AAPL')
    assert.equal(again.status, 503)
    await again.body?.cancel()
    clock.now = start + 59
    await (await get('/prices/intraday/AAPL')).body?.cancel()
    assert.equal(source.calls.length, 1)

    clock.now = start + 60
    await (await get('/prices/intraday/AAPL')).body?.cancel()
    assert.equal(source.calls.length, 2)
  })

  it('answers 503 unavailable on any other upstream error', async () => {
    const source = new FakeSource()
    source.answer = () => Promise.reject(new Error('socket hang up'))
    const { get } = await serve(utc('2026-10-13T15:00:00Z'), source)

    const response = await get('/prices/intraday/AAPL')
    assert.equal(response.status, 503)
    assert.deepEqual(await response.json(), { error: 'unavailable' })
    const health = await get('/healthz')
    assert.equal(health.status, 200, 'the server keeps serving')
    await health.body?.cancel()
  })

  it('recovers once the upstream answers again after the 60 s', async () => {
    const source = new FakeSource()
    const working = source.answer
    source.answer = () => Promise.reject(new PriceSourceError('http', 'answered 500'))
    const start = utc('2026-10-13T15:00:00Z')
    const { clock, get } = await serve(start, source)

    await (await get('/prices/intraday/AAPL')).body?.cancel()
    source.answer = working
    clock.now = start + 60
    const series = await seriesOf(await get('/prices/intraday/AAPL'))
    assert.ok(series.points.length > 0)
  })
})
