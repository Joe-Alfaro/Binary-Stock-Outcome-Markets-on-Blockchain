/** Relay source names accepted by RELAY_<n>_SOURCE. `mock` works offline. */
export const RELAY_SOURCE_NAMES = ['yahoo', 'mock'] as const

export type RelaySourceName = (typeof RELAY_SOURCE_NAMES)[number]

export const DEFAULT_RELAY_SOURCE: RelaySourceName = 'yahoo'

export function isRelaySourceName(value: string): value is RelaySourceName {
  return (RELAY_SOURCE_NAMES as readonly string[]).includes(value)
}
