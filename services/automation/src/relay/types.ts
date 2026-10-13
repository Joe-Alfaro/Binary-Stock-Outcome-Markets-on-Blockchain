import type { NormalizedPrice, PriceProvider } from '@meridian/price-providers'
import type { LineWriter } from '../alerts/index.js'

/** Wall clock and timer, injected so tests can run a whole trading day instantly. */
export interface Clock {
  /** Unix seconds. */
  now(): number
  /** Resolves after `seconds`. Fake clocks advance `now()` by that much. */
  sleep(seconds: number): Promise<void>
}

/** Which closing-price shape a close record holds. */
export type CloseShape = 'official' | 'exact' | 'interpolation'

/** One close record request: the updates that form the shape, in publish-time order. */
export interface CloseRequest {
  ticker: string
  /** `YYYYMMDD`, the `trading_day` seed of the `CloseRecord` PDA. */
  tradingDay: number
  closeTs: number
  updates: NormalizedPrice[]
}

/**
 * The relay's view of the `meridian_oracle` program, bound to one relay signer key. Each method
 * sends one transaction and resolves to its signature.
 */
export interface OracleClient {
  /** Base58 public key of this relay's own signer. */
  readonly signer: string
  /** Whether this signer's `PriceUpdate` at `["price", signer, ticker, publishTime]` exists. */
  priceUpdateExists(ticker: string, publishTime: number): Promise<boolean>
  /** Whether this signer's `CloseRecord` at `["close", signer, ticker, tradingDay]` exists. */
  closeRecordExists(ticker: string, tradingDay: number): Promise<boolean>
  /** `publish_price`: one append-only `PriceUpdate`. */
  publishPrice(update: NormalizedPrice): Promise<string>
  /** `publish_close`: the write-once `CloseRecord` from already-published updates. */
  publishClose(request: CloseRequest): Promise<string>
  /** `publish_latest` for every given ticker, in one transaction. */
  publishLatest(updates: NormalizedPrice[]): Promise<string>
}

/** A source of the current regular-session price, for the display-only latest-price accounts. */
export interface LivePriceSource {
  readonly name: string
  /** The latest regular-session price, or null when the source has none. */
  latest(ticker: string): Promise<NormalizedPrice | null>
}

export interface RelayPublisherOptions {
  oracle: OracleClient
  /** The configured relay source for settlement inputs (`RELAY_<n>_SOURCE`). */
  source: PriceProvider
  /** Source for live prices. Required for `publishLatest` and `runLive`. */
  live?: LivePriceSource
  tickers: readonly string[]
  clock: Clock
  /** Receives one JSON line per log entry. */
  log: LineWriter
  /**
   * Demo mode: replays a recorded close re-stamped to the demo `close_ts`, labeled
   * `replayed: true` in every log line. Only the `mock` source is allowed.
   */
  demo?: boolean
}

export type CloseStatus =
  /** Published the updates and the close record in this call. */
  | 'published'
  /** The close record already existed; nothing was sent. */
  | 'already-published'
  /** Before `close_ts`; the source was not asked. */
  | 'too-early'
  /** No publishable shape yet, or waiting for the official close. */
  | 'pending'
  /** The source or the oracle failed; retried on the next poll. */
  | 'error'

export interface CloseOutcome {
  ticker: string
  status: CloseStatus
  shape?: CloseShape
}

export type LiveStatus = 'published' | 'closed' | 'error'

export interface LiveOutcome {
  status: LiveStatus
  /** Tickers published in this tick. */
  tickers: string[]
}

export interface RelayPublisher {
  /** One attempt at `ticker`'s close record for `tradingDay` (`YYYY-MM-DD`). */
  publishClose(ticker: string, tradingDay: string, closeTs: number): Promise<CloseOutcome>
  /**
   * Polls every ticker from `closeTs` (sleeping until then if needed) every 30 s until each has a
   * close record or `deadlineTs` passes. One ticker's failure delays no other.
   */
  runCloses(tradingDay: string, closeTs: number, deadlineTs: number): Promise<CloseOutcome[]>
  /** One live-price tick: publishes every ticker's latest price if the regular session is open. */
  publishLatest(): Promise<LiveOutcome>
  /**
   * Runs live-price ticks until `untilTs` or until `signal` aborts, at least every 60 s in regular
   * hours. Stopping by `signal` needs a clock whose `sleep` returns on that abort.
   */
  runLive(untilTs: number, signal?: AbortSignal): Promise<void>
}
