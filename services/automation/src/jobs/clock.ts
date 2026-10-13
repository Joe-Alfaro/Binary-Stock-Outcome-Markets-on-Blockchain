/** Time source for the jobs, injected so tests can run a whole day in virtual time. */
export interface Clock {
  /** Milliseconds since the Unix epoch. */
  now(): number
  /** Resolves after `ms`, or as soon as `signal` aborts (resolving, not rejecting). */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

/** The real clock: `Date.now()` and `setTimeout`. */
export const systemClock: Clock = {
  now() {
    throw new Error('not implemented')
  },
  sleep() {
    throw new Error('not implemented')
  },
}
