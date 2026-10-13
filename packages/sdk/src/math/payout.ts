import type { ClosingPrice } from './closing-price.js'

/** USDC base units paid per winning token ($1.00). */
export const PAYOUT_UNIT = 1_000_000n

/** A market strike, `value × 10^expo`. */
export interface Strike {
  value: bigint
  expo: number
}

export type Outcome = 'Yes' | 'No'
export type Side = 'Yes' | 'No'

/**
 * Yes wins when the closing price is at or above the strike, compared exactly by
 * cross-multiplication with no division. Throws `ClosingPriceError('ExpoMismatch')` when the
 * scales differ.
 */
export function settleOutcome(closing: ClosingPrice, strike: Strike): Outcome {
  void [closing, strike]
  throw new Error('settleOutcome is not implemented')
}

/** USDC base units paid per token of `side` once the market settled with `outcome`. */
export function payoutPerToken(outcome: Outcome, side: Side): bigint {
  void [outcome, side]
  throw new Error('payoutPerToken is not implemented')
}
