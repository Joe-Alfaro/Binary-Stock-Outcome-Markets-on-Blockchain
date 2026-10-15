import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { tradingDayTimes } from '../calendar/index.js'
import { FakeChainClient } from '../chain/fake.js'
import type { OracleKind, OracleSlot } from '../chain/index.js'
import type { OracleSlotSettings } from '../config.js'
import { FakeClock } from './fake-clock.js'
import { runSettlementJob } from './settlement.js'
import { MINUTE, SECOND, observe, recordingAlerter, recordingLogger, usd } from './test-support.js'

const DAY = '2026-10-12'
const PREVIOUS_DAY = '2026-10-09'
const CLOSE_TS = tradingDayTimes(DAY).closeTs
const CLOSE = CLOSE_TS * 1000
const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA']
const STRIKES = [210n, 220n, 230n, 240n, 250n]

/** Milliseconds at `close_ts + minutes:seconds`. */
function at(minutes: number, seconds = 0): number {
  return CLOSE + minutes * MINUTE + seconds * SECOND
}

interface Setup {
  startMs?: number
  slotSettings?: OracleSlotSettings
  slot2?: OracleKind
  tickers?: string[]
  strikes?: bigint[]
}

function setup(options: Setup = {}) {
  const clock = new FakeClock(options.startMs ?? at(-10))
  const chain = new FakeChainClient(clock)
  chain.slots = { slot1: 'MeridianRelay', slot2: options.slot2 ?? 'Disabled' }
  const tickers = options.tickers ?? ['AAPL']
  tickers.forEach((ticker) =>
    (options.strikes ?? STRIKES).forEach((strike) =>
      chain.addMarket({ ticker, tradingDay: DAY, strike, closeTs: CLOSE_TS }),
    ),
  )
  const alerter = recordingAlerter(clock)
  const log = recordingLogger(clock)
  return { clock, chain, alerter, log, slotSettings: options.slotSettings }
}

type Env = ReturnType<typeof setup>

/** Starts a job instance; `stop` aborts it and requires it to wind down. */
function start({ clock, chain, alerter, log, slotSettings }: Env) {
  const controller = new AbortController()
  const job = observe(
    runSettlementJob({
      chain,
      alerter,
      clock,
      log,
      signal: controller.signal,
      ...(slotSettings ? { slotSettings } : {}),
    }),
  )
  return {
    job,
    async stop(drainMs = 0) {
      controller.abort()
      await job.finishBy(clock, clock.now() + drainMs)
    },
  }
}

/** Distinct times (ms) at which the job tried `settle_market` for a ticker-day from a slot. */
function attemptTimes(env: Env, ticker: string, slot: OracleSlot, tradingDay = DAY): number[] {
  const times = env.chain.settleCalls
    .filter(
      (call) =>
        call.market.ticker === ticker &&
        call.market.tradingDay === tradingDay &&
        call.slot === slot,
    )
    .map((call) => call.at)
  return [...new Set(times)].sort((a, b) => a - b)
}

function within(times: number[], fromMs: number, toMs: number): number[] {
  return times.filter((time) => time >= fromMs && time <= toMs)
}

function minutesAfterClose(times: number[]): string {
  return times.map((time) => ((time - CLOSE) / MINUTE).toFixed(2)).join(', ')
}

/** Asserts each actual time is within `toleranceMs` of the expected time at the same index. */
function assertSchedule(actual: number[], expected: number[], toleranceMs = 5 * SECOND): void {
  const message = `attempts at +[${minutesAfterClose(actual)}] min, expected +[${minutesAfterClose(expected)}]`
  assert.equal(actual.length, expected.length, message)
  actual.forEach((time, i) => {
    assert.ok(Math.abs(time - (expected[i] ?? Infinity)) <= toleranceMs, message)
  })
}

/** R37 at +60: the admin must finalize the pending price; the worker holds no admin key (D93). */
const FINALIZE_ALERT = 'settlement_admin_finalize'

function alertsOfKind(env: Env, kind: string) {
  return env.alerter.alerts.filter((alert) => alert.kind === kind)
}

