import { PriceSourceError, type PriceProvider } from '@meridian/price-providers'
import { computeStrikes } from '@meridian/sdk'

import type { Alerter } from '../alerts/index.js'
import { isTradingDay, previousTradingDay, tradingDayTimes } from '../calendar/index.js'
import type { ChainClient } from '../chain/index.js'
import type { Clock } from './clock.js'
import type { JobLogger } from './logger.js'
import { usdToChainPrice } from './price.js'

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
  /** Stops the job: waits end at once and no further fetch or create is sent. */
  signal?: AbortSignal
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

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/** Backoff starts at 2 s and doubles, capped so a failing ticker is still retried at 7:30. */
const BACKOFF_BASE_MS = 2_000
const BACKOFF_CAP_MS = 5 * MINUTE_MS

const exchangeDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function dayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
}

function nextTradingDay(date: string): string {
  const candidate = dayAfter(date)
  return isTradingDay(candidate) ? candidate : nextTradingDay(candidate)
}

/** 6:00, 7:30 and 8:00 AM ET on a trading day, in milliseconds (mint open is 9:00 AM ET). */
function morningWindow(tradingDay: string) {
  const nineAm = tradingDayTimes(tradingDay).mintOpenTs * 1000
  return {
    start: nineAm - 3 * HOUR_MS,
    alertAt: nineAm - 90 * MINUTE_MS,
    deadline: nineAm - HOUR_MS,
  }
}

/**
 * When the morning job should next run: 6:00 AM ET on the next trading day, or right away when
 * `nowMs` falls inside a trading day's 6:00 to 8:00 AM ET window (a restart catching up).
 */
export function nextMorningRun(nowMs: number): MorningRun {
  const today = exchangeDate.format(nowMs)
  if (isTradingDay(today)) {
    const { start, deadline } = morningWindow(today)
    if (nowMs < start) return { tradingDay: today, startMs: start }
    if (nowMs < deadline) return { tradingDay: today, startMs: nowMs }
  }
  const tradingDay = nextTradingDay(today)
  return { tradingDay, startMs: morningWindow(tradingDay).start }
}

function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type TickerOutcome = 'complete' | 'stale' | 'incomplete'

/**
 * Creates every strike market of `tradingDay` for each ticker, one `create_strike_market`
 * transaction per strike, retrying failures with exponential backoff and alerting at 7:30 AM ET
 * for any ticker still incomplete. Refuses a stale previous close with an alert.
 */
export async function runMorningJob(deps: MorningJobDeps): Promise<MorningJobResult> {
  const { chain, provider, alerter, clock, log, tradingDay, tickers = TICKERS, signal } = deps
  const { alertAt, deadline } = morningWindow(tradingDay)
  const times = tradingDayTimes(tradingDay)
  const expectedPreviousDay = previousTradingDay(tradingDay)
  const startedAfterAlert = clock.now() >= alertAt
  const outcomes = new Map<string, TickerOutcome>()

  /** Waits out the backoff; false once the 8:00 deadline has passed or the job was stopped. */
  async function backoff(attempt: number): Promise<boolean> {
    const remaining = deadline - clock.now()
    if (remaining <= 0 || signal?.aborted) return false
    await clock.sleep(Math.min(backoffMs(attempt), remaining), signal)
    return !signal?.aborted && clock.now() < deadline
  }

  async function alertStale(ticker: string, reason: string): Promise<void> {
    log.error('refusing a stale previous close', { ticker, tradingDay, reason })
    await alerter.alert({
      kind: 'morning_job_failure',
      message: `${ticker}: stale previous close, no markets created for ${tradingDay}`,
      details: { ticker, tradingDay, expectedPreviousDay, reason },
    })
  }

  /** The previous close as a chain price, or null when it is stale or the deadline passed. */
  async function fetchPreviousClose(ticker: string) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const close = await provider.previousClose(ticker, expectedPreviousDay)
        if (close.tradingDay !== expectedPreviousDay) {
          await alertStale(ticker, `close is dated ${close.tradingDay}`)
          return 'stale'
        }
        if (!Number.isFinite(close.price) || close.price <= 0) {
          throw new PriceSourceError('malformed', `previous close ${close.price}`)
        }
        return usdToChainPrice(close.price)
      } catch (error) {
        if (error instanceof PriceSourceError && error.code === 'stale') {
          await alertStale(ticker, error.message)
          return 'stale'
        }
        log.error('previous close fetch failed', {
          ticker,
          tradingDay,
          attempt,
          error: errorMessage(error),
        })
      }
      if (!(await backoff(attempt))) return null
    }
  }

  /** Sends one create transaction per strike; resolves with the strikes that need a retry. */
  async function createRound(ticker: string, strikes: bigint[]): Promise<bigint[]> {
    const results = await Promise.all(
      strikes.map(async (strike) => {
        const details = { ticker, tradingDay, strike: strike.toString() }
        try {
          const result = await chain.createStrikeMarket({
            ticker,
            tradingDay,
            strike,
            closeTs: times.closeTs,
            mintOpenTs: times.mintOpenTs,
            tradingOpenTs: times.tradingOpenTs,
          })
          log.info('create_strike_market', { ...details, result })
          return null
        } catch (error) {
          log.error('create_strike_market failed', { ...details, error: errorMessage(error) })
          return strike
        }
      }),
    )
    return results.filter((strike) => strike !== null)
  }

  async function runTicker(ticker: string): Promise<TickerOutcome> {
    const previousClose = await fetchPreviousClose(ticker)
    if (previousClose === 'stale') return 'stale'
    if (!previousClose || signal?.aborted) return 'incomplete'
    let pending = computeStrikes(previousClose)
    for (let attempt = 0; ; attempt += 1) {
      pending = await createRound(ticker, pending)
      if (pending.length === 0) return 'complete'
      if (!(await backoff(attempt))) return 'incomplete'
    }
  }

  function incomplete(): string[] {
    return tickers.filter((ticker) => outcomes.get(ticker) !== 'complete')
  }

  async function alertIncomplete(tickersLeft: string[]): Promise<void> {
    log.error('morning job incomplete', { tradingDay, tickers: tickersLeft })
    await alerter.alert({
      kind: 'morning_job_failure',
      message: `markets for ${tradingDay} incomplete: ${tickersLeft.join(', ')}`,
      details: { tradingDay, incompleteTickers: tickersLeft },
    })
  }

  const finished = new AbortController()
  const watcherSignal = signal ? AbortSignal.any([signal, finished.signal]) : finished.signal
  const watcher = (async () => {
    if (startedAfterAlert) return
    await clock.sleep(alertAt - clock.now(), watcherSignal)
    if (watcherSignal.aborted || incomplete().length === 0) return
    await alertIncomplete(incomplete())
  })()

  await Promise.all(
    tickers.map(async (ticker) => {
      outcomes.set(ticker, await runTicker(ticker))
    }),
  )
  finished.abort()
  await watcher

  const incompleteTickers = incomplete()
  // A run that started after 7:30 has no 7:30 check; stale tickers were alerted already.
  const unreported = incompleteTickers.filter((ticker) => outcomes.get(ticker) !== 'stale')
  // A stopped run is not a failure: the next start inside the window catches up.
  if (startedAfterAlert && unreported.length > 0 && !signal?.aborted) {
    await alertIncomplete(unreported)
  }
  const completeTickers = tickers.filter((ticker) => outcomes.get(ticker) === 'complete')
  log.info('morning job finished', { tradingDay, completeTickers, incompleteTickers })
  return { completeTickers, incompleteTickers }
}
