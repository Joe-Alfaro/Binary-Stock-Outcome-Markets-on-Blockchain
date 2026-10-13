import { notImplemented } from './errors.js'
import type { PriceProvider, SettlementInputs } from './types.js'

export interface PythHermesOptions {
  /** Hermes base URL, without a trailing slash. */
  baseUrl: string
  /** Sent with every request. */
  accessToken: string
  /** Feed ID per ticker: 64 hex digits, with or without `0x`. */
  feedIds: Readonly<Record<string, string>>
  fetch?: typeof fetch
}

/** One ticker's Hermes update at a close: the normalized prices and the signed update data. */
export interface PythCloseUpdate extends SettlementInputs {
  /** The feed ID the update is for: 64 lowercase hex digits, no `0x`. */
  feedId: string
  /**
   * The signed accumulator update data from the response's `binary.data`, decoded from hex, as
   * the receiver program takes it when posting `PriceUpdateV2` accounts.
   */
  binary: Uint8Array[]
}

export interface PythHermesProvider extends PriceProvider {
  /**
   * `GET /v2/updates/price/{closeTs}` for the ticker's feed: the update published at `closeTs`, or
   * null when Hermes has none for that time yet (404).
   */
  prepareClose(ticker: string, closeTs: number): Promise<PythCloseUpdate | null>
}

/** A Pyth `PriceProvider` that reads Hermes over HTTP. */
export function createPythHermesProvider(options: PythHermesOptions): PythHermesProvider {
  return {
    name: 'pyth',
    prepareClose: (ticker, closeTs) => notImplemented(options, ticker, closeTs),
    previousClose: (ticker, previousTradingDay) =>
      notImplemented(options, ticker, previousTradingDay),
  }
}