function assertAllSettled(env: Env, byMs: number, tickers: string[], tradingDay = DAY): void {
  tickers.forEach((ticker) => {
    const markets = env.chain.marketsOf(ticker, tradingDay)
    assert.ok(markets.length > 0, `${ticker} has markets`)
    markets.forEach((market) => {
      assert.ok(market.settlement, `${ticker} ${market.strike} (${tradingDay}) is settled`)
      assert.ok(
        (market.settlement?.at ?? Infinity) <= byMs,
        `${ticker} ${market.strike} settled at +${minutesAfterClose([market.settlement?.at ?? 0])} min`,
      )
    })
  })
}

describe('settlement escalation schedule (R37, D14)', () => {
  it('does not try to settle before close_ts', async () => {
    const env = setup({ startMs: at(-60) })
    const job = start(env)
    await env.clock.advanceTo(at(0) - SECOND)
    assert.deepEqual(env.chain.settleCalls, [])
    await env.clock.advanceTo(at(1))
    assert.ok(attemptTimes(env, 'AAPL', 1).length > 0, 'polling starts at close')
    await job.stop()
  })

  it('polls slot 1 every 30 s for the first 15 minutes (about 30 attempts) with no alert', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(15) - SECOND)

    const attempts = within(attemptTimes(env, 'AAPL', 1), at(0), at(15) - 1)
    assert.ok(
      attempts.length >= 29 && attempts.length <= 31,
      `${attempts.length} attempts at +[${minutesAfterClose(attempts)}] min`,
    )
    assert.ok((attempts[0] ?? Infinity) <= at(0, 30), 'the first attempt is at close')
    attempts.slice(1).forEach((time, i) => {
      const gap = time - (attempts[i] ?? 0)
      assert.ok(gap >= 25 * SECOND && gap <= 35 * SECOND, `gap of ${gap} ms`)
    })
    assert.deepEqual(env.alerter.alerts, [], 'no alert before +15 min')
    await job.stop()
  })

  it('sends exactly one first alert at +15, then polls slot 1 every 3 minutes from +16', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(15, 30))

    const first = alertsOfKind(env, 'settlement_first_alert')
    assert.equal(first.length, 1)
    assert.ok((first[0]?.at ?? 0) >= at(15) && (first[0]?.at ?? Infinity) < at(15, 30))
    assert.match(JSON.stringify(first[0]), /AAPL/)

    await env.clock.advanceTo(at(45))
    assertSchedule(
      within(attemptTimes(env, 'AAPL', 1), at(15) + SECOND, at(45)),
      [16, 19, 22, 25, 28, 31, 34, 37, 40, 43].map((minute) => at(minute)),
    )
    assert.equal(alertsOfKind(env, 'settlement_first_alert').length, 1, 'still one first alert')
    assert.equal(alertsOfKind(env, 'settlement_second_alert').length, 0)
    await job.stop()
  })

  it('sends exactly one second alert at +50', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(50) - SECOND)
    assert.equal(alertsOfKind(env, 'settlement_second_alert').length, 0, 'none before +50')

    await env.clock.advanceTo(at(59))
    const second = alertsOfKind(env, 'settlement_second_alert')
    assert.equal(second.length, 1)
    assert.ok((second[0]?.at ?? 0) >= at(50) && (second[0]?.at ?? Infinity) < at(50, 30))
    assert.equal(alertsOfKind(env, 'settlement_first_alert').length, 1)
    await job.stop()
  })

  it('never polls slot 2 while it is disabled', async () => {
    const env = setup({ slot2: 'Disabled' })
    const job = start(env)
    await env.clock.advanceTo(at(70))
    assert.deepEqual(attemptTimes(env, 'AAPL', 2), [])
    await job.stop()
  })

  it('never polls slot 2 while ORACLE_SLOT_2 is disabled, even when Config enables it (R32)', async () => {
    const env = setup({
      slot2: 'MeridianRelay',
      slotSettings: { slot1: { kind: 'relay' }, slot2: { kind: 'disabled' } },
    })
    const job = start(env)
    await env.clock.advanceTo(at(6))
    // Only slot 2 has a price, and this worker doesn't settle from slot 2.
    env.chain.publishClose(2, 'AAPL', DAY, usd('230.00'))
    await env.clock.advanceTo(at(30))

    assert.deepEqual(attemptTimes(env, 'AAPL', 2), [])
    assert.ok(attemptTimes(env, 'AAPL', 1).length > 0, 'slot 1 is still polled')
    await job.stop()
  })

  it('polls slot 2 once ORACLE_SLOT_2 names a kind (R32)', async () => {
    const env = setup({
      slot2: 'MeridianRelay',
      slotSettings: { slot1: { kind: 'relay' }, slot2: { kind: 'relay' } },
    })
    const job = start(env)
    await env.clock.advanceTo(at(6))
    env.chain.publishClose(2, 'AAPL', DAY, usd('230.00'))
    await env.clock.advanceTo(at(7))

    assertAllSettled(env, at(7), ['AAPL'])
    await job.stop()
  })

  it('never polls slot 1 while ORACLE_SLOT_1 is disabled (R32)', async () => {
    const env = setup({
      slot2: 'MeridianRelay',
      slotSettings: { slot1: { kind: 'disabled' }, slot2: { kind: 'relay' } },
    })
    const job = start(env)
    await env.clock.advanceTo(at(30))

    assert.deepEqual(attemptTimes(env, 'AAPL', 1), [])
    assert.ok(attemptTimes(env, 'AAPL', 2).length > 0, 'slot 2 is still polled')
    await job.stop()
  })

  it('polls an enabled slot 2 every 30 s from +4, then every 3 minutes offset by 1 minute', async () => {
    const env = setup({ slot2: 'MeridianRelay' })
    const job = start(env)
    await env.clock.advanceTo(at(30))

    const slot2 = attemptTimes(env, 'AAPL', 2)
    assert.deepEqual(within(slot2, at(0), at(4) - 1), [], 'slot 2 waits until +4 min')
    const early = within(slot2, at(4), at(15) - 1)
    assert.ok(
      early.length >= 21 && early.length <= 23,
      `${early.length} slot 2 attempts at +[${minutesAfterClose(early)}] min`,
    )
    assertSchedule(
      within(slot2, at(15) + SECOND, at(30)),
      [17, 20, 23, 26, 29].map((minute) => at(minute)),
    )
    assertSchedule(
      within(attemptTimes(env, 'AAPL', 1), at(15) + SECOND, at(30)),
      [16, 19, 22, 25, 28].map((minute) => at(minute)),
    )
    await job.stop()
  })

  it('at +60 with a pending admin price, alerts the admin to finalize it and never finalizes', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(20))
    env.chain.proposeAdminPrice('AAPL', DAY, usd('231.07'))

    await env.clock.advanceTo(at(60) - SECOND)
    assert.deepEqual(alertsOfKind(env, FINALIZE_ALERT), [], 'no finalize alert before +60')

    await env.clock.advanceTo(at(61))
    const alerts = alertsOfKind(env, FINALIZE_ALERT)
    assert.equal(alerts.length, 1, 'exactly one finalize alert at +60')
    assert.ok(
      Math.abs((alerts[0]?.at ?? Infinity) - at(60)) <= 5 * SECOND,
      'the alert fires at +60',
    )
    assert.match(alerts[0]?.message ?? '', /finalize/i)
    const details = JSON.stringify(alerts[0]?.details)
    assert.match(details, /AAPL/)
    assert.match(details, new RegExp(DAY))
    assert.match(details, /231\.07/)
    assert.deepEqual(env.chain.finalizeCalls, [], 'the worker never finalizes (D93)')
    assert.ok(env.chain.marketsOf('AAPL').every((market) => !market.settlement))

    await env.clock.advanceTo(at(90))
    assert.equal(alertsOfKind(env, FINALIZE_ALERT).length, 1, 'the alert is not repeated')
    assert.deepEqual(env.chain.finalizeCalls, [])
    await job.stop()
  })

  it('once the admin finalizes, settles every strike at the admin price', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(20))
    env.chain.proposeAdminPrice('AAPL', DAY, usd('231.07'))
    await env.clock.advanceTo(at(65))
    env.chain.finalizeByAdmin('AAPL', DAY)

    await env.clock.advanceTo(at(69))
    assertAllSettled(env, at(69), ['AAPL'])
    env.chain.marketsOf('AAPL').forEach((market) => {
      assert.deepEqual(market.settlement?.price, usd('231.07'))
      assert.equal(market.settlement?.source, 'admin')
    })
    assert.deepEqual(env.chain.finalizeCalls, [])
    await job.stop()
  })

  it('sends no finalize alert at +60 when no admin price is pending', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(75))
    assert.deepEqual(alertsOfKind(env, FINALIZE_ALERT), [])
    assert.deepEqual(env.chain.finalizeCalls, [])
    await job.stop()
  })

  it('without a pending price at +60, keeps polling and settles when the oracle answers', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(75))
    assert.deepEqual(env.chain.finalizeCalls, [])
    assert.ok(within(attemptTimes(env, 'AAPL', 1), at(60), at(75)).length >= 4, 'still polling')

    env.chain.publishClose(1, 'AAPL', DAY, usd('228.40'))
    await env.clock.advanceTo(at(79))
    assertAllSettled(env, at(79), ['AAPL'])
    await job.stop()
  })

  it('alerts the admin to finalize promptly when the price is proposed after +60', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(70))
    env.chain.proposeAdminPrice('AAPL', DAY, usd('229.99'))

    await env.clock.advanceTo(at(73, 30))
    const alerts = alertsOfKind(env, FINALIZE_ALERT)
    assert.equal(alerts.length, 1)
    assert.match(JSON.stringify(alerts[0]?.details), /229\.99/)
    assert.deepEqual(env.chain.finalizeCalls, [], 'the worker never finalizes (D93)')
    await job.stop()
  })
})

