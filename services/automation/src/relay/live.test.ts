import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRelayPublisher } from './index.js'
import {
  RELAY_SIGNER,
  captureLog,
  createFakeClock,
  createFakeLiveSource,
  createFakeOracle,
  createScriptedSource,
  edt,
  est,
  findValueLog,
} from './test-support.js'

const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA']
const DAY = '2026-10-12'
const OPEN = edt(DAY, '09:30:00')
const CLOSE = edt(DAY, '16:00:00')

function setup(start: number) {
  const clock = createFakeClock(start)
  const oracle = createFakeOracle(clock)
  const live = createFakeLiveSource(clock)
  const log = captureLog()
  const publisher = createRelayPublisher({
    oracle,
    source: createScriptedSource(clock, () => null),
    live,
    tickers: TICKERS,
    clock,
    log: log.write,
  })
  return { clock, oracle, live, log, publisher }
}

function latestCalls(oracle: ReturnType<typeof setup>['oracle']) {
  return oracle.calls.filter((call) => call.method === 'publishLatest')
}

/** Distinct times the live source was asked: one per tick, whatever the ticker count. */
function attemptTimes(asked: number[]): number[] {
  return [...new Set(asked)]
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((time, index) => time - (times[index] ?? 0))
}

describe('R47 live prices: one tick', () => {
  it('publishes every ticker in one publish_latest transaction during regular hours', async () => {
    const { oracle, publisher } = setup(edt(DAY, '10:00:00'))
    const outcome = await publisher.publishLatest()
    assert.equal(outcome.status, 'published')
    assert.deepEqual([...outcome.tickers].sort(), [...TICKERS].sort())
    const calls = latestCalls(oracle)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.updates.map((update) => update.ticker).sort(), [...TICKERS].sort())
  })

  it('skips a ticker the source has no price for and publishes the rest', async () => {
    const { oracle, live, publisher } = setup(edt(DAY, '10:00:00'))
    live.missing.add('TSLA')
    const outcome = await publisher.publishLatest()
    assert.equal(outcome.status, 'published')
    assert.ok(!outcome.tickers.includes('TSLA'))
    assert.deepEqual(
      latestCalls(oracle)[0]
        ?.updates.map((update) => update.ticker)
        .sort(),
      TICKERS.filter((ticker) => ticker !== 'TSLA').sort(),
    )
  })

  it('logs every published latest price with the transaction signature and signer', async () => {
    const { oracle, log, publisher } = setup(edt(DAY, '10:00:00'))
    await publisher.publishLatest()
    const [call] = latestCalls(oracle)
    assert.ok(call)
    const entries = log.entries()
    call.updates.forEach((update) => {
      const entry = findValueLog(entries, update, call.signature)
      assert.ok(entry, `no log line for ${update.ticker}`)
      assert.equal(entry.signer, RELAY_SIGNER)
      assert.equal(entry.source, 'scripted')
    })
  })

  const closedTimes: [string, number][] = [
    ['one second before the open', OPEN - 1],
    ['at the close', CLOSE],
    ['in the evening', edt(DAY, '20:00:00')],
    ['on a Saturday', edt('2026-10-10', '11:00:00')],
    ['on Thanksgiving', est('2026-11-26', '11:00:00')],
    ['after a 1 PM early close', est('2026-11-27', '13:00:00')],
  ]
  closedTimes.forEach(([label, now]) => {
    it(`skips ${label} without asking the source`, async () => {
      const { oracle, live, publisher } = setup(now)
      const outcome = await publisher.publishLatest()
      assert.equal(outcome.status, 'closed')
      assert.deepEqual(outcome.tickers, [])
      assert.equal(live.asked.length, 0)
      assert.equal(oracle.calls.length, 0)
    })
  })

  it('publishes just before a 1 PM early close', async () => {
    const { oracle, publisher } = setup(est('2026-11-27', '12:59:00'))
    const outcome = await publisher.publishLatest()
    assert.equal(outcome.status, 'published')
    assert.equal(latestCalls(oracle).length, 1)
  })

  it('reports an error without throwing when the source fails', async () => {
    const { oracle, live, publisher } = setup(edt(DAY, '10:00:00'))
    live.fail = () => true
    const outcome = await publisher.publishLatest()
    assert.equal(outcome.status, 'error')
    assert.equal(latestCalls(oracle).length, 0)
  })
})

