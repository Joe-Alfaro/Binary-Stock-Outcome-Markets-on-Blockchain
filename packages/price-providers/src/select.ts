import { alpacaConfigFromEnv, createAlpacaSource } from './alpaca.js'
import { createDemoReplaySource } from './demo-replay.js'
import { createMockSource } from './mock.js'
import { DEFAULT_RELAY_SOURCE, RELAY_SOURCE_NAMES, isRelaySourceName } from './sources.js'
import type { RelaySourceName } from './sources.js'
import type { IntradayPriceProvider, LivePriceProvider, PriceProvider } from './types.js'
import { createYahooSource } from './yahoo.js'
import type { YahooSourceOptions } from './yahoo.js'

/** A relay source; the alpaca one holds a websocket that `close` shuts. */
export type RelaySource = PriceProvider &
  LivePriceProvider &
  IntradayPriceProvider & { close?(): void }

function hasAlpacaKeys(env: Record<string, string | undefined>): boolean {
  return Boolean(env.ALPACA_API_KEY?.trim() && env.ALPACA_API_SECRET?.trim())
}

/**
 * Builds the relay source named by `RELAY_<slot>_SOURCE`. When unset it is alpaca if both
 * `ALPACA_API_KEY` and `ALPACA_API_SECRET` are set, otherwise mock (R67). Selecting alpaca without
 * the keys throws, naming the missing variables. With `DEMO_MODE=true` the mock source replays the
 * recorded AAPL close of 2026-10-12 (R44). Every source takes `options.now`, so they all stamp live
 * prices from the same clock, and the network sources take `options.fetch`.
 */
export function createRelaySource(
  env: Record<string, string | undefined>,
  slot: 1 | 2 = 1,
  options: YahooSourceOptions = {},
): RelaySource {
  const variable = `RELAY_${slot}_SOURCE`
  const fallback: RelaySourceName = hasAlpacaKeys(env) ? 'alpaca' : DEFAULT_RELAY_SOURCE
  const name = env[variable]?.trim() || fallback
  if (!isRelaySourceName(name)) {
    throw new Error(`${variable}=${name} is not one of ${RELAY_SOURCE_NAMES.join(', ')}`)
  }
  if (name === 'mock') {
    const mockOptions = options.now ? { now: options.now } : {}
    return env.DEMO_MODE === 'true'
      ? createDemoReplaySource(mockOptions)
      : createMockSource(mockOptions)
  }
  if (name === 'alpaca') {
    const config = alpacaConfigFromEnv(env)
    return createAlpacaSource({
      ...options,
      keyId: config.keyId,
      secretKey: config.secretKey,
      restUrl: config.restUrl,
      stream: { url: config.streamUrl },
    })
  }
  return createYahooSource(options)
}
