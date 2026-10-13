import { createMockSource } from './mock.js'
import { DEFAULT_RELAY_SOURCE, RELAY_SOURCE_NAMES, isRelaySourceName } from './sources.js'
import type { PriceProvider } from './types.js'
import { createYahooSource } from './yahoo.js'
import type { YahooSourceOptions } from './yahoo.js'

/** Builds the relay source named by `RELAY_<slot>_SOURCE`, defaulting to yahoo when unset. */
export function createRelaySource(
  env: Record<string, string | undefined>,
  slot: 1 | 2 = 1,
  yahooOptions: YahooSourceOptions = {},
): PriceProvider {
  const variable = `RELAY_${slot}_SOURCE`
  const name = env[variable]?.trim() || DEFAULT_RELAY_SOURCE
  if (!isRelaySourceName(name)) {
    throw new Error(`${variable}=${name} is not one of ${RELAY_SOURCE_NAMES.join(', ')}`)
  }
  if (name === 'mock') return createMockSource()
  return createYahooSource(yahooOptions)
}
