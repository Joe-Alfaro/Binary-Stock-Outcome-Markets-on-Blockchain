import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { tradingDayTimes } from '../calendar/index.js'
import { FakeChainClient } from '../chain/fake.js'
import { FakeClock } from './fake-clock.js'
import { runMorningScheduler } from './scheduler.js'
import { MINUTE, recordingAlerter, recordingLogger } from './test-support.js'

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
})
