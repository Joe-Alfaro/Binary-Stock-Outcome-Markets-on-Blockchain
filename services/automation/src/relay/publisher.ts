import { createDemoReplaySource } from '@meridian/price-providers'
import { publishClose, runCloses } from './close.js'
import { createLiveRelay } from './live.js'
import type { LiveRelay } from './live.js'
import { createRelayLog } from './log.js'
import type { RelayPublisher, RelayPublisherOptions } from './types.js'

export { tradingDayNumber } from './close.js'

/** The source whose closes are already replayed in demo mode (R44). */
const REPLAY_SOURCE = 'mock'

/**
 * The relay publisher for one signer: close records after `close_ts` and live prices. In demo
 * mode a live source (alpaca, D94) still gives the live prices, but demo closes replay the
 * recorded close, labelled replayed.
 */
export function createRelayPublisher(options: RelayPublisherOptions): RelayPublisher {
  const demo = options.demo ?? false
  const closeSource =
    demo && options.source.name !== REPLAY_SOURCE
      ? createDemoReplaySource({ now: () => options.clock.now() })
      : options.source
  const context = { ...options, source: closeSource, log: createRelayLog(options.log, demo) }
  const live: LiveRelay | null = options.live
    ? createLiveRelay({
        ...options,
        live: options.live,
        log: createRelayLog(options.log, demo && options.live.name === REPLAY_SOURCE),
      })
    : null

  function liveRelay(): LiveRelay {
    if (!live) throw new Error('live prices need a live price source (RelayPublisherOptions.live)')
    return live
  }

  return {
    publishClose: (ticker, tradingDay, closeTs) =>
      publishClose(context, ticker, tradingDay, closeTs),
    runCloses: (tradingDay, closeTs, deadlineTs) =>
      runCloses(context, tradingDay, closeTs, deadlineTs),
    publishLatest: () => liveRelay().publishLatest(),
    runLive: (untilTs, signal) => liveRelay().runLive(untilTs, signal),
  }
}
