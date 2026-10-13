import { tradingDayTimes } from '../calendar/index.js'
import { nextMorningRun, runMorningJob, type MorningJobDeps } from './morning.js'

export interface MorningSchedulerDeps extends Omit<MorningJobDeps, 'tradingDay'> {
  /** Stops the scheduler; the returned promise resolves once it has stopped. */
  signal: AbortSignal
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs the morning job at 6:00 AM ET on every trading day, or right away when started inside a
 * trading day's 6:00 to 8:00 AM ET window. Each trading day runs once.
 */
export async function runMorningScheduler(deps: MorningSchedulerDeps): Promise<void> {
  const { clock, log, signal } = deps
  let from = clock.now()
  while (!signal.aborted) {
    const run = nextMorningRun(from)
    log.info('next morning job', {
      tradingDay: run.tradingDay,
      runAt: new Date(run.startMs).toISOString(),
    })
    await clock.sleep(run.startMs - clock.now(), signal)
    if (signal.aborted) return
    try {
      await runMorningJob({ ...deps, tradingDay: run.tradingDay })
    } catch (error) {
      log.error('morning job failed', { tradingDay: run.tradingDay, error: errorMessage(error) })
    }
    // From the day's close, the next run is the following trading day's 6:00 AM.
    from = Math.max(clock.now(), tradingDayTimes(run.tradingDay).closeTs * 1000)
  }
}
