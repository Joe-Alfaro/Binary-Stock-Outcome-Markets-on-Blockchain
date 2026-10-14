/** Relay source names accepted by RELAY_<n>_SOURCE. `mock` works offline. */
export const RELAY_SOURCE_NAMES = ['alpaca', 'yahoo', 'mock'] as const

export type RelaySourceName = (typeof RELAY_SOURCE_NAMES)[number]

/** The default without Alpaca keys; with both keys set, an unset source means `alpaca` (R67). */
export const DEFAULT_RELAY_SOURCE: RelaySourceName = 'mock'

export function isRelaySourceName(value: string): value is RelaySourceName {
  return (RELAY_SOURCE_NAMES as readonly string[]).includes(value)
}
