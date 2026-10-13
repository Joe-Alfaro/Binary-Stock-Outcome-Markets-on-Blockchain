import { relayConfidence } from './confidence.js'
import { PriceSourceError } from './errors.js'
import type { PriceSourceErrorCode } from './errors.js'
import { isRecord, malformed } from './parse.js'
import {
  REGULAR_CLOSE_SECS,
  REGULAR_OPEN_SECS,
  inRegularSession,
  newYorkDay,
  newYorkMidnight,
} from './time.js'
import type {
  LivePriceProvider,
  NormalizedPrice,
  PreviousClose,
  PriceProvider,
  SettlementInputs,
} from './types.js'

export interface YahooSourceOptions {
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Per-request timeout. */
  timeoutMs?: number
  /** Current Unix time in seconds. Injected for tests. */
  now?: () => number
}

/** query2 serves the same API and is often not throttled when query1 is. */
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'] as const

// The chart API answers 429 to requests without a browser User-Agent.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/141.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

const DEFAULT_TIMEOUT_MS = 10_000

/** After a 429 the source stops calling for 30 s, doubling per consecutive 429 up to 8 min. */
const BACKOFF_BASE_SECS = 30
const BACKOFF_MAX_SECS = 8 * 60

/**
 * Prices are float dollars. 10 decimals keeps the rounding error far below a tenth of a cent
 * for any stock price while staying inside the on-chain exponent range.
 */
const EXPO = -10

const MINUTE = 60
const DAY = 24 * 60 * 60

/** The interpolation window D23 and R33 allow before close. */
const BEFORE_WINDOW_SECS = 300

type Series = (number | null)[]

/** The parts of a v8 chart response the source reads, validated. */
export interface YahooChart {
  symbol: string
  priceHint: number
  regularMarketPrice: number
  regularMarketTime: number
  timestamps: number[]
  open: Series
  high: Series
  low: Series
  close: Series
}

interface Bar {
  start: number
  open: number | null
  high: number | null
  low: number | null
  close: number | null
}

function toFixedPoint(value: number): bigint {
  return BigInt(Math.round(value * 10 ** -EXPO))
}

function parseSeries(value: unknown, field: string): Series {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw malformed(`chart ${field} is not an array`)
  return value.map((entry) => {
    if (entry === null) return null
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry
    throw malformed(`chart ${field} has a non-numeric value: ${String(entry)}`)
  })
}

function chartErrorOf(body: Record<string, unknown>): PriceSourceError | null {
  const chart = body.chart
  if (!isRecord(chart) || !isRecord(chart.error)) return null
  const { code, description } = chart.error
  const message = `chart API error: ${String(code)} ${String(description)}`
  return /not found/i.test(String(code))
    ? new PriceSourceError('not-found', message)
    : malformed(message)
}

/** Validates a v8 chart response for `ticker`. */
export function parseChart(body: unknown, ticker: string): YahooChart {
  if (!isRecord(body)) throw malformed('chart response is not an object')
  const chartError = chartErrorOf(body)
  if (chartError) throw chartError
  const chart = body.chart
  const result = isRecord(chart) && Array.isArray(chart.result) ? chart.result[0] : undefined
  if (!isRecord(result) || !isRecord(result.meta) || !isRecord(result.indicators)) {
    throw malformed('chart response has no result')
  }
  const { meta } = result
  if (typeof meta.symbol !== 'string' || meta.symbol.toUpperCase() !== ticker.toUpperCase()) {
    throw malformed(`chart response is for ${String(meta.symbol)}, not ${ticker}`)
  }
  const { regularMarketPrice, regularMarketTime } = meta
  if (typeof regularMarketPrice !== 'number' || !Number.isFinite(regularMarketPrice)) {
    throw malformed(`regularMarketPrice is not a number: ${String(regularMarketPrice)}`)
  }
  if (typeof regularMarketTime !== 'number' || !Number.isSafeInteger(regularMarketTime)) {
    throw malformed(`regularMarketTime is not a timestamp: ${String(regularMarketTime)}`)
  }
  const quotes = result.indicators.quote
  const quote = Array.isArray(quotes) && isRecord(quotes[0]) ? quotes[0] : {}
  const timestamps = parseSeries(result.timestamp, 'timestamp')
  if (!timestamps.every((ts) => ts !== null && Number.isSafeInteger(ts))) {
    throw malformed('chart timestamps are not all integers')
  }
  return {
    symbol: meta.symbol,
    priceHint: Number.isInteger(meta.priceHint) ? (meta.priceHint as number) : 2,
    regularMarketPrice,
    regularMarketTime,
    timestamps: timestamps as number[],
    open: parseSeries(quote.open, 'open'),
    high: parseSeries(quote.high, 'high'),
    low: parseSeries(quote.low, 'low'),
    close: parseSeries(quote.close, 'close'),
  }
}

