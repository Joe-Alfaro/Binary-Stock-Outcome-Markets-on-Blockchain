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
    return Date.now()
  },
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const onAbort = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(
        () => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        },
        Math.max(0, ms),
      )
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  },
}
