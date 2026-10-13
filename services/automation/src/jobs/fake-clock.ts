import type { Clock } from './clock.js'

interface Sleeper {
  at: number
  seq: number
  resolve: () => void
}

/** Lets pending promise chains run until they block on the clock again. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

const MAX_WAKEUPS_PER_ADVANCE = 1_000_000

/**
 * Virtual-time clock for tests. `advanceTo` wakes sleepers in time order and lets the code under
 * test run between wakeups, so hours of scheduling run instantly and deterministically.
 */
export class FakeClock implements Clock {
  #now: number
  #seq = 0
  #sleepers: Sleeper[] = []

  constructor(startMs: number) {
    this.#now = startMs
  }

  now(): number {
    return this.#now
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      const sleeper: Sleeper = { at: this.#now + Math.max(0, ms), seq: this.#seq++, resolve }
      this.#sleepers.push(sleeper)
      signal?.addEventListener(
        'abort',
        () => {
          this.#sleepers = this.#sleepers.filter((other) => other !== sleeper)
          resolve()
        },
        { once: true },
      )
    })
  }

  /** Runs every timer due up to `targetMs`, then sets the time to `targetMs`. */
  async advanceTo(targetMs: number): Promise<void> {
    await flush()
    let wakeups = 0
    for (;;) {
      const due = this.#sleepers
        .filter((sleeper) => sleeper.at <= targetMs)
        .sort((a, b) => a.at - b.at || a.seq - b.seq)[0]
      if (!due) break
      wakeups += 1
      if (wakeups > MAX_WAKEUPS_PER_ADVANCE) throw new Error('fake clock: runaway timer loop')
      this.#sleepers = this.#sleepers.filter((sleeper) => sleeper !== due)
      this.#now = Math.max(this.#now, due.at)
      due.resolve()
      await flush()
    }
    this.#now = Math.max(this.#now, targetMs)
    await flush()
  }

  advanceBy(ms: number): Promise<void> {
    return this.advanceTo(this.#now + ms)
  }
}
