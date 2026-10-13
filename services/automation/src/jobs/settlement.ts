import type { Alerter } from '../alerts/index.js'
import type { ChainClient } from '../chain/index.js'
import type { Clock } from './clock.js'
import type { JobLogger } from './logger.js'

export interface SettlementJobDeps {
  chain: ChainClient
  alerter: Alerter
  clock: Clock
  log: JobLogger
  /** Stops the job; the returned promise resolves once it has stopped. */
  signal: AbortSignal
}

/**
 * Long-running settlement loop. Finds open markets on-chain, groups them by ticker and day, and
 * runs the escalation schedule for each from `close_ts`: 30 s polling for 15 minutes, the first
 * alert and staggered 3-minute polling at +15, the second alert at +50 and admin finalization at
 * +60. The phase comes from the clock, so a restart resumes where it should.
 */
export async function runSettlementJob(deps: SettlementJobDeps): Promise<void> {
  throw new Error(`not implemented (aborted: ${deps.signal.aborted})`)
}
