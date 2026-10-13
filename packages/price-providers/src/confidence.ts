import { notImplemented } from './errors.js'
export interface ConfidenceInputs {
  bid?: number
  ask?: number
  /** High and low of the 1-minute bar the price came from. */
  barHigh?: number
  barLow?: number
}

/**
 * Relay confidence: half the bid-ask spread when both sides are known, otherwise half the
 * 1-minute bar's high-low range. Null when neither is available.
 */
export function relayConfidence(inputs: ConfidenceInputs): number | null {
  return notImplemented(inputs)
}
