import assert from 'node:assert/strict'

import type { Alert, Alerter } from '../alerts/index.js'
import type { ChainPrice } from '../chain/index.js'
import type { Clock } from './clock.js'
import type { FakeClock } from './fake-clock.js'
import type { JobLogger } from './logger.js'

export interface RecordedAlert extends Alert {
  at: number
}

/** An alerter that records each alert with the clock time it was raised. */
export function recordingAlerter(clock: Clock): Alerter & { alerts: RecordedAlert[] } {
  const alerts: RecordedAlert[] = []
  return {
    alerts,
    async alert(alert) {
      alerts.push({ ...alert, at: clock.now() })
    },
  }
}

export interface LogEntry {
  level: 'info' | 'error'
  message: string
  details: Record<string, unknown>
  at: number
}

export function recordingLogger(clock: Clock): JobLogger & { entries: LogEntry[] } {
  const entries: LogEntry[] = []
  return {
    entries,
    info(message, details = {}) {
      entries.push({ level: 'info', message, details, at: clock.now() })
    },
    error(message, details = {}) {
      entries.push({ level: 'error', message, details, at: clock.now() })
    },
  }
}

/** `'191.23'` → `{ price: 19123n, expo: -2 }`. */
export function usd(value: string): ChainPrice {
  const [whole = '0', fraction = ''] = value.split('.')
  return { price: BigInt(whole + fraction), expo: -fraction.length }
}

export const MINUTE = 60_000
export const SECOND = 1_000

/** A job promise observed without leaving an unhandled rejection behind. */
export interface Running<T> {
  readonly done: boolean
  /** Advances the clock to `untilMs` and returns the job's result; fails if it is still running. */
  finishBy(clock: FakeClock, untilMs: number): Promise<T>
}

export function observe<T>(promise: Promise<T>): Running<T> {
  let state:
    | { done: false }
    | { done: true; ok: true; value: T }
    | { done: true; ok: false; error: unknown } = { done: false }
  promise.then(
    (value) => {
      state = { done: true, ok: true, value }
    },
    (error: unknown) => {
      state = { done: true, ok: false, error }
    },
  )
  return {
    get done() {
      return state.done
    },
    async finishBy(clock, untilMs) {
      await clock.advanceTo(untilMs)
      if (!state.done) assert.fail(`job still running at ${new Date(untilMs).toISOString()}`)
      if (!state.ok) throw state.error
      return state.value
    },
  }
}
