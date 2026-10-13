/** A previous close, `price × 10^expo`. */
export interface PrevClose {
  price: bigint
  expo: number
}

/**
 * Strikes for one ticker and day, in whole dollars: `round_to_10(prev × (1 ± p))` for
 * p ∈ {3%, 6%, 9%} plus `round_to_10(prev)`, deduplicated and sorted ascending. Halves round up.
 * Integer math only, so no binary floating-point error.
 */
export function computeStrikes(prevClose: PrevClose): bigint[] {
  void prevClose
  throw new Error('computeStrikes is not implemented')
}
