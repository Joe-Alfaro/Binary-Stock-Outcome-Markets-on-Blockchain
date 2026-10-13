import type { Ticker } from './chain'

/** How often a card refreshes its chart while the session is open (R66). */
export const INTRADAY_REFRESH_MS = 60_000

export interface IntradayPoint {
  /** Bar start, Unix seconds. */
  t: number
  /** Price in USD. */
  price: number
}

/** One session's series from the worker's `GET /prices/intraday/<ticker>`. */
export interface IntradaySeries {
  ticker: Ticker
  /** True while the session is open: the series runs from the open to now. */
  live: boolean
  /** The session's trading day, `YYYY-MM-DD` in America/New_York. */
  sessionDate: string
  openTs: number
  endTs: number
  earlyClose: boolean
  /** Oldest first. The first point is the open, the last the latest or closing price. */
  points: IntradayPoint[]
}

/** Reads the Markets chart's series from the worker. Never calls a market-data provider. */
export interface IntradayClient {
  /** Rejects when the worker is unreachable, unset or answers an error. */
  get(ticker: Ticker): Promise<IntradaySeries>
}

/**
 * The client for the worker at `baseUrl` (`NEXT_PUBLIC_PRICE_API_URL`). With no URL every request
 * rejects, so the cards show "Chart unavailable".
 */
export function createIntradayClient(
  baseUrl: string | undefined,
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): IntradayClient {
  return {
    async get(ticker) {
      throw new Error(
        `intraday client not implemented (${ticker}, ${baseUrl}, ${typeof fetchImpl})`,
      )
    },
  }
}
