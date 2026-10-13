import type { PriceProvider } from '@meridian/price-providers'

import type { Alerter } from '../alerts/index.js'
import type { ChainClient } from '../chain/index.js'
import type { Clock } from './clock.js'
import type { JobLogger } from './logger.js'

/** The seven tickers that get markets every trading day. */
export const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'] as const

export interface MorningJobDeps {
  chain: ChainClient
  /** Slot 1's price source; only the previous close is used. */
  provider: Pick<PriceProvider, 'previousClose'>
  alerter: Alerter
  clock: Clock
  log: JobLogger
  /** The day to create markets for, `YYYY-MM-DD` in America/New_York. */
  tradingDay: string
  /** Defaults to `TICKERS`. */
  tickers?: readonly string[]
}

export interface MorningJobResult {
  /** Tickers whose every strike market exists. */
  completeTickers: string[]
  /** Tickers left without all their markets: stale previous close or failures past the deadline. */
  incompleteTickers: string[]
}

export interface MorningRun {
  tradingDay: string
  /** Milliseconds since the Unix epoch. */
  startMs: number
}

/**
 * When the morning job should next run: 6:00 AM ET on the next trading day, or right away when
 * `nowMs` falls inside a trading day's 6:00 to 8:00 AM ET window (a restart catching up).
 */
export function nextMorningRun(nowMs: number): MorningRun {
  throw new Error(`not implemented (${nowMs})`)
}

/**
 * Creates every strike market of `tradingDay` for each ticker, one `create_strike_market`
 * transaction per strike, retrying failures with exponential backoff and alerting at 7:30 AM ET
 * for any ticker still incomplete. Refuses a stale previous close with an alert.
 */
export async function runMorningJob(deps: MorningJobDeps): Promise<MorningJobResult> {
  throw new Error(`not implemented (${deps.tradingDay})`)
}
