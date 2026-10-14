import { notImplemented } from './errors.js'
import type { IntradayPriceProvider, LivePriceProvider, PriceProvider } from './types.js'

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

/**
 * Reads `ALPACA_API_KEY` and `ALPACA_API_SECRET`. Throws an Error naming every missing variable
 * (never their values) when either is unset or blank.
 */
export function alpacaCredentialsFromEnv(
  env: Record<string, string | undefined>,
): AlpacaCredentials {
  return notImplemented(env)
}

/** Everything the Alpaca source reads from env. */
export interface AlpacaEnvConfig extends AlpacaCredentials {
  /** Market-data REST base URL, without a path: `ALPACA_DATA_URL`, else `ALPACA_API_ENDPOINT` when it is a data host, else `ALPACA_REST_URL`. */
  restUrl: string
  /** `ALPACA_STREAM_URL`, else `ALPACA_STREAM_URL`'s default. */
  streamUrl: string
}

/**
 * Reads the credentials (as `alpacaCredentialsFromEnv`) and the optional URLs. `ALPACA_API_ENDPOINT`
 * is usually the trading API (paper or live), which market data never uses; it only counts when it
 * names a market-data host. Throws an Error naming the variable when a set URL is invalid.
 */
export function alpacaConfigFromEnv(env: Record<string, string | undefined>): AlpacaEnvConfig {
  return notImplemented(env)
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

/** A websocket client for Alpaca's market-data stream with bounded-backoff reconnects. */
export function createAlpacaStream(options: AlpacaStreamOptions): AlpacaStream {
  return notImplemented(options)
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

/**
 * Relay source backed by Alpaca market data: live prices from the websocket stream (REST
 * snapshot while it is down), bars, the previous close and settlement inputs from REST.
 */
export function createAlpacaSource(options: AlpacaSourceOptions): AlpacaSource {
  return notImplemented(options)
}