describe('settlement outcomes (R37, R36)', () => {
  it('stops polling a ticker-day once the first valid answer settles it', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(7))
    env.chain.publishClose(1, 'AAPL', DAY, usd('233.10'))

    await env.clock.advanceTo(at(8))
    assertAllSettled(env, at(8), ['AAPL'])
    env.chain.marketsOf('AAPL').forEach((market) => {
      assert.deepEqual(market.settlement?.price, usd('233.10'))
    })
    await env.clock.advanceTo(at(70))
    assert.deepEqual(
      env.chain.settleCalls.filter((call) => call.at > at(8)),
      [],
      'no settle attempts after the ticker-day settled',
    )
    assert.deepEqual(env.chain.finalizeCalls, [])
    assert.deepEqual(env.alerter.alerts, [])
    await job.stop()
  })

  it('settles from slot 2 when only slot 2 answers, then stops polling both slots', async () => {
    const env = setup({ slot2: 'MeridianRelay' })
    const job = start(env)
    await env.clock.advanceTo(at(6))
    env.chain.publishClose(2, 'AAPL', DAY, usd('230.00'))

    await env.clock.advanceTo(at(7))
    assertAllSettled(env, at(7), ['AAPL'])
    env.chain.marketsOf('AAPL').forEach((market) => assert.equal(market.settlement?.source, 2))
    await env.clock.advanceTo(at(70))
    assert.deepEqual(
      env.chain.settleCalls.filter((call) => call.at > at(7)),
      [],
    )
    assert.deepEqual(env.alerter.alerts, [])
    await job.stop()
  })

  it('treats "already settled" as success: no alert, no more polling', async () => {
    const env = setup()
    env.chain.settleHook = (market) => {
      if (market.ticker === 'AAPL' && env.clock.now() >= at(2)) {
        env.chain.settleExternally('AAPL', DAY, usd('231.50'))
      }
    }
    const job = start(env)
    await env.clock.advanceTo(at(70))

    const alreadySettled = env.chain.settleCalls.filter(
      (call) =>
        typeof call.outcome === 'object' &&
        'status' in call.outcome &&
        call.outcome.status === 'already_settled',
    )
    assert.ok(alreadySettled.length > 0, 'the job saw "already settled"')
    assert.deepEqual(
      env.chain.settleCalls.filter((call) => call.at > at(4)),
      [],
    )
    assert.deepEqual(env.alerter.alerts, [])
    await job.stop()
  })

  it('alerts AdminPriceMismatch when the oracle settles at a price other than the pending one', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(20))
    env.chain.proposeAdminPrice('AAPL', DAY, usd('190.00'))
    await env.clock.advanceTo(at(30))
    env.chain.publishClose(1, 'AAPL', DAY, usd('191.23'))

    await env.clock.advanceTo(at(35))
    assertAllSettled(env, at(35), ['AAPL'])
    env.chain.marketsOf('AAPL').forEach((market) => {
      assert.deepEqual(market.settlement?.price, usd('191.23'), 'the oracle answer wins')
    })
    const mismatch = alertsOfKind(env, 'admin_price_mismatch')
    assert.equal(mismatch.length, 1)
    const details = JSON.stringify(mismatch[0]?.details)
    assert.match(details, /AAPL/)
    assert.match(details, /191\.23/)
    assert.match(details, /(^|[^\d.])190(\.0+)?([^\d.]|$)/)

    await env.clock.advanceTo(at(70))
    assert.deepEqual(env.chain.finalizeCalls, [], 'a settled ticker-day is not finalized')
    assert.equal(alertsOfKind(env, 'admin_price_mismatch').length, 1)
    await job.stop()
  })

  it('does not alert a mismatch when the oracle price equals the pending one', async () => {
    const env = setup()
    const job = start(env)
    await env.clock.advanceTo(at(20))
    env.chain.proposeAdminPrice('AAPL', DAY, usd('191.23'))
    await env.clock.advanceTo(at(30))
    env.chain.publishClose(1, 'AAPL', DAY, usd('191.23'))

    await env.clock.advanceTo(at(40))
    assertAllSettled(env, at(40), ['AAPL'])
    assert.deepEqual(alertsOfKind(env, 'admin_price_mismatch'), [])
    await job.stop()
  })

  it("settles tickers independently: one ticker's failures delay no other", async () => {
    const env = setup({ tickers: TICKERS })
    env.chain.settleHook = async (market) => {
      if (market.ticker === 'AAPL') throw new Error('rpc: 503 service unavailable')
      if (market.ticker === 'MSFT') await env.clock.sleep(10 * MINUTE)
    }
    const job = start(env)
    await env.clock.advanceTo(at(1))
    TICKERS.forEach((ticker) => env.chain.publishClose(1, ticker, DAY, usd('230.00')))

    await env.clock.advanceTo(at(5))
    assertAllSettled(env, at(5), ['GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'])
    await job.stop(120 * MINUTE)
  })
})

