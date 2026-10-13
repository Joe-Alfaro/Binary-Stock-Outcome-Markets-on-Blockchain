import { publishClose, runCloses } from './close.js'
import { createLiveRelay } from './live.js'
import type { LiveRelay } from './live.js'
import { createRelayLog } from './log.js'
import type { RelayPublisher, RelayPublisherOptions } from './types.js'

export { tradingDayNumber } from './close.js'

/** The only source a demo relay may replay from (R44). */
const DEMO_SOURCE = 'mock'

/** The relay publisher for one signer: close records after `close_ts` and live prices. */
export function createRelayPublisher(options: RelayPublisherOptions): RelayPublisher {
  const demo = options.demo ?? false
  if (demo && options.source.name !== DEMO_SOURCE) {
    throw new Error(
      `demo mode replays recorded closes and needs the ${DEMO_SOURCE} source, not ${options.source.name}`,
    )
  }
  const log = createRelayLog(options.log, demo)
  const context = { ...options, log }
  const live: LiveRelay | null = options.live
    ? createLiveRelay({ ...context, live: options.live })
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
    runLive: (untilTs) => liveRelay().runLive(untilTs),
  }
}
