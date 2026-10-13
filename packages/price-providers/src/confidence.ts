export interface ConfidenceInputs {
  bid?: number
  ask?: number
  /** High and low of the 1-minute bar the price came from. */
  barHigh?: number
  barLow?: number
}

function halfRange(low: number | undefined, high: number | undefined): number | null {
  if (low === undefined || high === undefined) return null
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return null
  return (high - low) / 2
}

/**
 * Relay confidence: half the bid-ask spread when both sides are known, otherwise half the
 * 1-minute bar's high-low range. Null when neither is available.
 */
export function relayConfidence(inputs: ConfidenceInputs): number | null {
  return halfRange(inputs.bid, inputs.ask) ?? halfRange(inputs.barLow, inputs.barHigh)
}
