import { PriceSourceError } from '@meridian/price-providers'
import type { LivePriceProvider } from '@meridian/price-providers'
import type { ChainClient, OpenMarket } from '../chain/index.js'
import type { Clock as JobClock, JobLogger } from '../jobs/index.js'
import { CLOSE_POLL_SECS } from './close.js'
import { errorMessage } from './log.js'
import type { Clock, LivePriceSource, OracleClient, RelayPublisher } from './types.js'

const SECOND_MS = 1_000
/**
 * Markets that closed longer ago than this are left to the admin fallback (ready at +60 min), so
 * a ticker the source never answers for isn't asked about forever.
 */
export const CLOSE_LOOKBACK_SECS = 2 * 60 * 60

/** The jobs' millisecond clock as the relay's second clock, its sleeps cut short by `signal`. */
export function relayClock(clock: JobClock, signal: AbortSignal): Clock {
  return {
    now: () => Math.floor(clock.now() / SECOND_MS),
    sleep: (seconds) => clock.sleep(seconds * SECOND_MS, signal),
  }
}

/** Calls `onPublish` after every transaction the relay lands, for the health check. */
export function withPublishHealth(oracle: OracleClient, onPublish: () => void): OracleClient {
  const recorded = async <T>(sent: Promise<T>) => {
    const result = await sent
    onPublish()
    return result
  }
  return {
    signer: oracle.signer,
    priceUpdateExists: (ticker, publishTime) => oracle.priceUpdateExists(ticker, publishTime),
    closeRecordExists: (ticker, tradingDay) => oracle.closeRecordExists(ticker, tradingDay),
    publishPrice: (update) => recorded(oracle.publishPrice(update)),
    publishClose: (request) => recorded(oracle.publishClose(request)),
    publishLatest: (updates) => recorded(oracle.publishLatest(updates)),
  }
}

/**
 * A live source where a ticker the source has no data for is skipped rather than failing every
 * ticker's tick, and reported once through `onSkip`. Other errors still fail the tick, so the
 * relay backs off.
 */
export function skippingUnknownTickers(
  source: LivePriceProvider,
  onSkip: (ticker: string, error: PriceSourceError) => void = () => {},
): LivePriceSource {
  const skipped = new Set<string>()
  return {
    name: source.name,
    async latest(ticker) {
      try {
        return await source.latest(ticker)
      } catch (error) {
        if (!(error instanceof PriceSourceError) || error.code !== 'not-found') throw error
        if (!skipped.has(ticker)) onSkip(ticker, error)
        skipped.add(ticker)
        return null
      }
    },
  }
}

export interface RelayLoopDeps {
  publisher: RelayPublisher
  chain: Pick<ChainClient, 'listOpenMarkets'>
  clock: JobClock
  log: JobLogger
  /** Stops the loop; the returned promise resolves once it has stopped. */
  signal: AbortSignal
}

/** One market per ticker and trading day whose close has passed, within the lookback. */
function dueTickerDays(markets: OpenMarket[], nowSecs: number): OpenMarket[] {
  const due = new Map<string, OpenMarket>()
  markets
    .filter(({ closeTs }) => closeTs <= nowSecs && nowSecs - closeTs <= CLOSE_LOOKBACK_SECS)
    .forEach((market) => due.set(`${market.ticker}:${market.tradingDay}`, market))
  return [...due.values()]
}

/**
 * Publishes the close record of every open market's ticker and day once its `close_ts` passes
 * (R40): scans open markets every 30 s and tries each due ticker-day concurrently. Markets drive
 * it, so a demo market closing at any time gets its close like a 4 PM one.
 */
export async function runCloseLoop(deps: RelayLoopDeps): Promise<void> {
  const { publisher, chain, clock, log, signal } = deps
  while (!signal.aborted) {
    try {
      const due = dueTickerDays(await chain.listOpenMarkets(), Math.floor(clock.now() / 1000))
      await Promise.all(
        due.map(({ ticker, tradingDay, closeTs }) =>
          publisher.publishClose(ticker, tradingDay, closeTs),
        ),
      )
    } catch (error) {
      log.error('relay close scan failed', { error: errorMessage(error) })
    }
    await clock.sleep(CLOSE_POLL_SECS * SECOND_MS, signal)
  }
}

/** Keeps every ticker's latest-price account fresh through the regular session (R47). */
export async function runLiveLoop(deps: Pick<RelayLoopDeps, 'publisher' | 'signal'>) {
  await deps.publisher.runLive(Number.POSITIVE_INFINITY, deps.signal)
}
