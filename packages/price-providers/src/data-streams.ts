import { notImplemented } from './errors.js'

export interface DataStreamsOptions {
  /** REST API base URL, without a trailing slash. */
  baseUrl: string
  /** The API user ID, sent as `Authorization`. */
  username: string
  /** The HMAC secret that signs each request. */
  secret: string
  /** Stream ID per ticker: 64 hex digits, with or without `0x`. */
  streamIds: Readonly<Record<string, string>>
  fetch?: typeof fetch
  /** Milliseconds; stamps `X-Authorization-Timestamp`. Defaults to `Date.now`. */
  now?: () => number
}

/** One ticker's signed Data Streams reports at a close. */
export interface DataStreamsCloseReports {
  ticker: string
  closeTs: number
  /** Each report's `fullReport`, decoded from hex, as `settle_market_with_reports` takes it. */
  fullReports: Uint8Array[]
}

export interface DataStreamsClient {
  readonly name: string
  /**
   * `GET /api/v1/reports?feedID=…&timestamp={closeTs}`, HMAC-signed: the report at `closeTs`, or
   * null when there is none for that time yet (404).
   */
  reportsAt(ticker: string, closeTs: number): Promise<DataStreamsCloseReports | null>
}

/** Fetches signed reports from the Data Streams REST API. */
export function createDataStreamsClient(options: DataStreamsOptions): DataStreamsClient {
  return {
    name: 'chainlink',
    reportsAt: (ticker, closeTs) => notImplemented(options, ticker, closeTs),
  }
}
