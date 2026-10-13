import { MAX_EXPO, MIN_EXPO } from './price.js'

/** Percentage offsets from the previous close: ±9%, ±6%, ±3% and 0. */
const OFFSETS_PCT = [-9n, -6n, -3n, 0n, 3n, 6n, 9n]

/** A previous close, `price × 10^expo`. */
export interface PrevClose {
  price: bigint
  expo: number
}

/**
 * Strikes for one ticker and day, in whole dollars: `round_to_10(prev × (1 ± p))` for
 * p ∈ {3%, 6%, 9%} plus `round_to_10(prev)`, deduplicated and sorted ascending. Halves round up.
 * Integer math only, so no binary floating-point error. Mirrors `compute_strikes` in
 * `crates/meridian-math`.
 *
 * Returns no strikes for a non-positive price or an exponent outside `MIN_EXPO..MAX_EXPO`, and
 * drops any strike that rounds to $0.
 */
export function computeStrikes(prevClose: PrevClose): bigint[] {
  const { price, expo } = prevClose
  if (price <= 0n || expo < MIN_EXPO || expo > MAX_EXPO) return []
  // price × (100 + pct) / 100 is in units of 10^expo dollars; dividing by 10 × 100 × 10^−expo
  // gives tens of dollars.
  const divisor = 1_000n * 10n ** BigInt(-expo)
  const strikes = OFFSETS_PCT.map((pct) => {
    const scaled = price * (100n + pct)
    return ((2n * scaled + divisor) / (2n * divisor)) * 10n
  }).filter((strike) => strike > 0n)
  return [...new Set(strikes)].sort((a, b) => Number(a - b))
}
