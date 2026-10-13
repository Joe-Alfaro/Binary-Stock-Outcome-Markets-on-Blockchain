import type { NormalizedPrice } from '@meridian/price-providers'
import { errorMessage, valueFields } from './log.js'
import type { RelayLogEntry } from './log.js'
import { isRegularSessionOpen, nextOpen } from './session.js'
import type { LiveOutcome, LivePriceSource, RelayPublisherOptions } from './types.js'

/**
 * Live ticks are scheduled this far apart from the start of the previous tick, which keeps
 * updates under R47's 60 s even when a tick's transaction is slow.
 */
export const LIVE_INTERVAL_SECS = 30
/** First retry delay after a failed tick; it doubles per consecutive failure. */
const BACKOFF_BASE_SECS = 30
/** Below 5 minutes, so updates resume within 5 minutes of the source or chain recovering. */
const BACKOFF_MAX_SECS = 240
/** Sleep when the calendar data has no next open (past its last year). */
const IDLE_SECS = 60 * 60

export interface LiveContext extends Pick<RelayPublisherOptions, 'oracle' | 'tickers' | 'clock'> {
  live: LivePriceSource
  log: (entry: RelayLogEntry) => void
}

export interface LiveRelay {
  publishLatest(): Promise<LiveOutcome>
  runLive(untilTs: number): Promise<void>
}

export function createLiveRelay(context: LiveContext): LiveRelay {
  const { oracle, live, tickers, clock, log } = context
  /** `publish_latest` requires a strictly increasing publish time per ticker. */
  const lastPublished = new Map<string, number>()

  function isNew(update: NormalizedPrice): boolean {
    return update.publishTime > (lastPublished.get(update.ticker) ?? -Infinity)
  }

  async function publishLatest(): Promise<LiveOutcome> {
    if (!isRegularSessionOpen(clock.now())) return { status: 'closed', tickers: [] }
    try {
      const prices = await Promise.all(tickers.map((ticker) => live.latest(ticker)))
      const updates = prices.filter((update): update is NormalizedPrice => update !== null)
      const fresh = updates.filter(isNew)
      if (fresh.length === 0) return { status: 'published', tickers: [] }
      const signature = await oracle.publishLatest(fresh)
      fresh.forEach((update) => {
        lastPublished.set(update.ticker, update.publishTime)
        log({
          event: 'latest-published',
          ...valueFields(update),
          source: live.name,
          signer: oracle.signer,
          signature,
        })
      })
      return { status: 'published', tickers: fresh.map((update) => update.ticker) }
    } catch (error) {
      log({ event: 'latest-error', error: errorMessage(error) })
      return { status: 'error', tickers: [] }
    }
  }

  async function runLive(untilTs: number): Promise<void> {
    let failures = 0
    while (clock.now() < untilTs) {
      const tickStart = clock.now()
      const outcome = await publishLatest()
      failures = outcome.status === 'error' ? failures + 1 : 0
      const wakeAt = nextWake(outcome, tickStart, failures)
      await clock.sleep(Math.max(1, Math.min(wakeAt, untilTs) - clock.now()))
    }
  }

  function nextWake(outcome: LiveOutcome, tickStart: number, failures: number): number {
    if (outcome.status === 'closed') return nextOpen(tickStart) ?? tickStart + IDLE_SECS
    if (outcome.status === 'published') return tickStart + LIVE_INTERVAL_SECS
    const delay = Math.min(BACKOFF_MAX_SECS, BACKOFF_BASE_SECS * 2 ** (failures - 1))
    return tickStart + delay
  }

  return { publishLatest, runLive }
}
