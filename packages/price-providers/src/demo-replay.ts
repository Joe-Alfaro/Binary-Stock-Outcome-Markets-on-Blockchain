import type { MockSourceOptions } from './mock.js'
import type { LivePriceProvider, PriceProvider } from './types.js'

/**
 * Offline relay source for demo mode (R44): replays the recorded AAPL close of 2026-10-12,
 * re-stamped to the requested `closeTs`.
 */
export function createDemoReplaySource(
  options: MockSourceOptions = {},
): PriceProvider & LivePriceProvider {
  void options
  throw new Error('createDemoReplaySource is not implemented')
}