function barsOf(chart: YahooChart): Bar[] {
  return chart.timestamps.map((start, i) => ({
    start,
    open: chart.open[i] ?? null,
    high: chart.high[i] ?? null,
    low: chart.low[i] ?? null,
    close: chart.close[i] ?? null,
  }))
}

function barConfidence(bar: Bar): number | null {
  return relayConfidence({ barHigh: bar.high ?? undefined, barLow: bar.low ?? undefined })
}

/** A regular-session price at the source's scale. Dollar values are float. */
export function toNormalized(
  ticker: string,
  price: number,
  conf: number,
  publishTime: number,
  officialClose: boolean,
): NormalizedPrice {
  return {
    ticker,
    price: toFixedPoint(price),
    conf: toFixedPoint(conf),
    expo: EXPO,
    publishTime,
    session: 'regular',
    officialClose,
  }
}

/**
 * The official close: `regularMarketPrice` stamped at or after close, but before the next
 * session opens, so a next-morning quote never counts as this close. Yahoo has no bid/ask on
 * this endpoint and the official close is a single print, so its confidence is zero.
 */
function officialClose(chart: YahooChart, ticker: string, closeTs: number) {
  const nextOpen = newYorkMidnight(closeTs) + DAY + REGULAR_OPEN_SECS
  const { regularMarketPrice: price, regularMarketTime: time } = chart
  if (time < closeTs || time >= nextOpen) return null
  return toNormalized(ticker, price, 0, time, true)
}

/**
 * The 1-minute fallback (D23): the latest regular bar whose close (stamped `start + 59`) is
 * within 300 s before close, paired with the closing bar's open (stamped `close_ts + 1`).
 * Post-market bars are never used, so a missing closing bar gives no pair.
 */
function barPair(chart: YahooChart, ticker: string, closeTs: number) {
  const bars = barsOf(chart)
  const before = bars
    .filter((bar) => {
      const stamp = bar.start + MINUTE - 1
      return stamp < closeTs && stamp >= closeTs - BEFORE_WINDOW_SECS
    })
    .filter((bar) => bar.close !== null && barConfidence(bar) !== null)
    .reduce<Bar | null>((latest, bar) => (latest && latest.start > bar.start ? latest : bar), null)
  const closing = bars.find((bar) => bar.start === closeTs)
  if (!before || !closing || closing.open === null) return null
  const beforeConf = barConfidence(before)
  const closingConf = barConfidence(closing)
  if (before.close === null || beforeConf === null || closingConf === null) return null
  return [
    toNormalized(ticker, before.close, beforeConf, before.start + MINUTE - 1, false),
    toNormalized(ticker, closing.open, closingConf, closeTs + 1, false),
  ]
}

/** The updates to publish for `closeTs` from a 1-minute chart, or null with no valid shape. */
export function closeInputs(
  chart: YahooChart,
  ticker: string,
  closeTs: number,
): SettlementInputs | null {
  const official = officialClose(chart, ticker, closeTs)
  const updates = official ? [official] : barPair(chart, ticker, closeTs)
  return updates ? { ticker, closeTs, updates } : null
}

/**
 * The live price: `regularMarketPrice` at `regularMarketTime`, only while that time is inside
 * today's regular session (09:30 to 16:00 ET on the New York day of `now`). A pre-market or
 * previous-day stamp gives null. Like the official close it has no bid/ask, so confidence is zero.
 */
export function latestPrice(
  chart: YahooChart,
  ticker: string,
  now: number,
): NormalizedPrice | null {
  const { regularMarketPrice: price, regularMarketTime: time } = chart
  if (newYorkDay(time) !== newYorkDay(now) || time > now) return null
  if (!inRegularSession(time, newYorkMidnight(time) + REGULAR_CLOSE_SECS)) return null
  return toNormalized(ticker, price, 0, time, false)
}

/** Daily closes whose session has ended by `now`, oldest first. */
export function completedDailyCloses(chart: YahooChart, now: number) {
  return barsOf(chart)
    .filter((bar) => bar.close !== null && newYorkMidnight(bar.start) + REGULAR_CLOSE_SECS <= now)
    .map((bar) => ({
      tradingDay: newYorkDay(bar.start),
      price: Number((bar.close as number).toFixed(chart.priceHint)),
    }))
}

