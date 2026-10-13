import type { NormalizedPrice } from './price.js'

/** Market-level inputs to the closing-price rule. */
export interface SettlementParams {
  /** The market's ticker. Every update must match it. */
  ticker: string
  /**
   * The market close (4:00 PM ET, or 1:00 PM ET on early-close days). Staleness and the
   * interpolation window are measured against this, never against `settleTs`.
   */
  closeTs: number
  /** When the settle transaction lands. It must not affect which prices are accepted. */
  settleTs: number
  /**
   * An update is stale when `|publishTime − closeTs| > maxStalenessSecs` (default 300). This is
   * also the interpolation window.
   */
  maxStalenessSecs: number
  /** An update is rejected when `conf / price > maxConfBps / 10_000`. */
  maxConfBps: number
}

export type ClosingShape = 'OfficialClose' | 'ExactTimestamp' | 'Interpolated'

/** The closing price as an exact rational, `numerator / denominator`, scaled by `10^expo`. */
export interface ClosingPrice {
  shape: ClosingShape
  expo: number
  numerator: bigint
  /** Always positive. 1n for the official-close and exact-timestamp shapes. */
  denominator: bigint
  /** The value rounded to `expo`, stored as the market's `settle_price` for display only. */
  settlePrice: bigint
}

export type ClosingPriceErrorCode =
  | 'WrongTicker'
  | 'NonPositivePrice'
  | 'OutsideRegularSession'
  | 'ConfidenceTooWide'
  | 'Stale'
  | 'ExpoMismatch'
  | 'NoValidShape'

export class ClosingPriceError extends Error {
  readonly code: ClosingPriceErrorCode

  constructor(code: ClosingPriceErrorCode) {
    super(`Closing price rejected: ${code}`)
    this.name = 'ClosingPriceError'
    this.code = code
  }
}

/**
 * Applies the closing-price rule. Every update passed in is validated, in this order: ticker,
 * positive price, regular session, confidence, staleness against `closeTs`, then a shared
 * exponent across updates. Any invalid update throws a `ClosingPriceError`. Then the shapes are
 * tried in order: official close, exact timestamp, interpolation between the nearest update on
 * each side of close.
 */
export function closingPrice(
  updates: readonly NormalizedPrice[],
  params: SettlementParams,
): ClosingPrice {
  void [updates, params]
  throw new Error('closingPrice is not implemented')
}
