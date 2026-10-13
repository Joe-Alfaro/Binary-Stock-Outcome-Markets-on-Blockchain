import { ClosingPriceError, type ClosingPrice } from './closing-price.js'

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
  if (closing.expo !== strike.expo) throw new ClosingPriceError('ExpoMismatch')
  return closing.numerator >= strike.value * closing.denominator ? 'Yes' : 'No'
}

/** USDC base units paid per token of `side` once the market settled with `outcome`. */
export function payoutPerToken(outcome: Outcome, side: Side): bigint {
  return outcome === side ? PAYOUT_UNIT : 0n
}
