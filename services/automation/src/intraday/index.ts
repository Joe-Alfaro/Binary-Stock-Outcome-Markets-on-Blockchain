import { PriceSourceError } from '@meridian/price-providers'
import type { IntradayPoint, IntradayPriceProvider } from '@meridian/price-providers'
import { chartSession } from '../calendar/chart-session.js'

/** At most one upstream request per ticker per this many seconds, successful or not (R66). */
export const INTRADAY_CACHE_SECS = 60

/** The body of a successful `GET /prices/intraday/<ticker>`. */
export interface IntradaySeries {
  ticker: string
  /** True while the session is open; the series then runs from the open to the fetch time. */
  live: boolean
  /** The session's trading day, `YYYY-MM-DD` in America/New_York. */
  sessionDate: string
  openTs: number
  endTs: number
  earlyClose: boolean
  /** 1-minute closes with `openTs <= t <= endTs`, oldest first. */
  points: IntradayPoint[]
}

/** Error codes in the body of a failed request: `{ "error": <code> }`. */
export type IntradayErrorCode = 'unknown-ticker' | 'rate-limited' | 'unavailable'

export type IntradayResult =
  { ok: true; series: IntradaySeries } | { ok: false; status: 404 | 503; error: IntradayErrorCode }

export interface IntradayServiceOptions {
  source: Pick<IntradayPriceProvider, 'intraday'>
  /** The tickers the route serves; any other answers 404 without an upstream request. */
  tickers: readonly string[]
  /** Current Unix time in seconds. */
  now: () => number
}

/** The cached intraday series behind the worker's read-only price route. */
export interface IntradayService {
  get(ticker: string): Promise<IntradayResult>
}

interface CacheEntry {
  fetchedAt: number
  result: Promise<IntradayResult>
}

const UNAVAILABLE: IntradayResult = { ok: false, status: 503, error: 'unavailable' }

function failureOf(error: unknown): IntradayResult {
  if (error instanceof PriceSourceError && error.code === 'rate-limited') {
    return { ok: false, status: 503, error: 'rate-limited' }
  }
  return UNAVAILABLE
}

export function createIntradayService(options: IntradayServiceOptions): IntradayService {
  const { source, now } = options
  const tickers = new Set(options.tickers)
  const cache = new Map<string, CacheEntry>()

  async function fetchSeries(ticker: string, at: number): Promise<IntradayResult> {
    const session = chartSession(at)
    if (session === null) return UNAVAILABLE
    try {
      const points = await source.intraday(ticker, session.openTs, session.endTs)
      return {
        ok: true,
        series: {
          ticker,
          live: session.live,
          sessionDate: session.date,
          openTs: session.openTs,
          endTs: session.endTs,
          earlyClose: session.earlyClose,
          points: points.filter((p) => p.t >= session.openTs && p.t <= session.endTs),
        },
      }
    } catch (error) {
      return failureOf(error)
    }
  }

  return {
    async get(ticker) {
      if (!tickers.has(ticker)) return { ok: false, status: 404, error: 'unknown-ticker' }
      const at = now()
      const cached = cache.get(ticker)
      if (cached && at - cached.fetchedAt < INTRADAY_CACHE_SECS) return cached.result
      // Cache the pending promise so concurrent requests share one upstream call.
      const result = fetchSeries(ticker, at)
      cache.set(ticker, { fetchedAt: at, result })
      return result
    },
  }
}
