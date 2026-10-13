import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createMockSource, createRelaySource } from '@meridian/price-providers'
import { createRelayPublisher } from './index.js'
import {
  captureLog,
  createFakeClock,
  createFakeOracle,
  createScriptedSource,
  edt,
  findValueLog,
} from './test-support.js'

const DAY = '2026-10-12'
/** A demo market closing at 2:07 PM, not at a real close. */
const DEMO_CLOSE = edt(DAY, '14:07:00')

function setup(demo: boolean, closeTs: number) {
  const clock = createFakeClock(closeTs + 30)
  const oracle = createFakeOracle(clock)
  const log = captureLog()
  const publisher = createRelayPublisher({
    oracle,
    // The source the worker builds from its env: in demo mode the mock replays the recorded close.
    source: demo
      ? createRelaySource({ RELAY_1_SOURCE: 'mock', DEMO_MODE: 'true' })
      : createMockSource(),
    tickers: ['AAPL', 'MSFT'],
    clock,
    log: log.write,
    demo,
  })
  return { oracle, log, publisher }
}

describe('R44 demo relay', () => {
  it('replays a recorded close re-stamped to the demo close_ts', async () => {
    const { oracle, publisher } = setup(true, DEMO_CLOSE)
    const outcome = await publisher.publishClose('AAPL', DAY, DEMO_CLOSE)
    assert.equal(outcome.status, 'published')

    const close = oracle.calls.find((call) => call.method === 'publishClose')?.close
    assert.equal(close?.closeTs, DEMO_CLOSE)
    assert.equal(close?.tradingDay, 20_261_012)
    const [update] = close?.updates ?? []
    // The recorded AAPL official close of 2026-10-12 was $340.97, stamped 16:00:01 ET.
    assert.equal(update?.price, 3_409_700_000_000n)
    assert.equal(update?.publishTime, DEMO_CLOSE + 1)
    assert.equal(update?.officialClose, true)
  })

  it('labels every log line of a replayed close as replayed', async () => {
    const { oracle, log, publisher } = setup(true, DEMO_CLOSE)
    await publisher.publishClose('AAPL', DAY, DEMO_CLOSE)
    const entries = log.entries()
    assert.ok(entries.length > 0)
    entries.forEach((entry) => assert.equal(entry.replayed, true, JSON.stringify(entry)))

    const priceCall = oracle.calls.find((call) => call.method === 'publishPrice')
    const update = priceCall?.updates[0]
    assert.ok(priceCall && update)
    assert.ok(findValueLog(entries, update, priceCall.signature), 'replayed value not logged')
  })

  it('does not label a normal close as replayed, even from the mock source', async () => {
    const close = edt(DAY, '16:00:00')
    const { log, publisher } = setup(false, close)
    const outcome = await publisher.publishClose('AAPL', DAY, close)
    assert.equal(outcome.status, 'published')
    const entries = log.entries()
    assert.ok(entries.length > 0)
    entries.forEach((entry) => assert.notEqual(entry.replayed, true))
  })

  it('refuses demo mode with a live source', () => {
    const clock = createFakeClock(DEMO_CLOSE)
    assert.throws(
      () =>
        createRelayPublisher({
          oracle: createFakeOracle(clock),
          source: createScriptedSource(clock, () => null, 'yahoo'),
          tickers: ['AAPL'],
          clock,
          log: () => undefined,
          demo: true,
        }),
      /mock/,
    )
  })
})
