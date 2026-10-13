import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PriceSourceError } from '@meridian/price-providers'

import { tradingDayTimes } from '../calendar/index.js'
import { FakeChainClient } from '../chain/fake.js'
import type { Clock } from './clock.js'
import { FakeClock } from './fake-clock.js'
import { runMorningScheduler } from './scheduler.js'
import { MINUTE, SECOND, recordingAlerter, recordingLogger } from './test-support.js'

const HOUR = 60 * MINUTE

function sixAm(tradingDay: string): number {
  return tradingDayTimes(tradingDay).mintOpenTs * 1000 - 3 * HOUR
}

describe('runMorningScheduler', () => {
  it('runs the morning job once per trading day at 6:00 AM ET, skipping the weekend', async () => {
    // Friday 2026-10-16, before the 6:00 run.
    const clock = new FakeClock(sixAm('2026-10-16') - HOUR)
    const chain = new FakeChainClient(clock)
    const tradingDays: { day: string; at: number }[] = []
    const provider = {
      async previousClose(_ticker: string, previousTradingDay: string) {
        tradingDays.push({ day: previousTradingDay, at: clock.now() })
        return { ticker: 'AAPL', tradingDay: previousTradingDay, price: 245 }
      },
    }
    const controller = new AbortController()
    const done = runMorningScheduler({
      chain,
      provider,
      alerter: recordingAlerter(clock),
      clock,
      log: recordingLogger(clock),
      tickers: ['AAPL'],
      signal: controller.signal,
    })

    await clock.advanceTo(sixAm('2026-10-19') + HOUR)
    controller.abort()
    await done

    assert.deepEqual(tradingDays, [
      { day: '2026-10-15', at: sixAm('2026-10-16') },
      { day: '2026-10-16', at: sixAm('2026-10-19') },
    ])
    const days = new Set(chain.allMarkets().map((market) => market.tradingDay))
    assert.deepEqual([...days], ['2026-10-16', '2026-10-19'])
  })

  it('catches up right away when started inside the morning window', async () => {
    const start = sixAm('2026-10-16') + HOUR
    const clock = new FakeClock(start)
    const chain = new FakeChainClient(clock)
    const controller = new AbortController()
    const done = runMorningScheduler({
      chain,
      provider: {
        async previousClose(_ticker: string, previousTradingDay: string) {
          return { ticker: 'AAPL', tradingDay: previousTradingDay, price: 245 }
        },
      },
      alerter: recordingAlerter(clock),
      clock,
      log: recordingLogger(clock),
      tickers: ['AAPL'],
      signal: controller.signal,
    })
    await clock.advanceTo(start + HOUR)
    controller.abort()
    await done
    assert.ok(chain.creates.length > 0)
    assert.ok(chain.creates.every((call) => call.at === start))
  })

  // Red until the morning job's create backoff (morning.ts `backoff`) sleeps on the stop signal.
  // Remove `todo` with that fix.
  it('stops within 1 s when aborted during a create backoff, and creates nothing after', async () => {
    const start = sixAm('2026-10-16') + MINUTE
    const clock = new FakeClock(start)
    const chain = new FakeChainClient(clock)
    chain.createHook = () => {
      throw new Error('rpc: 503 service unavailable')
    }
    const controller = new AbortController()
    const done = runMorningScheduler({
      chain,
      provider: {
        async previousClose(_ticker: string, previousTradingDay: string) {
          return { ticker: 'AAPL', tradingDay: previousTradingDay, price: 245 }
        },
      },
      alerter: recordingAlerter(clock),
      clock,
      log: recordingLogger(clock),
      tickers: ['AAPL'],
      signal: controller.signal,
    })
    // Attempts at +0 s, +2 s and +6 s fail; the job is now in its 8 s backoff.
    await clock.advanceBy(10 * SECOND)
    const attempts = chain.creates.length
    assert.ok(attempts > 0, 'the create was attempted and failed')

    controller.abort()
    // The clock stands still: only the abort can end the backoff.
    const stopped = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SECOND)),
    ])
    await clock.advanceTo(start + 2 * HOUR)
    await done

    assert.equal(stopped, true, 'the scheduler resolves within 1 s of the abort')
    assert.equal(chain.creates.length, attempts, 'no create after the abort')
  })
})

/** After this many sleeps or calls past the abort, the guard stalls them instead of spinning. */
const SPIN_LIMIT = 20

/**
 * Wraps the fake clock and counts the job's sleeps, previous-close fetches and creates after
 * `signal` aborts. Past `SPIN_LIMIT` each one stalls forever, so a job that busy-loops after the
 * abort fails the test instead of starving the event loop.
 */
