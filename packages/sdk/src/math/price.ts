/** Smallest price exponent a configured price source may use. */
export const MIN_EXPO = -12
/** Largest price exponent a configured price source may use. */
export const MAX_EXPO = 0

export type Session = 'Regular' | 'OutsideRegular'

/**
 * One price update from any oracle kind, after normalization. The value is `price × 10^expo`;
 * `conf` uses the same scale. Mirrors `NormalizedPrice` in `crates/meridian-math`.
 */
export interface NormalizedPrice {
  ticker: string
  price: bigint
  conf: bigint
  expo: number
  /** Unix seconds. */
  publishTime: number
  session: Session
  officialClose: boolean
}
