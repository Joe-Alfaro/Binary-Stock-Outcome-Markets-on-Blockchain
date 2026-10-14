// R39, R47, R50: in mock mode (`RELAY_1_SOURCE=mock`, `make dev`) the worker's latest-price loop
// keeps all 7 Markets tickers fresh, not just the ones the mock source used to have fixtures for.
// Wired the way `startWorker` wires it: the env-selected source with the worker clock's `now`,
// unknown tickers skipped, the worker's TICKERS, the relay clock and `runLiveLoop`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRelaySource } from '@meridian/price-providers'
import { FakeClock } from '../jobs/fake-clock.js'
import { TICKERS } from '../jobs/index.js'
import { createRelayPublisher } from './index.js'
import { relayClock, runLiveLoop, skippingUnknownTickers } from './run.js'
import { captureLog, createFakeOracle, edt } from './test-support.js'

const SECOND_MS = 1_000
/** Wednesday 2026-10-14, 10:00 ET: inside the regular session. */
const MID_SESSION = edt('2026-10-14', '10:00:00')
const TICK_SECS = 60

async function runMockLiveLoop(env: Record<string, string>, forSecs: number) {
  const clock = new FakeClock(MID_SESSION * SECOND_MS)
  const controller = new AbortController()
  const relay = relayClock(clock, controller.signal)
  const oracle = createFakeOracle(relay)
  const skipped: string[] = []
  const source = createRelaySource(env, 1, { now: () => Math.floor(clock.now() / SECOND_MS) })
  const publisher = createRelayPublisher({
    oracle,
    source,
    live: skippingUnknownTickers(source, (ticker) => skipped.push(ticker)),
    tickers: TICKERS,
    clock: relay,
    log: captureLog().write,
  })
  const done = runLiveLoop({ publisher, signal: controller.signal })
  await clock.advanceBy(forSecs * SECOND_MS)
  controller.abort()
  await done
  const ticks = oracle.calls.filter((call) => call.method === 'publishLatest')
  return { ticks, skipped }
}

describe('R47 worker latest-price loop in mock mode', () => {
  it('publishes a latest price for all 7 tickers and skips none', async () => {
    const { ticks, skipped } = await runMockLiveLoop({ RELAY_1_SOURCE: 'mock' }, TICK_SECS)

    assert.deepEqual(skipped, [], `the mock source has no live price for ${skipped.join(', ')}`)
    assert.ok(ticks.length > 0, 'the loop published nothing')
    const published = new Set(ticks.flatMap((tick) => tick.updates.map((update) => update.ticker)))
    assert.deepEqual([...published].sort(), [...TICKERS].sort())
  })

  it('refreshes every ticker on each tick through the session (at least every 60 s)', async () => {
    const { ticks } = await runMockLiveLoop({ RELAY_1_SOURCE: 'mock' }, 5 * TICK_SECS)

    assert.ok(ticks.length >= 5, `only ${ticks.length} ticks in 5 minutes`)
    ticks.forEach((tick) => {
      assert.deepEqual(
        tick.updates.map((update) => update.ticker).sort(),
        [...TICKERS].sort(),
        `tick at ${tick.at} missed a ticker`,
      )
      tick.updates.forEach((update) => {
        assert.equal(update.publishTime, tick.at, 'stamped with the worker clock')
        assert.ok(update.price > 0n, `${update.ticker} price is not positive`)
      })
    })
  })
})
