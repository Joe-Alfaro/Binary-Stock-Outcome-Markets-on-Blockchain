import { notImplemented } from './errors.js'
import type { PriceProvider } from './types.js'
import type { YahooSourceOptions } from './yahoo.js'

/** Builds the relay source named by `RELAY_<slot>_SOURCE`, defaulting to yahoo when unset. */
export function createRelaySource(
  env: Record<string, string | undefined>,
  slot: 1 | 2 = 1,
  yahooOptions: YahooSourceOptions = {},
): PriceProvider {
  return notImplemented(env, slot, yahooOptions)
}
