import { relayConfidence } from './confidence.js'
import { PriceSourceError } from './errors.js'
import { isRecord, malformed } from './parse.js'
import { REGULAR_CLOSE_SECS, REGULAR_OPEN_SECS, newYorkDay, newYorkMidnight } from './time.js'
import type {
  IntradayPoint,
  IntradayPriceProvider,
  LivePriceProvider,
  NormalizedPrice,
  PreviousClose,
  PriceProvider,
  SettlementInputs,
} from './types.js'
import { toNormalized } from './yahoo.js'

/** Alpaca's market-data REST API. */
export const ALPACA_REST_URL = 'https://data.alpaca.markets'

/** The free plan's real-time stream: one exchange (IEX). */
export const ALPACA_STREAM_URL = 'wss://stream.data.alpaca.markets/v2/iex'

/** The Markets page tickers, which the source subscribes to unless told otherwise. */
export const ALPACA_DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA']

/** An Alpaca key pair. Never logged, and never part of a URL or an error message. */
export interface AlpacaCredentials {
  keyId: string
  secretKey: string
}

function setting(env: Record<string, string | undefined>, name: string): string | undefined {
  return env[name]?.trim() || undefined
}

/**
 * Reads `ALPACA_API_KEY` and `ALPACA_API_SECRET`. Throws an Error naming every missing variable
 * (never their values) when either is unset or blank.
 */
export function alpacaCredentialsFromEnv(
  env: Record<string, string | undefined>,
): AlpacaCredentials {
  const keyId = setting(env, 'ALPACA_API_KEY')
  const secretKey = setting(env, 'ALPACA_API_SECRET')
  if (keyId === undefined || secretKey === undefined) {
    const missing = [
      keyId === undefined ? 'ALPACA_API_KEY' : null,
      secretKey === undefined ? 'ALPACA_API_SECRET' : null,
    ].filter(Boolean)
    throw new Error(`the alpaca relay source needs ${missing.join(' and ')} to be set`)
  }
  return { keyId, secretKey }
}

/** Everything the Alpaca source reads from env. */
export interface AlpacaEnvConfig extends AlpacaCredentials {
  /** Market-data REST base URL, without a path: `ALPACA_DATA_URL`, else `ALPACA_API_ENDPOINT` when it is a data host, else `ALPACA_REST_URL`. */
  restUrl: string
  /** `ALPACA_STREAM_URL`, else `ALPACA_STREAM_URL`'s default. */
  streamUrl: string
}

