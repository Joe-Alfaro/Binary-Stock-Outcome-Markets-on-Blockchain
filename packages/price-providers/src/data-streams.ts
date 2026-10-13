import { createHash, createHmac } from 'node:crypto'
import { PriceSourceError } from './errors.js'
import { getJson, hexBytes } from './http.js'
import { isRecord, malformed } from './parse.js'

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

/** The API refuses requests without a User-Agent. */
const USER_AGENT = 'meridian-automation/0.0.0'
const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex')

/**
 * The Data Streams authentication headers: the HMAC-SHA256 of
 * `"<method> <path and query> <sha256 of body> <user ID> <timestamp ms>"`.
 */
function authHeaders(url: URL, options: DataStreamsOptions, timestampMs: number) {
  const timestamp = String(timestampMs)
  const signed = `GET ${url.pathname}${url.search} ${EMPTY_BODY_SHA256} ${options.username} ${timestamp}`
  return {
    Authorization: options.username,
    'X-Authorization-Timestamp': timestamp,
    'X-Authorization-Signature-SHA256': createHmac('sha256', options.secret)
      .update(signed)
      .digest('hex'),
  }
}

function fullReportOf(body: unknown): Uint8Array {
  const report = isRecord(body) ? body.report : undefined
  const fullReport = isRecord(report) ? report.fullReport : undefined
  const bytes = typeof fullReport === 'string' ? hexBytes(fullReport) : null
  if (!bytes || bytes.length === 0) throw malformed('Data Streams response has no fullReport')
  return bytes
}

/** Fetches signed reports from the Data Streams REST API. */
export function createDataStreamsClient(options: DataStreamsOptions): DataStreamsClient {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now

  return {
    name: 'chainlink',

    async reportsAt(ticker, closeTs) {
      const configured = options.streamIds[ticker]
      if (configured === undefined) {
        throw new PriceSourceError(
          'not-found',
          `no Data Streams stream ID configured for ${ticker}`,
        )
      }
      const url = new URL(`${options.baseUrl}/api/v1/reports`)
      url.searchParams.set('feedID', `0x${configured.toLowerCase().replace(/^0x/, '')}`)
      url.searchParams.set('timestamp', String(closeTs))
      const headers = {
        ...authHeaders(url, options, now()),
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      }
      const body = await getJson(url, { fetch: fetchImpl, headers, label: 'Data Streams' })
      if (body === null) return null
      return { ticker, closeTs, fullReports: [fullReportOf(body)] }
    },
  }
}
