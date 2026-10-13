import { notImplemented } from './errors.js'
import type { NormalizedPrice } from './types.js'

/**
 * Normalizes a decoded Data Streams RWA Advanced (v11) report: price is `lastTradedPrice` when
 * present, else `mid`; conf is half the bid-ask spread; session is regular only when
 * `marketStatus` is regular hours. Never an official close.
 */
export function normalizeChainlinkV11Report(
  report: unknown,
  context: { ticker: string },
): NormalizedPrice {
  return notImplemented(report, context)
}
