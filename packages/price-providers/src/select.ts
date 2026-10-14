import { createDemoReplaySource } from './demo-replay.js'
import { createMockSource } from './mock.js'
import { DEFAULT_RELAY_SOURCE, RELAY_SOURCE_NAMES, isRelaySourceName } from './sources.js'
import type { IntradayPriceProvider, LivePriceProvider, PriceProvider } from './types.js'
import { createYahooSource } from './yahoo.js'
import type { YahooSourceOptions } from './yahoo.js'

/**
 * Builds the relay source named by `RELAY_<slot>_SOURCE`, defaulting to yahoo when unset. With
 * `DEMO_MODE=true` the mock source replays the recorded AAPL close of 2026-10-12 (R44). The mock
 * sources also take `yahooOptions.now`, so every source stamps live prices from the same clock.
 */
export function createRelaySource(
  env: Record<string, string | undefined>,
  slot: 1 | 2 = 1,
  yahooOptions: YahooSourceOptions = {},
): PriceProvider & LivePriceProvider & IntradayPriceProvider {
  const variable = `RELAY_${slot}_SOURCE`
  const name = env[variable]?.trim() || DEFAULT_RELAY_SOURCE
  if (!isRelaySourceName(name)) {
    throw new Error(`${variable}=${name} is not one of ${RELAY_SOURCE_NAMES.join(', ')}`)
  }
  if (name === 'mock') {
    const options = yahooOptions.now ? { now: yahooOptions.now } : {}
    return env.DEMO_MODE === 'true' ? createDemoReplaySource(options) : createMockSource(options)
  }
  return createYahooSource(yahooOptions)
}
