import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PriceSourceError, type PreviousClose } from '@meridian/price-providers'
import { computeStrikes } from '@meridian/sdk'

import { tradingDayTimes } from '../calendar/index.js'
import { FakeChainClient } from '../chain/fake.js'
import { FakeClock } from './fake-clock.js'
import { TICKERS, nextMorningRun, runMorningJob, type MorningJobResult } from './morning.js'
import {
  MINUTE,
  SECOND,
  observe,
  recordingAlerter,
  recordingLogger,
  usd,
  type Running,
} from './test-support.js'

/** Previous closes in USD, chosen to cover rounding, deduplication and fractional prices. */
const PREVIOUS_CLOSES: Record<string, string> = {
  AAPL: '226.48',
  MSFT: '680',
  GOOGL: '230',
  AMZN: '185.5',
  NVDA: '140.07',
  META: '590.1',
  TSLA: '250',
}

function expectedStrikes(ticker: string): bigint[] {
  return computeStrikes(usd(PREVIOUS_CLOSES[ticker] ?? '0'))
}

/** 6:00, 7:30 and 8:00 AM ET on a trading day, in milliseconds. 9:00 AM ET is mint open. */
function morningTimes(tradingDay: string) {
  const nineAm = tradingDayTimes(tradingDay).mintOpenTs * 1000
  return {
    six: nineAm - 3 * 60 * MINUTE,
    sevenThirty: nineAm - 90 * MINUTE,
    eight: nineAm - 60 * MINUTE,
  }
}

type PreviousCloseFn = (ticker: string, previousTradingDay: string) => Promise<PreviousClose>

interface ProviderCall {
  ticker: string
  previousTradingDay: string
  at: number
}

function fakeProvider(clock: FakeClock, override?: PreviousCloseFn) {
  const calls: ProviderCall[] = []
  return {
    calls,
    async previousClose(ticker: string, previousTradingDay: string): Promise<PreviousClose> {
      calls.push({ ticker, previousTradingDay, at: clock.now() })
      if (override) return override(ticker, previousTradingDay)
      return {
        ticker,
        price: Number(PREVIOUS_CLOSES[ticker]),
        tradingDay: previousTradingDay,
      }
    },
  }
}

interface MorningSetup {
  tradingDay?: string
  chain?: FakeChainClient
  clock?: FakeClock
  previousClose?: PreviousCloseFn
}

function startMorning(setup: MorningSetup = {}) {
  const tradingDay = setup.tradingDay ?? '2026-11-30'
  const times = morningTimes(tradingDay)
  const clock = setup.clock ?? new FakeClock(times.six)
  const chain = setup.chain ?? new FakeChainClient(clock)
  const alerter = recordingAlerter(clock)
  const log = recordingLogger(clock)
  const provider = fakeProvider(clock, setup.previousClose)
  const job: Running<MorningJobResult> = observe(
    runMorningJob({ chain, provider, alerter, clock, log, tradingDay }),
  )
  return { tradingDay, times, clock, chain, alerter, log, provider, job }
}

function createdKeys(chain: FakeChainClient): string[] {
  return chain
    .allMarkets()
    .map((market) => `${market.ticker}:${market.strike}`)
    .sort()
}

function allExpectedKeys(tickers: readonly string[] = TICKERS): string[] {
  return tickers
    .flatMap((ticker) => expectedStrikes(ticker).map((strike) => `${ticker}:${strike}`))
    .sort()
}

describe('nextMorningRun (R15: starts at 6:00 AM ET on trading days)', () => {
  it('runs at 6:00 AM ET the same day when called before 6:00 on a trading day', () => {
    // 2026-11-25 05:00 EST = 10:00 UTC.
    const run = nextMorningRun(Date.parse('2026-11-25T10:00:00Z'))
    assert.deepEqual(run, {
      tradingDay: '2026-11-25',
      startMs: Date.parse('2026-11-25T11:00:00Z'),
    })
  })

  it('skips a holiday: Wednesday night before Thanksgiving runs Friday at 6:00 AM ET', () => {
    // 2026-11-25 23:00 EST = 2026-11-26 04:00 UTC.
    const run = nextMorningRun(Date.parse('2026-11-26T04:00:00Z'))
    assert.deepEqual(run, {
      tradingDay: '2026-11-27',
      startMs: Date.parse('2026-11-27T11:00:00Z'),
    })
  })

  it('skips the weekend, and 6:00 AM ET follows the DST change', () => {
    // Friday 2026-10-30 09:00 EDT, after that day's window; Monday 2026-11-02 is in EST.
    const run = nextMorningRun(Date.parse('2026-10-30T13:00:00Z'))
    assert.deepEqual(run, {
      tradingDay: '2026-11-02',
      startMs: Date.parse('2026-11-02T11:00:00Z'),
    })
  })

  it('a Saturday runs the following Monday at 6:00 AM ET (EDT)', () => {
    const run = nextMorningRun(Date.parse('2026-10-17T16:00:00Z'))
    assert.deepEqual(run, {
      tradingDay: '2026-10-19',
      startMs: Date.parse('2026-10-19T10:00:00Z'),
    })
  })

  it('a restart inside the 6:00 to 8:00 AM ET window runs today, right away', () => {
    // 2026-10-19 06:45 EDT.
    const now = Date.parse('2026-10-19T10:45:00Z')
    assert.deepEqual(nextMorningRun(now), { tradingDay: '2026-10-19', startMs: now })
  })

  it('after 8:00 AM ET the next run is the next trading day', () => {
    // 2026-10-19 08:00 EDT.
    const run = nextMorningRun(Date.parse('2026-10-19T12:00:00Z'))
    assert.deepEqual(run, {
      tradingDay: '2026-10-20',
      startMs: Date.parse('2026-10-20T10:00:00Z'),
    })
  })
})

