// R44, R67, D94: demo mode runs with the alpaca source. Live prices come from Alpaca; a demo
// market's close (a custom close_ts, not a real close) still replays the recorded close, labelled
// replayed. Nothing is refused.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { NormalizedPrice } from '@meridian/price-providers'
import { createRelayPublisher } from './index.js'
import {
  captureLog,
  createFakeClock,
  createFakeOracle,
  createScriptedSource,
  edt,
  price,
} from './test-support.js'
import type { Clock } from './types.js'

const DAY = '2026-10-12'
/** A demo market closing at 2:07 PM, not at a real close. */
const DEMO_CLOSE = edt(DAY, '14:07:00')
/** An Alpaca trade price, nowhere near the recorded $340.97 close. */
const ALPACA_AAPL = 352.5

/** A stand-in for the alpaca relay source: settlement inputs and live prices, recording calls. */
function fakeAlpaca(clock: Clock) {
  const live: number[] = []
  const closes = createScriptedSource(
    clock,
    (ticker, closeTs) => [price(ticker, ALPACA_AAPL, closeTs, { officialClose: true })],
    'alpaca',
  )
  return {
    ...closes,
    name: 'alpaca',
    live,
    async latest(ticker: string): Promise<NormalizedPrice> {
      live.push(clock.now())
      return price(ticker, ALPACA_AAPL, clock.now() - 2)
    },
  }
}

function setup(now: number) {
  const clock = createFakeClock(now)
  const oracle = createFakeOracle(clock)
  const log = captureLog()
  const alpaca = fakeAlpaca(clock)
  const publisher = createRelayPublisher({
    oracle,
    source: alpaca,
    live: alpaca,
    tickers: ['AAPL', 'MSFT'],
    clock,
    log: log.write,
    demo: true,
  })
  return { clock, oracle, log, alpaca, publisher }
}

describe('R44 demo relay on the alpaca source (D94)', () => {
  it('accepts the alpaca source in demo mode', () => {
    assert.doesNotThrow(() => setup(DEMO_CLOSE + 30))
  })

  it('settles a demo market from the replayed recorded close, not from Alpaca', async () => {
    const { oracle, alpaca, publisher } = setup(DEMO_CLOSE + 30)
    const outcome = await publisher.publishClose('AAPL', DAY, DEMO_CLOSE)
    assert.equal(outcome.status, 'published')

    const close = oracle.calls.find((call) => call.method === 'publishClose')?.close
    assert.equal(close?.closeTs, DEMO_CLOSE)
    const [update] = close?.updates ?? []
    // The recorded AAPL official close of 2026-10-12 was $340.97, stamped 16:00:01 ET.
    assert.equal(update?.price, 3_409_700_000_000n)
    assert.equal(update?.publishTime, DEMO_CLOSE + 1)
    assert.equal(alpaca.asked.size, 0, 'Alpaca was asked for a demo close')
  })

  it('labels every log line of the replayed close as replayed', async () => {
    const { log, publisher } = setup(DEMO_CLOSE + 30)
    await publisher.publishClose('AAPL', DAY, DEMO_CLOSE)
    const entries = log.entries()
    assert.ok(entries.some((entry) => entry.event === 'close-published'))
    entries.forEach((entry) => assert.equal(entry.replayed, true, JSON.stringify(entry)))
  })

  it('publishes live prices from Alpaca, not labelled replayed', async () => {
    const { oracle, log, alpaca, publisher } = setup(edt('2026-10-13', '11:00:00'))
    const outcome = await publisher.publishLatest()
    assert.equal(outcome.status, 'published')
    assert.ok(alpaca.live.length > 0, 'Alpaca was not asked for live prices')

    const [call] = oracle.calls.filter((entry) => entry.method === 'publishLatest')
    const aapl = call?.updates.find((update) => update.ticker === 'AAPL')
    assert.equal(aapl?.price, price('AAPL', ALPACA_AAPL, 0).price)

    const published = log.entries().filter((entry) => entry.event === 'latest-published')
    assert.ok(published.length > 0)
    published.forEach((entry) => {
      assert.equal(entry.source, 'alpaca')
      assert.notEqual(entry.replayed, true, JSON.stringify(entry))
    })
  })
})