describe('R47 live prices: loop', () => {
  it('updates at least every 60 s through the regular session and never outside it', async () => {
    const { oracle, publisher } = setup(edt(DAY, '08:00:00'))
    await publisher.runLive(edt(DAY, '17:00:00'))

    const times = latestCalls(oracle).map((call) => call.at)
    assert.ok(times.length >= 390, `${times.length} updates`)
    assert.ok(
      times.every((at) => at >= OPEN && at < CLOSE),
      'published outside regular hours',
    )
    assert.ok((times[0] ?? Infinity) <= OPEN + 60, 'first update more than 60 s after the open')
    assert.ok((times.at(-1) ?? 0) >= CLOSE - 60, 'last update more than 60 s before the close')
    gaps(times).forEach((gap) => assert.ok(gap <= 60, `gap of ${gap} s between updates`))
    latestCalls(oracle).forEach((call) => assert.equal(call.updates.length, TICKERS.length))
  })

  it('stays idle without a tight loop on a holiday and a weekend', async () => {
    const { clock, oracle, live, publisher } = setup(est('2026-11-26', '00:00:00'))
    await publisher.runLive(est('2026-11-26', '23:59:00'))
    assert.equal(live.asked.length, 0)
    assert.equal(oracle.calls.length, 0)
    assert.ok(clock.sleeps.length <= 24 * 60, `${clock.sleeps.length} wake-ups on a holiday`)

    const weekend = setup(edt('2026-10-10', '00:00:00'))
    await weekend.publisher.runLive(edt('2026-10-11', '23:59:00'))
    assert.equal(weekend.live.asked.length, 0)
    assert.equal(weekend.oracle.calls.length, 0)
    assert.ok(weekend.clock.sleeps.length <= 2 * 24 * 60)
  })

  it('backs off on source errors and recovers within 5 minutes', async () => {
    const failFrom = edt(DAY, '10:00:00')
    const failUntil = edt(DAY, '10:10:00')
    const { oracle, live, publisher } = setup(edt(DAY, '09:55:00'))
    live.fail = (now) => now >= failFrom && now < failUntil
    await publisher.runLive(edt(DAY, '10:30:00'))

    const failed = attemptTimes(live.asked).filter((at) => at >= failFrom && at < failUntil)
    assert.ok(failed.length >= 2, `${failed.length} attempts during the outage`)
    assert.ok(failed.length <= 12, `${failed.length} attempts in 10 minutes is a tight loop`)
    const failureGaps = gaps(failed)
    failureGaps.forEach((gap) => assert.ok(gap >= 30, `retried after ${gap} s`))
    failureGaps.slice(1).forEach((gap, index) => {
      assert.ok(gap >= (failureGaps[index] ?? 0), `backoff shrank: ${failureGaps.join(', ')}`)
    })

    const calls = latestCalls(oracle)
    calls.forEach((call) => assert.ok(call.updates.length > 0, 'published an empty update'))
    const recovered = calls.map((call) => call.at).filter((at) => at >= failUntil)
    assert.ok((recovered[0] ?? Infinity) <= failUntil + 300, 'no update within 5 min of recovery')
    gaps(recovered).forEach((gap) => assert.ok(gap <= 60, `gap of ${gap} s after recovery`))
  })

  it('backs off when publish_latest itself fails', async () => {
    const failFrom = edt(DAY, '10:00:00')
    const failUntil = edt(DAY, '10:10:00')
    const { oracle, live, publisher } = setup(edt(DAY, '09:55:00'))
    oracle.failLatest = (now) => now >= failFrom && now < failUntil
    await publisher.runLive(edt(DAY, '10:30:00'))

    const failed = attemptTimes(live.asked).filter((at) => at >= failFrom && at < failUntil)
    assert.ok(failed.length >= 2 && failed.length <= 12, `${failed.length} attempts in 10 minutes`)
    gaps(failed).forEach((gap) => assert.ok(gap >= 30, `retried after ${gap} s`))
    const recovered = latestCalls(oracle).filter((call) => call.at >= failUntil)
    assert.ok((recovered[0]?.at ?? Infinity) <= failUntil + 300)
  })
})
