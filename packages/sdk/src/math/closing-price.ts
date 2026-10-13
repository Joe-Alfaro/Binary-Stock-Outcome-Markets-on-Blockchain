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
 *
 * When several updates qualify for a shape, the one nearest `closeTs` wins, and ties go to the one
 * passed first. Mirrors `closing_price` in `crates/meridian-math`.
 */
export function closingPrice(
  updates: readonly NormalizedPrice[],
  params: SettlementParams,
): ClosingPrice {
  updates.forEach((update) => validate(update, params))
  const [first] = updates
  if (first === undefined) throw new ClosingPriceError('NoValidShape')
  if (updates.some((update) => update.expo !== first.expo)) {
    throw new ClosingPriceError('ExpoMismatch')
  }

  const { closeTs } = params
  function nearest(filter: (update: NormalizedPrice) => boolean) {
    return updates.filter(filter).reduce<NormalizedPrice | undefined>((best, update) => {
      if (best === undefined) return update
      const closer = Math.abs(update.publishTime - closeTs) < Math.abs(best.publishTime - closeTs)
      return closer ? update : best
    }, undefined)
  }

  const official = nearest((update) => update.officialClose)
  if (official) return single('OfficialClose', official)
  const exact = nearest((update) => update.publishTime === closeTs)
  if (exact) return single('ExactTimestamp', exact)
  const before = nearest((update) => update.publishTime < closeTs)
  const after = nearest((update) => update.publishTime > closeTs)
  if (!before || !after) throw new ClosingPriceError('NoValidShape')
  return interpolate(before, after, closeTs)
}

function validate(update: NormalizedPrice, params: SettlementParams) {
  if (update.ticker !== params.ticker) throw new ClosingPriceError('WrongTicker')
  if (update.price <= 0n) throw new ClosingPriceError('NonPositivePrice')
  if (update.session !== 'Regular') throw new ClosingPriceError('OutsideRegularSession')
  // conf / price > maxConfBps / 10_000, cross-multiplied. Price is positive here.
  if (update.conf * 10_000n > update.price * BigInt(params.maxConfBps)) {
    throw new ClosingPriceError('ConfidenceTooWide')
  }
  if (Math.abs(update.publishTime - params.closeTs) > params.maxStalenessSecs) {
    throw new ClosingPriceError('Stale')
  }
}

function single(shape: ClosingShape, update: NormalizedPrice): ClosingPrice {
  return {
    shape,
    expo: update.expo,
    numerator: update.price,
    denominator: 1n,
    settlePrice: update.price,
  }
}

/**
 * `p1 + (p2 − p1) × d1 / (d1 + d2)` = `(p1 × d2 + p2 × d1) / (d1 + d2)`, where `d1` and `d2` are
 * the distances from close.
 */
function interpolate(
  before: NormalizedPrice,
  after: NormalizedPrice,
  closeTs: number,
): ClosingPrice {
  const d1 = BigInt(closeTs - before.publishTime)
  const d2 = BigInt(after.publishTime - closeTs)
  const numerator = before.price * d2 + after.price * d1
  const denominator = d1 + d2
  return {
    shape: 'Interpolated',
    expo: before.expo,
    numerator,
    denominator,
    // Halves round up. Both terms are positive, so bigint division floors.
    settlePrice: (2n * numerator + denominator) / (2n * denominator),
  }
}