/** The close dated `tradingDay` from a daily chart. */
export function dailyClose(
  chart: YahooChart,
  ticker: string,
  tradingDay: string,
  now: number,
): PreviousClose {
  const closes = completedDailyCloses(chart, now)
  const match = closes.find((close) => close.tradingDay === tradingDay)
  if (match) return { ticker, price: match.price, tradingDay }
  const latest = closes.at(-1)?.tradingDay
  if (latest === undefined || latest < tradingDay) {
    throw new PriceSourceError(
      'stale',
      `${ticker}: latest daily close is ${latest ?? 'missing'}, expected ${tradingDay}`,
    )
  }
  throw new PriceSourceError('not-found', `${ticker}: no daily close dated ${tradingDay}`)
}

interface FetchFailure {
  error: PriceSourceError
  retryAfterSecs?: number
}

type FetchResult = { body: unknown } | { failure: FetchFailure }

function failed(code: PriceSourceErrorCode, message: string, cause?: unknown): FetchResult {
  return { failure: { error: new PriceSourceError(code, message, { cause }) } }
}

function retryAfterOf(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'))
  return Number.isFinite(value) && value > 0 ? value : undefined
}

async function readResponse(host: string, response: Response): Promise<FetchResult> {
  const text = await response.text()
  if (response.status === 429) {
    const error = new PriceSourceError('rate-limited', `${host} answered 429`)
    return { failure: { error, retryAfterSecs: retryAfterOf(response) } }
  }
  if (response.status === 404) return failed('not-found', `${host} answered 404`)
  if (!response.ok) return failed('http', `${host} answered ${response.status}`)
  try {
    return { body: JSON.parse(text) as unknown }
  } catch (cause) {
    return failed('malformed', `${host} sent invalid JSON`, cause)
  }
}

/** Relay source backed by the keyless Yahoo Finance chart API. */
export function createYahooSource(
  options: YahooSourceOptions = {},
): PriceProvider & LivePriceProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const backoff = { strikes: 0, until: 0 }

  async function requestOnce(host: string, path: string): Promise<FetchResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(`https://${host}${path}`, {
        headers: HEADERS,
        signal: controller.signal,
      })
      return await readResponse(host, response)
    } catch (cause) {
      if (controller.signal.aborted) return failed('timeout', `${host} took over ${timeoutMs} ms`)
      return failed('http', `${host} request failed`, cause)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Tries each host in turn, moving on only for failures another host might not share. */
  async function requestAnyHost(
    path: string,
    hosts: readonly string[],
    failures: FetchFailure[],
  ): Promise<{ body?: unknown; failures: FetchFailure[] }> {
    const [host, ...rest] = hosts
    if (host === undefined) return { failures }
    const result = await requestOnce(host, path)
    if ('body' in result) return { body: result.body, failures }
    const { code } = result.failure.error
    if (code === 'not-found' || code === 'malformed') throw result.failure.error
    return requestAnyHost(path, rest, [...failures, result.failure])
  }

  /**
   * One request per host per call, never a retry loop. Repeated 429s back off exponentially
   * across calls: while backing off the source fails fast without touching the network.
   */
  async function getChart(ticker: string, params: Record<string, string>): Promise<unknown> {
    if (now() < backoff.until) {
      throw new PriceSourceError('rate-limited', `backing off until ${backoff.until} after 429s`)
    }
    const query = new URLSearchParams(params).toString()
    const path = `/v8/finance/chart/${encodeURIComponent(ticker)}?${query}`
    const { body, failures } = await requestAnyHost(path, HOSTS, [])
    if (body !== undefined) {
      backoff.strikes = 0
      return body
    }
    const limited = failures.filter((failure) => failure.error.code === 'rate-limited')
    if (limited.length === 0) throw (failures.at(-1) as FetchFailure).error
    backoff.strikes += 1
    const delay = BACKOFF_BASE_SECS * 2 ** (backoff.strikes - 1)
    const retryAfter = Math.max(0, ...limited.map((failure) => failure.retryAfterSecs ?? 0))
    backoff.until = now() + Math.min(BACKOFF_MAX_SECS, Math.max(delay, retryAfter))
    throw (limited[0] as FetchFailure).error
  }

  return {
    name: 'yahoo',

    async prepareClose(ticker, closeTs) {
      if (now() < closeTs) return null
      const body = await getChart(ticker, {
        interval: '1m',
        period1: String(closeTs - 15 * MINUTE),
        period2: String(closeTs + 15 * MINUTE),
        includePrePost: 'true',
      })
      return closeInputs(parseChart(body, ticker), ticker, closeTs)
    },

    async previousClose(ticker, previousTradingDay) {
      const body = await getChart(ticker, { interval: '1d', range: '5d' })
      return dailyClose(parseChart(body, ticker), ticker, previousTradingDay, now())
    },

    async latest(ticker) {
      // The daily interval keeps the response small; the meta block carries the live quote.
      const body = await getChart(ticker, { interval: '1d', range: '1d' })
      return latestPrice(parseChart(body, ticker), ticker, now())
    },
  }
}
