import type { IntradayPoint, IntradayPriceProvider } from '@meridian/price-providers'

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

export function createIntradayService(options: IntradayServiceOptions): IntradayService {
  return {
    async get(ticker) {
      throw new Error(`intraday service not implemented (${ticker}, ${options.tickers.length})`)
    },
  }
}