describe('runMorningJob (R15, R12)', () => {
  it('creates every strike of all 7 tickers by 8:00 AM ET, one transaction per strike', async () => {
    const { job, clock, chain, times, alerter } = startMorning()
    const result = await job.finishBy(clock, times.eight)

    assert.deepEqual(createdKeys(chain), allExpectedKeys())
    // One create call per strike: no duplicates, no batching, each one landed.
    assert.equal(chain.creates.length, allExpectedKeys().length)
    chain.creates.forEach((call) => {
      assert.equal(typeof call.params.strike, 'bigint')
      assert.equal(call.outcome, 'created')
      assert.ok(call.at >= times.six, 'no market is created before 6:00 AM ET')
    })
    assert.deepEqual([...result.completeTickers].sort(), [...TICKERS].sort())
    assert.deepEqual(result.incompleteTickers, [])
    assert.deepEqual(alerter.alerts, [])
  })

  it('computes strikes from the previous close, e.g. 680 → 620..740 and 226.48 → 210..250', async () => {
    const { job, clock, chain, times } = startMorning()
    await job.finishBy(clock, times.eight)

    const strikes = (ticker: string) =>
      chain
        .marketsOf(ticker)
        .map((market) => market.strike)
        .sort((a, b) => Number(a - b))
    assert.deepEqual(strikes('MSFT'), [620n, 640n, 660n, 680n, 700n, 720n, 740n])
    assert.deepEqual(strikes('AAPL'), [210n, 220n, 230n, 240n, 250n])
    assert.deepEqual(strikes('GOOGL'), [210n, 220n, 230n, 240n, 250n])
  })

  it("asks for the expected previous trading day's close: Monday uses Friday", async () => {
    const { job, clock, provider, times } = startMorning({ tradingDay: '2026-11-30' })
    await job.finishBy(clock, times.eight)

    assert.deepEqual(
      [...new Set(provider.calls.map((call) => call.ticker))].sort(),
      [...TICKERS].sort(),
    )
    provider.calls.forEach((call) => assert.equal(call.previousTradingDay, '2026-11-27'))
  })

  it('writes calendar times: an early-close day closes at 1:00 PM ET and follows the holiday', async () => {
    const { job, clock, chain, provider, times } = startMorning({ tradingDay: '2026-11-27' })
    await job.finishBy(clock, times.eight)

    const expected = tradingDayTimes('2026-11-27')
    assert.equal(expected.closeTs, Date.parse('2026-11-27T18:00:00Z') / 1000)
    assert.ok(chain.creates.length > 0)
    chain.creates.forEach(({ params }) => {
      assert.equal(params.tradingDay, '2026-11-27')
      assert.equal(params.closeTs, expected.closeTs)
      assert.equal(params.mintOpenTs, expected.mintOpenTs)
      assert.equal(params.tradingOpenTs, expected.tradingOpenTs)
    })
    provider.calls.forEach((call) => assert.equal(call.previousTradingDay, '2026-11-25'))
  })

  it('is idempotent: a rerun creates nothing new and succeeds without alerts', async () => {
    const first = startMorning()
    await first.job.finishBy(first.clock, first.times.six + 30 * MINUTE)
    const before = createdKeys(first.chain)

    const second = startMorning({ clock: first.clock, chain: first.chain })
    const result = await second.job.finishBy(second.clock, second.times.eight)

    assert.deepEqual(createdKeys(first.chain), before)
    assert.deepEqual(result.incompleteTickers, [])
    assert.deepEqual([...result.completeTickers].sort(), [...TICKERS].sort())
    assert.equal(
      first.chain.creates.filter((call) => call.outcome === 'created').length,
      before.length,
      'no create call succeeded twice',
    )
    assert.deepEqual(second.alerter.alerts, [])
  })

  it('treats markets that already exist (created earlier by hand) as done', async () => {
    const clock = new FakeClock(morningTimes('2026-11-30').six)
    const chain = new FakeChainClient(clock)
    const { closeTs } = tradingDayTimes('2026-11-30')
    chain.addMarket({ ticker: 'MSFT', tradingDay: '2026-11-30', strike: 680n, closeTs })

    const { job, times, alerter } = startMorning({ clock, chain })
    const result = await job.finishBy(clock, times.eight)

    assert.deepEqual(createdKeys(chain), allExpectedKeys())
    assert.ok(result.completeTickers.includes('MSFT'))
    assert.deepEqual(alerter.alerts, [])
  })

  it('logs every create result, including failures', async () => {
    const clock = new FakeClock(morningTimes('2026-11-30').six)
    const chain = new FakeChainClient(clock)
    let failures = 1
    chain.createHook = (params) => {
      if (params.ticker === 'AMZN' && failures > 0) {
        failures -= 1
        throw new Error('rpc: blockhash not found')
      }
    }
    const { job, times, log } = startMorning({ clock, chain })
    await job.finishBy(clock, times.eight)

    assert.ok(chain.creates.length > allExpectedKeys().length, 'the failed attempt was retried')
    chain.creates.forEach((call) => {
      const logged = log.entries.filter(
        (entry) =>
          entry.details.ticker === call.params.ticker &&
          String(entry.details.strike) === String(call.params.strike),
      )
      assert.ok(logged.length > 0, `no log entry for ${call.params.ticker} ${call.params.strike}`)
    })
    const failedLogs = log.entries.filter(
      (entry) => entry.details.ticker === 'AMZN' && entry.level === 'error',
    )
    assert.ok(failedLogs.length > 0, 'the failed create is logged as an error')
  })

  it('retries a failing create with exponential backoff until it succeeds', async () => {
    const clock = new FakeClock(morningTimes('2026-11-30').six)
    const chain = new FakeChainClient(clock)
    const target = expectedStrikes('TSLA')[0]
    let failures = 4
    chain.createHook = (params) => {
      if (params.ticker === 'TSLA' && params.strike === target && failures > 0) {
        failures -= 1
        throw new Error('rpc: 503 service unavailable')
      }
    }
    const { job, times, alerter } = startMorning({ clock, chain })
    const result = await job.finishBy(clock, times.eight)

    const attempts = chain.creates
      .filter((call) => call.params.ticker === 'TSLA' && call.params.strike === target)
      .map((call) => call.at)
    assert.equal(attempts.length, 5, 'four failures, then one success')
    const gaps = attempts.slice(1).map((at, i) => at - (attempts[i] ?? at))
    gaps.slice(1).forEach((gap, i) => {
      assert.ok(gap > (gaps[i] ?? Infinity), `backoff grows: gaps ${gaps.join(', ')} ms`)
    })
    assert.ok(
      (gaps[3] ?? 0) >= 4 * (gaps[0] ?? Infinity),
      `exponential: gaps ${gaps.join(', ')} ms`,
    )
    assert.deepEqual(createdKeys(chain), allExpectedKeys())
    assert.deepEqual(result.incompleteTickers, [])
    assert.deepEqual(alerter.alerts, [])
  })

  it('retries a failing previous-close fetch with exponential backoff', async () => {
    const clock = new FakeClock(morningTimes('2026-11-30').six)
    let failures = 3
    const { job, times, chain, provider } = startMorning({
      clock,
      previousClose: async (ticker, previousTradingDay) => {
        if (ticker === 'AAPL' && failures > 0) {
          failures -= 1
          throw new PriceSourceError('rate-limited', 'HTTP 429')
        }
        return { ticker, price: Number(PREVIOUS_CLOSES[ticker]), tradingDay: previousTradingDay }
      },
    })
    await job.finishBy(clock, times.eight)

    const attempts = provider.calls.filter((call) => call.ticker === 'AAPL').map((call) => call.at)
    assert.equal(attempts.length, 4, 'three failures, then one success')
    const gaps = attempts.slice(1).map((at, i) => at - (attempts[i] ?? at))
    assert.ok(
      (gaps[0] ?? 0) > 0 && (gaps[1] ?? 0) > (gaps[0] ?? 0) && (gaps[2] ?? 0) > (gaps[1] ?? 0),
      `backoff grows: gaps ${gaps.join(', ')} ms`,
    )
    assert.deepEqual(createdKeys(chain), allExpectedKeys())
  })

  it('alerts exactly once at 7:30 AM ET when a ticker is still incomplete, and not before', async () => {
    const clock = new FakeClock(morningTimes('2026-11-30').six)
    const chain = new FakeChainClient(clock)
    chain.createHook = (params) => {
      if (params.ticker === 'TSLA') throw new Error('rpc: 503 service unavailable')
    }
    const { job, times, alerter } = startMorning({ clock, chain })

    await clock.advanceTo(times.sevenThirty - SECOND)
    assert.equal(alerter.alerts.length, 0, 'no alert before 7:30 AM ET')

    await clock.advanceTo(times.sevenThirty + MINUTE - SECOND)
    assert.equal(alerter.alerts.length, 1)
    const [alert] = alerter.alerts
    assert.equal(alert?.kind, 'morning_job_failure')
    assert.ok((alert?.at ?? 0) >= times.sevenThirty)
    assert.match(JSON.stringify(alert), /TSLA/)

    const result = await job.finishBy(clock, times.six + 6 * 60 * MINUTE)
    assert.deepEqual(result.incompleteTickers, ['TSLA'])
    assert.equal(result.completeTickers.length, 6)
    assert.deepEqual(
      createdKeys(chain),
      allExpectedKeys(TICKERS.filter((ticker) => ticker !== 'TSLA')),
    )
  })

  it('does not alert when a failing ticker recovers before 7:30 AM ET', async () => {
    const clock = new FakeClock(morningTimes('2026-11-30').six)
    const chain = new FakeChainClient(clock)
    const recoversAt = morningTimes('2026-11-30').six + 20 * MINUTE
    chain.createHook = (params) => {
      if (params.ticker === 'META' && clock.now() < recoversAt) throw new Error('rpc: timeout')
    }
    const { job, times, alerter } = startMorning({ clock, chain })
    const result = await job.finishBy(clock, times.eight)

    assert.deepEqual(createdKeys(chain), allExpectedKeys())
    assert.deepEqual(result.incompleteTickers, [])
    assert.deepEqual(alerter.alerts, [])
  })

  it('refuses a stale previous close (dated before the expected day): no markets, an alert', async () => {
    const clock = new FakeClock(morningTimes('2026-11-30').six)
    const { job, times, chain, alerter } = startMorning({
      clock,
      previousClose: async (ticker, previousTradingDay) => ({
        ticker,
        price: Number(PREVIOUS_CLOSES[ticker]),
        // Wednesday's close returned for Monday's markets, which need Friday's.
        tradingDay: ticker === 'NVDA' ? '2026-11-25' : previousTradingDay,
      }),
    })

    await clock.advanceTo(times.six + 10 * MINUTE)
    const stale = alerter.alerts.filter((alert) => /NVDA/.test(JSON.stringify(alert)))
    assert.ok(stale.length > 0, 'the stale close is alerted right away, not only at 7:30')
    stale.forEach((alert) => assert.equal(alert.kind, 'morning_job_failure'))

    const result = await job.finishBy(clock, times.six + 6 * 60 * MINUTE)
    assert.deepEqual(chain.marketsOf('NVDA'), [])
    assert.ok(result.incompleteTickers.includes('NVDA'))
    assert.deepEqual(
      createdKeys(chain),
      allExpectedKeys(TICKERS.filter((ticker) => ticker !== 'NVDA')),
    )
  })

  it('refuses a previous close the source reports as stale: no markets, an alert', async () => {
    const clock = new FakeClock(morningTimes('2026-11-30').six)
    const { job, times, chain, alerter } = startMorning({
      clock,
      previousClose: async (ticker, previousTradingDay) => {
        if (ticker === 'GOOGL') {
          throw new PriceSourceError('stale', `latest close is before ${previousTradingDay}`)
        }
        return { ticker, price: Number(PREVIOUS_CLOSES[ticker]), tradingDay: previousTradingDay }
      },
    })

    await clock.advanceTo(times.six + 10 * MINUTE)
    const stale = alerter.alerts.filter((alert) => /GOOGL/.test(JSON.stringify(alert)))
    assert.ok(stale.length > 0, 'the stale close is alerted right away, not only at 7:30')
    stale.forEach((alert) => assert.equal(alert.kind, 'morning_job_failure'))

    const result = await job.finishBy(clock, times.six + 6 * 60 * MINUTE)
    assert.deepEqual(chain.marketsOf('GOOGL'), [])
    assert.ok(result.incompleteTickers.includes('GOOGL'))
  })
})