function abortWatch(inner: FakeClock, signal: AbortSignal) {
  const late = { sleeps: 0, fetches: 0, creates: 0 }
  const stall = () => new Promise<never>(() => {})
  const clock: Clock = {
    now: () => inner.now(),
    sleep(ms, sleepSignal) {
      if (signal.aborted && ++late.sleeps > SPIN_LIMIT) return stall()
      return inner.sleep(ms, sleepSignal)
    },
  }
  return {
    late,
    clock,
    /** Counts a call; stalls it once the job has spun past the limit after the abort. */
    async call(kind: 'fetches' | 'creates'): Promise<void> {
      if (!signal.aborted) return
      late[kind] += 1
      if (late[kind] > SPIN_LIMIT) await stall()
    },
  }
}

/** True when `done` resolves within 1 s of real time, with the fake clock standing still. */
function resolvesWithinASecond(done: Promise<void>): Promise<boolean> {
  return Promise.race([
    done.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), SECOND)),
  ])
}

// The worker's stop() aborts the scheduler's signal. Between 6:00 and 8:00 AM ET the morning job
// must end at once on that abort, wherever it is waiting, and send nothing more. Ending a wait
// early is not enough: a retry loop that keeps going without its backoff spins the CPU.
describe('runMorningScheduler stop during the morning job', () => {
  const tradingDay = '2026-10-16'
  const start = sixAm(tradingDay) + MINUTE

  function startScheduler(options: {
    previousClose?: (ticker: string, previousTradingDay: string) => Promise<void>
    create?: () => void
  }) {
    const fakeClock = new FakeClock(start)
    const controller = new AbortController()
    const watch = abortWatch(fakeClock, controller.signal)
    const chain = new FakeChainClient(fakeClock)
    chain.createHook = async () => {
      await watch.call('creates')
      options.create?.()
    }
    const alerter = recordingAlerter(fakeClock)
    const done = runMorningScheduler({
      chain,
      provider: {
        async previousClose(ticker: string, previousTradingDay: string) {
          await watch.call('fetches')
          await options.previousClose?.(ticker, previousTradingDay)
          return { ticker, tradingDay: previousTradingDay, price: 245 }
        },
      },
      alerter,
      clock: watch.clock,
      log: recordingLogger(fakeClock),
      tickers: ['AAPL'],
      signal: controller.signal,
    })
    return { fakeClock, controller, watch, chain, alerter, done }
  }

  /** Aborts, then checks the scheduler stops at once without another sleep, fetch or create. */
  async function abortAndExpectStop(run: ReturnType<typeof startScheduler>) {
    run.controller.abort()
    // The clock stands still: only the abort can end the wait.
    const stopped = await resolvesWithinASecond(run.done)
    const { late } = run.watch
    assert.ok(
      late.sleeps <= 1 && late.fetches === 0 && late.creates === 0,
      `after the abort: ${late.sleeps} sleeps, ${late.fetches} fetches, ${late.creates} creates (a spin past ${SPIN_LIMIT} stalls)`,
    )
    assert.equal(stopped, true, 'the scheduler resolves within 1 s of the abort')
  }

  it('(a) during a create backoff', { timeout: 10 * SECOND }, async () => {
    const run = startScheduler({
      create: () => {
        throw new Error('rpc: 503 service unavailable')
      },
    })
    // Creates at +0 s, +2 s and +6 s fail; the job is in its 8 s backoff.
    await run.fakeClock.advanceBy(10 * SECOND)
    assert.ok(run.chain.creates.length > 0, 'the create was attempted and failed')

    await abortAndExpectStop(run)
  })

  // The path 6 of the 7 tickers took in CI: the mock source had no recording for them.
  it('(b) during a previous-close fetch backoff', { timeout: 10 * SECOND }, async () => {
    let fetches = 0
    const run = startScheduler({
      previousClose: async (ticker) => {
        fetches += 1
        throw new PriceSourceError('not-found', `no 1d recording for ${ticker}`)
      },
    })
    await run.fakeClock.advanceBy(10 * SECOND)
    assert.ok(fetches > 0, 'the previous close was fetched and failed')

    await abortAndExpectStop(run)
    assert.equal(run.chain.creates.length, 0)
  })

  it(
    '(c) during the 7:30 alert wait, and raises no alert after',
    { timeout: 10 * SECOND },
    async () => {
      const run = startScheduler({
        create: () => {
          throw new Error('rpc: 503 service unavailable')
        },
      })
      // Backing off at the 5-minute cap while the 7:30 alert check waits.
      const alertAt = sixAm(tradingDay) + 90 * MINUTE
      await run.fakeClock.advanceTo(alertAt - 2 * MINUTE)
      assert.equal(run.alerter.alerts.length, 0, 'no alert before 7:30')

      await abortAndExpectStop(run)
      await run.fakeClock.advanceTo(sixAm(tradingDay) + 2 * HOUR)
      assert.deepEqual(run.alerter.alerts, [], 'a stopped job raises no incomplete alert')
    },
  )
})
