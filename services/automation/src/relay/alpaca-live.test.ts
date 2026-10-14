// R67, R47: the latest-price loop reads the Alpaca stream. A tick asks the source for every
// ticker, which must not turn into one REST request per ticker (or any REST request at all once
// the stream is up). A local fake websocket server replays the recorded 2026-10-14 session.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createAlpacaSource } from '@meridian/price-providers'
import type { AlpacaStreamEvent } from '@meridian/price-providers'
import {
  ALPACA_TEST_KEYS,
  alpacaFixtures,
  alpacaRoute,
  lastTrades,
  startFakeAlpacaStream,
  tradeMessage,
  transcriptDataBatches,
  waitUntil,
} from '@meridian/price-providers/testing'
import type { FakeAlpacaStream } from '@meridian/price-providers/testing'
import { createRelayPublisher } from './index.js'
import {
  captureLog,
  createFakeClock,
  createFakeOracle,
  createScriptedSource,
  edt,
} from './test-support.js'

const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA']
const START = edt('2026-10-14', '11:11:30')
const EXPO = -10

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

/** The recorded session, plus one TSLA trade (the recording has none) so all 7 have a price. */
function batches() {
  return [
    ...transcriptDataBatches(alpacaFixtures.quotes()),
    ...transcriptDataBatches(alpacaFixtures.trades()),
    [tradeMessage('TSLA', 376.1, '2026-10-14T15:11:22Z')],
  ]
}

interface SentRequest {
  url: URL
}

async function setup() {
  const server = await startFakeAlpacaStream({ ...ALPACA_TEST_KEYS, afterSubscribe: batches() })
  cleanups.push(() => server.close())
  const requests: SentRequest[] = []
  const route = alpacaRoute({ snapshots: alpacaFixtures.snapshots() })
  const fetchStub = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    requests.push({ url })
    return route(url)
  }) as typeof fetch
  const clock = createFakeClock(START)
  const events: AlpacaStreamEvent[] = []
  const source = createAlpacaSource({
    ...ALPACA_TEST_KEYS,
    fetch: fetchStub,
    now: () => clock.now(),
    tickers: TICKERS,
    stream: {
      url: server.url,
      reconnect: { initialMs: 10, maxMs: 80 },
      onEvent: (event) => events.push(event),
    },
  })
  cleanups.push(() => source.close())
  const oracle = createFakeOracle(clock)
  const log = captureLog()
  const publisher = createRelayPublisher({
    oracle,
    source: createScriptedSource(clock, () => null),
    live: source,
    tickers: TICKERS,
    clock,
    log: log.write,
  })
  return { server, requests, clock, events, oracle, publisher }
}

async function streaming(events: AlpacaStreamEvent[]) {
  await waitUntil(() => events.some((event) => event.type === 'subscribed'), 2000, 'subscribed')
  await new Promise((resolve) => setTimeout(resolve, 50))
}

function latestCalls(oracle: Awaited<ReturnType<typeof setup>>['oracle']) {
  return oracle.calls.filter((call) => call.method === 'publishLatest')
}

function dollars(price: bigint): number {
  return Number(price) * 10 ** EXPO
}

/** No request for a single ticker: any REST call covers every ticker at once. */
function assertNoPerTickerRequests(requests: SentRequest[]) {
  requests.forEach(({ url }) => {
    const symbols = url.searchParams.get('symbols')?.split(',') ?? []
    assert.deepEqual([...symbols].sort(), [...TICKERS].sort(), `per-ticker request: ${url}`)
  })
}

describe('R67 latest-price loop on the Alpaca stream', () => {
  it('publishes the stream prices for all 7 tickers with no REST polling', async () => {
    const { requests, events, oracle, publisher } = await setup()
    // The first tick opens the stream; until it is up, at most one snapshot covers every ticker.
    await publisher.publishLatest()
    assert.ok(requests.length <= 1, `${requests.length} requests on the first tick`)
    assertNoPerTickerRequests(requests)
    await streaming(events)
    const before = requests.length

    const outcome = await publisher.publishLatest()

    assert.equal(outcome.status, 'published')
    const published = latestCalls(oracle).flatMap((call) => call.updates)
    const trades = lastTrades(alpacaFixtures.trades())
    trades.forEach((trade, ticker) => {
      const update = published.filter((entry) => entry.ticker === ticker).at(-1)
      assert.ok(update, `${ticker} was published`)
      assert.ok(Math.abs(dollars(update.price) - trade.p) < 1e-6, `${ticker} is the stream price`)
    })
    assert.deepEqual(
      [...new Set(published.map((update) => update.ticker))].sort(),
      [...TICKERS].sort(),
    )
    assert.equal(requests.length, before, 'no REST request once streaming')
  })

  it('runs a stretch of the session without a single REST request', async () => {
    const { requests, events, publisher } = await setup()
    await publisher.publishLatest()
    await streaming(events)
    const before = requests.length

    await publisher.runLive(START + 10 * 60)

    assert.equal(requests.length, before, `${requests.length - before} REST requests in 10 minutes`)
  })

  it('publishes a new stream trade on the next tick', async () => {
    const { server, requests, events, oracle, publisher } = await setup()
    await publisher.publishLatest()
    await streaming(events)
    await publisher.publishLatest()
    const before = requests.length
    const sentBefore = latestCalls(oracle).length

    await sendAndSettle(server, tradeMessage('AAPL', 351.25, '2026-10-14T15:11:40Z'))
    const outcome = await publisher.publishLatest()

    assert.deepEqual(outcome.tickers, ['AAPL'])
    const call = latestCalls(oracle)[sentBefore]
    assert.ok(call)
    assert.ok(Math.abs(dollars(call.updates[0]?.price ?? 0n) - 351.25) < 1e-6)
    assert.equal(requests.length, before)
  })

  it('while the stream is down, a tick costs one snapshot request, not one per ticker', async () => {
    const { server, requests, publisher } = await setup()
    await server.stop()

    await publisher.publishLatest()

    assert.equal(requests.length, 1, `${requests.length} requests for one tick`)
    assertNoPerTickerRequests(requests)
  })
})

async function sendAndSettle(server: FakeAlpacaStream, message: Record<string, unknown>) {
  server.send([message])
  await new Promise((resolve) => setTimeout(resolve, 50))
}