describe('settlement discovery and restarts (R37)', () => {
  it('settles a market added with add_strike at 2 PM, found on-chain', async () => {
    const env = setup({ startMs: at(-390) })
    const job = start(env)
    await env.clock.advanceTo(at(-120))
    env.chain.addMarket({ ticker: 'AAPL', tradingDay: DAY, strike: 260n, closeTs: CLOSE_TS })

    await env.clock.advanceTo(at(1))
    env.chain.publishClose(1, 'AAPL', DAY, usd('262.00'))
    await env.clock.advanceTo(at(5))
    assertAllSettled(env, at(5), ['AAPL'])
    assert.equal(env.chain.marketsOf('AAPL').length, STRIKES.length + 1)
    assert.ok(env.chain.settleCalls.every((call) => call.at >= CLOSE))
    await job.stop()
  })

  it('a worker restarted during the day still settles everything', async () => {
    const env = setup({ startMs: at(-390), tickers: TICKERS })
    const first = start(env)
    await env.clock.advanceTo(at(-240))
    await first.stop()

    await env.clock.advanceTo(at(-180))
    const second = start(env)
    await env.clock.advanceTo(at(1))
    TICKERS.forEach((ticker) => env.chain.publishClose(1, ticker, DAY, usd('230.00')))
    await env.clock.advanceTo(at(5))
    assertAllSettled(env, at(5), TICKERS)
    await second.stop()
  })

  it('a worker restarted after +15 goes straight to 3-minute polling', async () => {
    const env = setup({ startMs: at(-1) })
    const first = start(env)
    await env.clock.advanceTo(at(20))
    await first.stop()

    const second = start(env)
    await env.clock.advanceTo(at(30))
    const attempts = within(attemptTimes(env, 'AAPL', 1), at(20), at(30))
    attempts.slice(1).forEach((time, i) => {
      const gap = time - (attempts[i] ?? 0)
      assert.ok(gap >= 150 * SECOND, `attempts at +[${minutesAfterClose(attempts)}] min`)
    })
    ;[22, 25, 28].forEach((minute) => {
      assert.ok(
        attempts.some((time) => Math.abs(time - at(minute)) <= 5 * SECOND),
        `an attempt at +${minute} min; got +[${minutesAfterClose(attempts)}]`,
      )
    })
    await second.stop()
  })

  it('a worker restarted after +60 alerts the admin to finalize a pending price right away', async () => {
    const env = setup({ startMs: at(-1) })
    const first = start(env)
    await env.clock.advanceTo(at(20))
    env.chain.proposeAdminPrice('AAPL', DAY, usd('227.35'))
    await env.clock.advanceTo(at(30))
    await first.stop()

    await env.clock.advanceTo(at(75))
    const second = start(env)
    await env.clock.advanceTo(at(76))
    const alerts = alertsOfKind(env, FINALIZE_ALERT)
    assert.equal(alerts.length, 1)
    assert.match(JSON.stringify(alerts[0]?.details), /227\.35/)
    assert.deepEqual(env.chain.finalizeCalls, [], 'the worker never finalizes (D93)')
    await second.stop()
  })

  it("picks up an earlier day's unsettled markets, from the oracle or the admin price", async () => {
    const previousCloseTs = tradingDayTimes(PREVIOUS_DAY).closeTs
    // Monday 9:00 AM ET, three days after Friday's close.
    const env = setup({ startMs: tradingDayTimes(DAY).mintOpenTs * 1000 })
    STRIKES.forEach((strike) => {
      env.chain.addMarket({
        ticker: 'NVDA',
        tradingDay: PREVIOUS_DAY,
        strike,
        closeTs: previousCloseTs,
      })
      env.chain.addMarket({
        ticker: 'META',
        tradingDay: PREVIOUS_DAY,
        strike,
        closeTs: previousCloseTs,
      })
    })
    env.chain.publishClose(1, 'NVDA', PREVIOUS_DAY, usd('231.00'))
    env.chain.proposeAdminPrice('META', PREVIOUS_DAY, usd('225.00'))

    const job = start(env)
    const alerted = env.clock.now() + 2 * MINUTE
    await env.clock.advanceTo(alerted)
    assertAllSettled(env, alerted, ['NVDA'], PREVIOUS_DAY)
    const alerts = alertsOfKind(env, FINALIZE_ALERT)
    assert.equal(alerts.length, 1, "the admin is told to finalize META's pending price")
    assert.match(JSON.stringify(alerts[0]?.details), /META/)
    assert.deepEqual(env.chain.finalizeCalls, [], 'the worker never finalizes (D93)')

    env.chain.finalizeByAdmin('META', PREVIOUS_DAY)
    const deadline = env.clock.now() + 5 * MINUTE
    await env.clock.advanceTo(deadline)
    assertAllSettled(env, deadline, ['META'], PREVIOUS_DAY)
    env.chain.marketsOf('META', PREVIOUS_DAY).forEach((market) => {
      assert.equal(market.settlement?.source, 'admin')
    })
    assert.ok(
      env.chain.marketsOf('AAPL', DAY).every((market) => !market.settlement),
      "today's markets wait for today's close",
    )
    await job.stop()
  })
})

describe('settlement latency (R38)', () => {
  const cases = [
    { name: 'an official close published at +1 min', publishAt: at(1) },
    {
      name: 'an interpolation pair published at +3 min, the latest the relay waits',
      publishAt: at(3),
    },
  ]
  cases.forEach(({ name, publishAt }) => {
    it(`settles all 49 markets of the day by close_ts + 5 min with ${name}`, async () => {
      const env = setup({ tickers: TICKERS, strikes: [200n, 210n, 220n, 230n, 240n, 250n, 260n] })
      const job = start(env)
      await env.clock.advanceTo(publishAt)
      TICKERS.forEach((ticker, i) =>
        env.chain.publishClose(1, ticker, DAY, usd(`${225 + i}.${10 + i}`)),
      )

      await env.clock.advanceTo(at(5))
      assert.equal(env.chain.allMarkets().length, 49)
      assertAllSettled(env, at(5), TICKERS)
      assert.deepEqual(env.alerter.alerts, [])
      await job.stop()
    })
  })
})
