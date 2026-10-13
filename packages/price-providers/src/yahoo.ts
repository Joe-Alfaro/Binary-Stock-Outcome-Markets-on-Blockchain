import { notImplemented } from './errors.js'
import type { PriceProvider } from './types.js'

export interface YahooSourceOptions {
  /** Injected for tests. Defaults to the global fetch. */
  fetch?: typeof fetch
  /** Per-request timeout. */
  timeoutMs?: number
  /** Current Unix time in seconds. Injected for tests. */
  now?: () => number
}

/** Relay source backed by the keyless Yahoo Finance chart API. */
export function createYahooSource(options: YahooSourceOptions = {}): PriceProvider {
  return notImplemented(options)
}