function urlSetting(
  env: Record<string, string | undefined>,
  name: string,
  protocols: readonly string[],
): URL | undefined {
  const value = setting(env, name)
  if (value === undefined) return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} is not a valid URL`)
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(`${name} must be a ${protocols.join(' or ')} URL, not ${url.protocol}`)
  }
  return url
}

/**
 * Reads the credentials (as `alpacaCredentialsFromEnv`) and the optional URLs. `ALPACA_API_ENDPOINT`
 * is usually the trading API (paper or live), which market data never uses; it only counts when it
 * names a market-data host. Throws an Error naming the variable when a set URL is invalid.
 */
export function alpacaConfigFromEnv(env: Record<string, string | undefined>): AlpacaEnvConfig {
  const credentials = alpacaCredentialsFromEnv(env)
  const http = ['https:', 'http:']
  const dataUrl = urlSetting(env, 'ALPACA_DATA_URL', http)
  const endpoint = urlSetting(env, 'ALPACA_API_ENDPOINT', http)
  const streamUrl = urlSetting(env, 'ALPACA_STREAM_URL', ['wss:', 'ws:'])
  const dataEndpoint = endpoint?.hostname.startsWith('data.') ? endpoint : undefined
  return {
    ...credentials,
    restUrl: (dataUrl ?? dataEndpoint)?.origin ?? ALPACA_REST_URL,
    streamUrl: streamUrl?.href.replace(/\/$/, '') ?? ALPACA_STREAM_URL,
  }
}

/** Reconnect delays after the stream drops: they grow from `initialMs` and never pass `maxMs`. */
export interface AlpacaReconnectOptions {
  initialMs: number
  maxMs: number
}

export type AlpacaStreamEvent =
  | { type: 'authenticated' }
  | { type: 'subscribed'; trades: string[]; quotes: string[] }
  | { type: 'disconnected' }
  | { type: 'reconnecting'; attempt: number; delayMs: number }
  | { type: 'error'; message: string }

export interface AlpacaStreamOptions extends AlpacaCredentials {
  tickers: readonly string[]
  /** Defaults to `ALPACA_STREAM_URL`. */
  url?: string
  /** Injected for tests. Defaults to the global WebSocket. */
  WebSocket?: typeof WebSocket
  reconnect?: AlpacaReconnectOptions
  onEvent?: (event: AlpacaStreamEvent) => void
}

/** The latest trade the stream has seen for a ticker, with the latest quote when there is one. */
export interface AlpacaStreamPrice {
  ticker: string
  /** Trade price in USD. */
  price: number
  /** Trade time, Unix seconds (fractional). */
  time: number
  bid?: number
  ask?: number
}

export interface AlpacaStream {
  /** Opens the connection, authenticates and subscribes to trades and quotes for `tickers`. */
  start(): void
  /** Closes the connection and cancels any pending reconnect. */
  close(): void
  /** True while the connection is authenticated and subscribed. */
  readonly ready: boolean
  latest(ticker: string): AlpacaStreamPrice | null
}

/** One second to start with, then doubling up to a minute: a bad key can't hammer the server. */
const DEFAULT_RECONNECT: AlpacaReconnectOptions = { initialMs: 1000, maxMs: 60_000 }

/** Unix seconds of an RFC 3339 time, or null when it doesn't parse. */
function unixOf(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms / 1000 : null
}

function isPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Whether `ts` falls in its own New York day's regular session, 09:30 up to (not including)
 * 16:00 ET. The 16:00 minute is after-hours trading; early closes are not modelled.
 */
function inRegularHours(ts: number): boolean {
  const midnight = newYorkMidnight(ts)
  return ts >= midnight + REGULAR_OPEN_SECS && ts < midnight + REGULAR_CLOSE_SECS
}

/** A websocket client for Alpaca's market-data stream with bounded-backoff reconnects. */
export function createAlpacaStream(options: AlpacaStreamOptions): AlpacaStream {
  const Socket = options.WebSocket ?? globalThis.WebSocket
  const url = options.url ?? ALPACA_STREAM_URL
  const reconnect = options.reconnect ?? DEFAULT_RECONNECT
  const emit = options.onEvent ?? (() => undefined)
  const trades = new Map<string, { price: number; time: number }>()
  const quotes = new Map<string, { bid: number; ask: number }>()
  let socket: WebSocket | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let closed = false
  let ready = false
  /** Reconnect attempts since the last successful subscribe. */
  let attempt = 0

  function send(message: Record<string, unknown>) {
    socket?.send(JSON.stringify(message))
  }

  function onTrade(message: Record<string, unknown>) {
    const ticker = String(message.S)
    const time = unixOf(message.t)
    if (!isPrice(message.p) || time === null || !inRegularHours(time)) return
    const previous = trades.get(ticker)
    if (previous && previous.time > time) return
    trades.set(ticker, { price: message.p, time })
  }

  function onQuote(message: Record<string, unknown>) {
    if (!isPrice(message.bp) || !isPrice(message.ap)) return
    quotes.set(String(message.S), { bid: message.bp, ask: message.ap })
  }

  function onMessage(message: Record<string, unknown>) {
    switch (message.T) {
      case 't':
        return onTrade(message)
      case 'q':
        return onQuote(message)
      case 'success':
        if (message.msg === 'connected') {
          send({ action: 'auth', key: options.keyId, secret: options.secretKey })
        } else if (message.msg === 'authenticated') {
          emit({ type: 'authenticated' })
          send({ action: 'subscribe', trades: [...options.tickers], quotes: [...options.tickers] })
        }
        return
      case 'subscription': {
        ready = true
        attempt = 0
        const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : [])
        emit({ type: 'subscribed', trades: list(message.trades), quotes: list(message.quotes) })
        return
      }
      case 'error':
        // Alpaca's error messages carry a code and a short text, never the credentials.
        emit({
          type: 'error',
          message: `stream error ${String(message.code)}: ${String(message.msg)}`,
        })
        return
      default:
    }
  }

  function onData(data: unknown) {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(data))
    } catch {
      emit({ type: 'error', message: 'stream sent invalid JSON' })
      return
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed]
    messages.filter(isRecord).forEach(onMessage)
  }

  function scheduleReconnect() {
    attempt += 1
    const delayMs = Math.min(reconnect.maxMs, reconnect.initialMs * 2 ** (attempt - 1))
    emit({ type: 'reconnecting', attempt, delayMs })
    timer = setTimeout(() => {
      timer = null
      connect()
    }, delayMs)
  }

  /** Node's WebSocket fires `error` without `close` on a refused connection, so both land here. */
  function onDrop(dropped: WebSocket) {
    if (dropped !== socket) return
    socket = null
    ready = false
    // Closing an errored socket fires `error` again, which the guard above ignores.
    dropped.close()
    emit({ type: 'disconnected' })
    if (!closed) scheduleReconnect()
  }

  function connect() {
    if (closed) return
    let next: WebSocket
    try {
      next = new Socket(url)
    } catch (error) {
      emit({ type: 'error', message: `stream connection failed: ${(error as Error).message}` })
      scheduleReconnect()
      return
    }
    socket = next
    next.addEventListener('message', (event) => onData(event.data))
    next.addEventListener('close', () => onDrop(next))
    next.addEventListener('error', () => onDrop(next))
  }

  return {
    start() {
      if (started) return
      started = true
      connect()
    },
    close() {
      closed = true
      ready = false
      if (timer) clearTimeout(timer)
      timer = null
      const open = socket
      socket = null
      open?.close()
    },
    get ready() {
      return ready
    },
    latest(ticker) {
      const trade = trades.get(ticker)
      if (!trade) return null
      return { ticker, ...trade, ...quotes.get(ticker) }
    },
  }
}

export interface AlpacaSourceOptions extends AlpacaCredentials {
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Current Unix time in seconds. Injected for tests. */
  now?: () => number
  /** Per-request timeout. */
  timeoutMs?: number
  /** Defaults to `ALPACA_REST_URL`. */
  restUrl?: string
  /** Defaults to `ALPACA_DEFAULT_TICKERS`. */
  tickers?: readonly string[]
  /** Stream settings; the stream opens on the first `latest` call, never at construction. */
  stream?: Omit<AlpacaStreamOptions, 'keyId' | 'secretKey' | 'tickers'>
}

export type AlpacaSource = PriceProvider &
  LivePriceProvider &
  IntradayPriceProvider & {
    /** Closes the stream, if open. */
    close(): void
  }

type Feed = 'sip' | 'iex'

interface Bar {
  start: number
  open: number
  high: number
  low: number
  close: number
}

const MINUTE = 60
const DAY = 24 * 60 * 60
const DEFAULT_TIMEOUT_MS = 10_000
/** The free plan refuses SIP data newer than 15 minutes; a minute of margin. */
const SIP_DELAY_SECS = 16 * MINUTE
/** After a 429 the source stops calling for 30 s, doubling per consecutive 429 up to 10 min. */
const BACKOFF_BASE_SECS = 30
const BACKOFF_MAX_SECS = 10 * MINUTE
/** Network failures (not HTTP errors) are tried this many times in one call. */
const NETWORK_ATTEMPTS = 3
/** A full session of 1-minute bars fits one page; this bounds a misbehaving `next_page_token`. */
const MAX_PAGES = 10
/** The interpolation window D23 and R33 allow before close. */
const BEFORE_WINDOW_SECS = 300
/** One live tick asks for every ticker within this many seconds, so they share one snapshot. */
const SNAPSHOT_TTL_SECS = 5

interface Answer {
  status: number
  /** The `Retry-After` header in seconds; NaN when absent. */
  retryAfter: number
  text: string
}

/** The free plan's 403 for SIP data newer than about 15 minutes; the caller retries on IEX. */
class SipRefused extends Error {}

function iso(ts: number): string {
  return new Date(ts * 1000).toISOString()
}

function parseBar(value: unknown, ticker: string): Bar {
  const start = isRecord(value) ? unixOf(value.t) : null
  if (!isRecord(value) || start === null || ![value.o, value.h, value.l, value.c].every(isPrice)) {
    throw malformed(`${ticker} bar has the wrong shape`)
  }
  return {
    start,
    open: value.o as number,
    high: value.h as number,
    low: value.l as number,
    close: value.c as number,
  }
}

function barConfidence(bar: Bar): number {
  return relayConfidence({ barHigh: bar.high, barLow: bar.low }) ?? 0
}

/**
 * The 1-minute fallback (D23): the latest bar whose close (stamped `start + 59`) is within 300 s
 * before close, paired with the closing bar's open (stamped `close_ts + 1`). Bars after the
 * closing minute are never used, so a missing closing bar gives no pair.
 */
function barPair(bars: Bar[], ticker: string, closeTs: number): NormalizedPrice[] | null {
  const before = bars
    .filter((bar) => {
      const stamp = bar.start + MINUTE - 1
      return stamp < closeTs && stamp >= closeTs - BEFORE_WINDOW_SECS
    })
    .reduce<Bar | null>((latest, bar) => (latest && latest.start > bar.start ? latest : bar), null)
  const closing = bars.find((bar) => bar.start === closeTs)
  if (!before || !closing) return null
  return [
    toNormalized(ticker, before.close, barConfidence(before), before.start + MINUTE - 1, false),
    toNormalized(ticker, closing.open, barConfidence(closing), closeTs + 1, false),
  ]
}

function snapshotPrice(ticker: string, snapshot: unknown, now: number): NormalizedPrice | null {
  if (!isRecord(snapshot) || !isRecord(snapshot.latestTrade)) return null
  const trade = snapshot.latestTrade
  const time = unixOf(trade.t)
  if (!isPrice(trade.p) || time === null) return null
  if (!inRegularHours(time) || newYorkDay(time) !== newYorkDay(now)) return null
  const quote = isRecord(snapshot.latestQuote) ? snapshot.latestQuote : {}
  const conf =
    isPrice(quote.bp) && isPrice(quote.ap)
      ? (relayConfidence({ bid: quote.bp, ask: quote.ap }) ?? 0)
      : 0
  return toNormalized(ticker, trade.p, conf, Math.floor(time), false)
}

/**
 * Relay source backed by Alpaca market data: live prices from the websocket stream (REST
 * snapshot while it is down), bars, the previous close and settlement inputs from REST.
 */
export function createAlpacaSource(options: AlpacaSourceOptions): AlpacaSource {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const restUrl = options.restUrl ?? ALPACA_REST_URL
  const tickers = options.tickers ?? ALPACA_DEFAULT_TICKERS
  const headers = {
    'APCA-API-KEY-ID': options.keyId,
    'APCA-API-SECRET-KEY': options.secretKey,
    Accept: 'application/json',
  }
  const backoff = { strikes: 0, until: 0 }
  let stream: AlpacaStream | null = null
  /** Set by `close()`: live prices then come from snapshots only, and no stream reopens. */
  let closed = false
  let snapshot: { at: number; body: Promise<Record<string, unknown>> } | null = null

  /** One GET with its body read under the same timeout. */
  async function fetchOnce(url: URL): Promise<Answer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { headers, signal: controller.signal })
      const text = await response.text()
      return {
        status: response.status,
        retryAfter: Number(response.headers.get('retry-after')),
        text,
      }
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new PriceSourceError('timeout', `Alpaca took over ${timeoutMs} ms`)
      }
      throw new PriceSourceError('http', 'Alpaca request failed', { cause })
    } finally {
      clearTimeout(timer)
    }
  }

  async function fetchWithRetry(url: URL, attemptsLeft = NETWORK_ATTEMPTS): Promise<Answer> {
    try {
      return await fetchOnce(url)
    } catch (error) {
      const retry = error instanceof PriceSourceError && error.code === 'http' && attemptsLeft > 1
      if (!retry) throw error
      return fetchWithRetry(url, attemptsLeft - 1)
    }
  }

  function rateLimited(retryAfter: number): PriceSourceError {
    backoff.strikes += 1
    const delay = BACKOFF_BASE_SECS * 2 ** (backoff.strikes - 1)
    const wait = Math.max(delay, Number.isFinite(retryAfter) ? retryAfter : 0)
    backoff.until = now() + Math.min(BACKOFF_MAX_SECS, wait)
    return new PriceSourceError('rate-limited', 'Alpaca answered 429')
  }

  /**
   * One GET of a `/v2/stocks` route: the JSON body, or null on a 404. Repeated 429s back off
   * exponentially across calls, and while backing off the source fails fast without a request.
   * Error messages never include the request headers, which carry the key pair.
   */
  async function get(path: string, params: Record<string, string>): Promise<unknown> {
    if (now() < backoff.until) {
      throw new PriceSourceError('rate-limited', `backing off until ${backoff.until} after 429s`)
    }
    const url = new URL(`/v2/stocks/${path}`, restUrl)
    url.search = new URLSearchParams(params).toString()
    const { status, retryAfter, text } = await fetchWithRetry(url)
    if (status === 429) throw rateLimited(retryAfter)
    if (status === 404) return null
    if (status === 403 && /recent SIP data/i.test(text)) throw new SipRefused()
    if (status === 401 || status === 403) {
      throw new PriceSourceError(
        'unauthorized',
        `Alpaca refused the key pair (HTTP ${status}); check ALPACA_API_KEY and ALPACA_API_SECRET`,
      )
    }
    if (status < 200 || status >= 300)
      throw new PriceSourceError('http', `Alpaca answered ${status}`)
    backoff.strikes = 0
    try {
      return JSON.parse(text) as unknown
    } catch (cause) {
      throw malformed('Alpaca sent invalid JSON', cause)
    }
  }

  /** `ticker`'s bars from `start` to `end` (inclusive), following a bounded number of pages. */
  async function bars(
    ticker: string,
    timeframe: '1Min' | '1Day',
    feed: Feed,
    start: number,
    end: number,
  ): Promise<Bar[]> {
    const collected: Bar[] = []
    let pageToken: string | null = null
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params: Record<string, string> = {
        symbols: ticker,
        timeframe,
        start: iso(start),
        end: iso(end),
        feed,
        adjustment: 'raw',
        limit: '10000',
      }
      if (pageToken) params.page_token = pageToken
      const body = await get('bars', params)
      if (body === null) break
      if (!isRecord(body)) throw malformed('Alpaca bars response is not an object')
      const list = isRecord(body.bars) ? body.bars[ticker] : undefined
      if (list !== undefined && !Array.isArray(list))
        throw malformed(`${ticker} bars are not a list`)
      collected.push(...(list ?? []).map((entry) => parseBar(entry, ticker)))
      pageToken = typeof body.next_page_token === 'string' ? body.next_page_token : null
      if (!pageToken) break
    }
    return collected
  }

  /** SIP bars, or IEX bars when the free plan refuses SIP for this window. */
  async function barsAnyFeed(
    ticker: string,
    timeframe: '1Min' | '1Day',
    start: number,
    end: number,
  ): Promise<Bar[]> {
    const preferred: Feed = end <= now() - SIP_DELAY_SECS ? 'sip' : 'iex'
    try {
      return await bars(ticker, timeframe, preferred, start, end)
    } catch (error) {
      if (!(error instanceof SipRefused)) throw error
      return bars(ticker, timeframe, 'iex', start, end)
    }
  }

  /** The SIP daily bar for the day of `closeTs`, or null while SIP is refused or has none. */
  async function officialClose(ticker: string, closeTs: number): Promise<NormalizedPrice | null> {
    const midnight = newYorkMidnight(closeTs)
    try {
      const daily = await bars(ticker, '1Day', 'sip', midnight, closeTs)
      const bar = daily.find((entry) => newYorkDay(entry.start) === newYorkDay(closeTs))
      return bar ? toNormalized(ticker, bar.close, 0, closeTs, true) : null
    } catch (error) {
      if (error instanceof SipRefused) return null
      throw error
    }
  }

  function snapshots(): Promise<Record<string, unknown>> {
    const at = now()
    if (snapshot && at - snapshot.at < SNAPSHOT_TTL_SECS) return snapshot.body
    const body = get('snapshots', { symbols: tickers.join(','), feed: 'iex' }).then((value) =>
      isRecord(value) ? value : {},
    )
    // A failed snapshot is not reused: the next tick asks again (subject to the 429 backoff).
    body.catch(() => {
      if (snapshot?.body === body) snapshot = null
    })
    snapshot = { at, body }
    return body
  }

  function liveStream(): AlpacaStream | null {
    if (!stream && !closed) {
      stream = createAlpacaStream({
        ...options.stream,
        keyId: options.keyId,
        secretKey: options.secretKey,
        tickers,
      })
      stream.start()
    }
    return stream
  }

  return {
    name: 'alpaca',

    async prepareClose(ticker, closeTs): Promise<SettlementInputs | null> {
      if (now() < closeTs) return null
      const official = await officialClose(ticker, closeTs)
      if (official) return { ticker, closeTs, updates: [official] }
      const minutes = await barsAnyFeed(ticker, '1Min', closeTs - BEFORE_WINDOW_SECS, closeTs)
      const updates = barPair(minutes, ticker, closeTs)
      return updates ? { ticker, closeTs, updates } : null
    },

    async previousClose(ticker, previousTradingDay): Promise<PreviousClose> {
      // Two weeks back covers any run of holidays; the end stays outside the SIP delay.
      const dayStart = Date.parse(`${previousTradingDay}T00:00:00Z`) / 1000
      const end = now() - SIP_DELAY_SECS
      let daily: Bar[]
      try {
        daily = await bars(ticker, '1Day', 'sip', dayStart - 14 * DAY, end)
      } catch (error) {
        if (!(error instanceof SipRefused)) throw error
        throw new PriceSourceError('stale', `${ticker}: SIP daily bars are not available yet`)
      }
      const closes = daily
        .filter((bar) => newYorkMidnight(bar.start) + REGULAR_CLOSE_SECS <= now())
        .map((bar) => ({ tradingDay: newYorkDay(bar.start), price: bar.close }))
      const match = closes.find((close) => close.tradingDay === previousTradingDay)
      if (match) return { ticker, price: match.price, tradingDay: previousTradingDay }
      const latest = closes.at(-1)?.tradingDay
      if (latest === undefined || latest < previousTradingDay) {
        throw new PriceSourceError(
          'stale',
          `${ticker}: latest daily close is ${latest ?? 'missing'}, expected ${previousTradingDay}`,
        )
      }
      throw new PriceSourceError(
        'not-found',
        `${ticker}: no daily close dated ${previousTradingDay}`,
      )
    },

    async latest(ticker) {
      const live = liveStream()
      const at = now()
      const streamed = live?.ready ? live.latest(ticker) : null
      if (streamed && newYorkDay(streamed.time) === newYorkDay(at)) {
        const conf = relayConfidence({ bid: streamed.bid, ask: streamed.ask }) ?? 0
        return toNormalized(ticker, streamed.price, conf, Math.floor(streamed.time), false)
      }
      return snapshotPrice(ticker, (await snapshots())[ticker], at)
    },

    async intraday(ticker, fromTs, toTs): Promise<IntradayPoint[]> {
      const minutes = await barsAnyFeed(ticker, '1Min', fromTs, toTs)
      return minutes
        .filter((bar) => bar.start >= fromTs && bar.start <= toTs && inRegularHours(bar.start))
        .sort((a, b) => a.start - b.start)
        .map((bar) => ({ t: bar.start, price: bar.close }))
    },

    close() {
      closed = true
      stream?.close()
      stream = null
    },
  }
}
