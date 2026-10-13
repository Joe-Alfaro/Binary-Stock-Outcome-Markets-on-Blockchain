import { notImplemented } from './errors.js'
import type { PriceProvider } from './types.js'

/**
 * Offline relay source that replays the recorded Yahoo fixtures in `fixtures/yahoo/`, re-stamped
 * to the requested `closeTs`. Never touches the network.
 */
export function createMockSource(): PriceProvider {
  return notImplemented()
}
