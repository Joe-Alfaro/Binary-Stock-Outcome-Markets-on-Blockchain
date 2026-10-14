// R67: live prices from Alpaca's websocket stream, against a local fake server that replays the
// recorded 2026-10-14 sessions. Nothing here reaches the network.
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createAlpacaSource, createAlpacaStream } from './index.js'
import type { AlpacaSource, AlpacaStream, AlpacaStreamEvent } from './index.js'
import {
  startFakeAlpacaStream,
  transcriptDataBatches,
  waitUntil,
} from './alpaca-fake-stream.js'
import type { AlpacaBatch, FakeAlpacaStream } from './alpaca-fake-stream.js'
import {
  KEYS,
  STREAM_NOW,
  TICKERS,
  alpacaRoute,
  fixtures,
  lastQuotes,
  lastTrades,
  tradeMessage,
  unixOf,
} from './alpaca-test-support.js'
import { assertClose, confOf, fakeFetch, valueOf } from './test-support.js'

const RECONNECT = { initialMs: 10, maxMs: 80 }

/** The recorded quotes session, then the recorded trades session: the order they happened in. */
function recordedBatches(): AlpacaBatch[] {
  return [...transcriptDataBatches(fixtures.quotes()), ...transcriptDataBatches(fixtures.trades())]
}

const cleanups: (() => unknown)[] = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function fakeServer(afterSubscribe = recordedBatches(), keys = KEYS) {
  const server = await startFakeAlpacaStream({ ...keys, afterSubscribe })
  cleanups.push(() => server.close())
  return server
}

function stream(server: FakeAlpacaStream) {
  const events: AlpacaStreamEvent[] = []
  const client = createAlpacaStream({
    ...KEYS,
    tickers: TICKERS,
    url: server.url,
    reconnect: RECONNECT,
    onEvent: (event) => events.push(event),
  })
  cleanups.push(() => client.close())
  return { client, events }
}

function count(events: AlpacaStreamEvent[], type: AlpacaStreamEvent['type']) {
  return events.filter((event) => event.type === type).length
}

function messages(server: FakeAlpacaStream, action: string) {
  return server.received.filter(({ message }) => message.action === action)
}

/** Waits until the client subscribed and has had time to read the batches sent after it. */
async function ready(client: AlpacaStream, events: AlpacaStreamEvent[], subscribed = 1) {
  await waitUntil(() => count(events, 'subscribed') >= subscribed && client.ready, 2000, 'subscribed')
  await new Promise((resolve) => setTimeout(resolve, 50))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('Alpaca stream: auth and subscribe (R67)', () => {
  it('authenticates with the key pair and subscribes to trades for the 7 tickers', async () => {
    const server = await fakeServer()
    const { client, events } = stream(server)
    client.start()

    await ready(client, events)

    const [auth] = messages(server, 'auth')
    assert.deepEqual(auth?.message, { action: 'auth', key: KEYS.keyId, secret: KEYS.secretKey })
    const [subscribe] = messages(server, 'subscribe')
    assert.ok(subscribe)
    const trades = subscribe.message.trades
    assert.ok(Array.isArray(trades))
    assert.deepEqual([...trades].sort(), [...TICKERS].sort())
    assert.equal(count(events, 'authenticated'), 1)
    assert.equal(server.connections, 1)
  })

  it('reports an auth failure without the secret and stays not ready', async () => {
    const server = await fakeServer([], { keyId: 'other', secretKey: 'other-secret' })
    const { client, events } = stream(server)
    client.start()

    await waitUntil(() => count(events, 'error') >= 1, 2000, 'auth error')

    assert.equal(client.ready, false)
    events.forEach((event) => {
      const text = JSON.stringify(event)
      assert.ok(!text.includes(KEYS.secretKey), 'event leaks the secret')
    })
  })

  it('does not hammer the server after an auth failure', async () => {
    const server = await fakeServer([], { keyId: 'other', secretKey: 'other-secret' })
    const { client } = stream(server)
    client.start()
    await sleep(300)
    // With 10 ms growing to 80 ms, 300 ms allows at most about 8 attempts.
    assert.ok(server.connections <= 8, `${server.connections} connections in 300 ms`)
  })
})

describe('Alpaca stream: latest prices (R67)', () => {
  it('keeps the latest trade per ticker from the recorded session', async () => {
    const server = await fakeServer()
    const { client, events } = stream(server)
    client.start()
    await ready(client, events)

    const expected = lastTrades(fixtures.trades())
    assert.ok(expected.size >= 5)
    expected.forEach((trade, ticker) => {
      const latest = client.latest(ticker)
      assert.ok(latest, `${ticker} has a price`)
      assert.equal(latest.ticker, ticker)
      assert.equal(latest.price, trade.p)
      assertClose(latest.time, unixOf(trade.t))
    })
  })

  it('carries the latest quote as bid and ask', async () => {
    const server = await fakeServer()
    const { client, events } = stream(server)
    client.start()
    await ready(client, events)

    const quote = lastQuotes(fixtures.quotes()).get('MSFT')
    assert.ok(quote)
    const latest = client.latest('MSFT')
    assert.equal(latest?.bid, quote.bp)
    assert.equal(latest?.ask, quote.ap)
  })

  it('replaces a price when a newer trade arrives', async () => {
    const server = await fakeServer()
    const { client, events } = stream(server)
    client.start()
    await ready(client, events)

    server.send([tradeMessage('AAPL', 350.5, '2026-10-14T15:12:00Z')])
    await waitUntil(() => client.latest('AAPL')?.price === 350.5, 1000, 'new AAPL trade')
    assert.equal(client.latest('AAPL')?.time, unixOf('2026-10-14T15:12:00Z'))
  })

  it('has no price for a ticker the stream has not traded', async () => {
    const server = await fakeServer([])
    const { client, events } = stream(server)
    client.start()
    await ready(client, events)
    assert.equal(client.latest('AAPL'), null)
  })
})

describe('Alpaca stream: reconnect with bounded backoff (R67)', () => {
  it('reconnects after a drop, then authenticates and subscribes again', async () => {
    const server = await fakeServer()
    const { client, events } = stream(server)
    client.start()
    await ready(client, events)

    server.dropAll()
    await waitUntil(() => count(events, 'disconnected') >= 1, 2000, 'disconnected')
    await ready(client, events, 2)

    assert.equal(server.connections, 2)
    assert.equal(messages(server, 'auth').length, 2)
    assert.equal(messages(server, 'subscribe').length, 2)
    const reconnecting = events.find((event) => event.type === 'reconnecting')
    assert.ok(reconnecting && reconnecting.type === 'reconnecting')
    assert.equal(reconnecting.attempt, 1)
    assert.ok(reconnecting.delayMs <= RECONNECT.maxMs)

    server.send([tradeMessage('NVDA', 230.25, '2026-10-14T15:13:00Z')])
    await waitUntil(() => client.latest('NVDA')?.price === 230.25, 1000, 'trade after reconnect')
  })

  it('grows the delay while the server is down, never past the maximum', async () => {
    const server = await fakeServer()
    const { client, events } = stream(server)
    client.start()
    await ready(client, events)

    await server.stop()
    await waitUntil(() => count(events, 'reconnecting') >= 6, 3000, 'six reconnect attempts')

    const delays = events
      .filter((event) => event.type === 'reconnecting')
      .map((event) => (event.type === 'reconnecting' ? event.delayMs : 0))
    assert.ok(delays.every((delay) => delay > 0 && delay <= RECONNECT.maxMs), `${delays}`)
    assert.ok((delays[0] ?? 0) < (delays.at(-1) ?? 0), `delays grow: ${delays}`)
    assert.ok(Math.max(...delays) >= RECONNECT.maxMs / 2, `delays reach the cap: ${delays}`)
    assert.equal(client.ready, false)
  })

  it('starts the backoff over after it reconnects', async () => {
    const server = await fakeServer()
    const { client, events } = stream(server)
    client.start()
    await ready(client, events)

    await server.stop()
    await waitUntil(() => count(events, 'reconnecting') >= 4, 3000, 'four attempts')
    await server.restart()
    await ready(client, events, 2)
    const before = count(events, 'reconnecting')

    server.dropAll()
    await waitUntil(() => count(events, 'reconnecting') > before, 2000, 'a new attempt')

    const next = events.filter((event) => event.type === 'reconnecting')[before]
    assert.ok(next && next.type === 'reconnecting')
    assert.equal(next.attempt, 1)
  })

  it('stops reconnecting once closed', async () => {
    const server = await fakeServer()
    const { client, events } = stream(server)
    client.start()
    await ready(client, events)

    client.close()
    await sleep(200)

    assert.equal(server.connections, 1)
    assert.equal(server.open, 0)
    assert.equal(client.ready, false)
  })
})

describe('Alpaca source live prices (R67, R47)', () => {
  function source(server: FakeAlpacaStream, now = STREAM_NOW) {
    const { fetch, calls } = fakeFetch(alpacaRoute({ snapshots: fixtures.snapshots() }))
    const events: AlpacaStreamEvent[] = []
    const clock = { now }
    const live: AlpacaSource = createAlpacaSource({
      ...KEYS,
      fetch,
      now: () => clock.now,
      tickers: TICKERS,
      stream: { url: server.url, reconnect: RECONNECT, onEvent: (event) => events.push(event) },
    })
    cleanups.push(() => live.close())
    return { live, calls, events, clock }
  }

  async function streaming(live: AlpacaSource, events: AlpacaStreamEvent[]) {
    await live.latest('AAPL')
    await waitUntil(() => count(events, 'subscribed') >= 1, 2000, 'subscribed')
    await sleep(50)
  }

  it('opens no connection until the first latest call', async () => {
    const server = await fakeServer()
    const { live } = source(server)
    await sleep(50)
    assert.equal(server.connections, 0)
    await live.latest('AAPL')
    await waitUntil(() => server.connections === 1, 1000, 'a connection')
  })

  it('gives each ticker its latest stream trade, with no REST request', async () => {
    const server = await fakeServer()
    const { live, calls, events } = source(server)
    await streaming(live, events)
    const sent = calls.length

    const expected = lastTrades(fixtures.trades())
    await Promise.all(
      [...expected].map(async ([ticker, trade]) => {
        const price = await live.latest(ticker)
        assert.ok(price, `${ticker} has a price`)
        assert.equal(price.ticker, ticker)
        assertClose(valueOf(price), trade.p)
        assert.equal(price.publishTime, Math.floor(unixOf(trade.t)))
        assert.equal(price.session, 'regular')
        assert.equal(price.officialClose, false)
      }),
    )
    assert.equal(calls.length, sent, 'no REST request while the stream is up')
  })

  it('sets confidence to half the quoted spread', async () => {
    const server = await fakeServer()
    const { live, events } = source(server)
    await streaming(live, events)

    const quote = lastQuotes(fixtures.quotes()).get('MSFT')
    assert.ok(quote)
    const price = await live.latest('MSFT')
    assert.ok(price)
    assertClose(confOf(price), (quote.ap - quote.bp) / 2)
  })

  it('never reports an after-hours trade as the live price', async () => {
    const server = await fakeServer()
    const { live, events, clock } = source(server)
    await streaming(live, events)

    clock.now = unixOf('2026-10-14T20:45:00Z')
    server.send([tradeMessage('AAPL', 999.99, '2026-10-14T20:30:00Z')])
    await sleep(50)

    const price = await live.latest('AAPL')
    assert.ok(price === null || valueOf(price) !== 999.99)
  })

  it('falls back to one REST snapshot for all tickers while the stream is down', async () => {
    const server = await fakeServer()
    await server.stop()
    const snapshotTime = unixOf('2026-10-14T15:10:00Z')
    const { live, calls } = source(server, snapshotTime)

    const prices = await Promise.all(TICKERS.map((ticker) => live.latest(ticker)))

    assert.equal(calls.length, 1, `one snapshot request, not one per ticker (${calls.length})`)
    const [call] = calls
    assert.ok(call)
    assert.equal(call.url.pathname, '/v2/stocks/snapshots')
    assert.deepEqual(call.url.searchParams.get('symbols')?.split(',').sort(), [...TICKERS].sort())
    assert.equal(call.url.searchParams.get('feed'), 'iex')
    const snapshots = fixtures.snapshots()
    prices.forEach((price, i) => {
      const ticker = TICKERS[i] as string
      const trade = snapshots[ticker]?.latestTrade
      assert.ok(price && trade, `${ticker} has a snapshot price`)
      assertClose(valueOf(price), trade.p)
      assert.equal(price.publishTime, Math.floor(unixOf(trade.t)))
    })

    await Promise.all(TICKERS.map((ticker) => live.latest(ticker)))
    assert.equal(calls.length, 1, 'the same tick reuses the snapshot')
  })

  it('goes back to the stream once it reconnects', async () => {
    const server = await fakeServer()
    await server.stop()
    const { live, calls, events } = source(server)
    await Promise.all(TICKERS.map((ticker) => live.latest(ticker)))
    const sent = calls.length

    await server.restart()
    await waitUntil(() => count(events, 'subscribed') >= 1, 3000, 'subscribed after restart')
    await sleep(50)

    const trade = lastTrades(fixtures.trades()).get('AAPL')
    const price = await live.latest('AAPL')
    assert.ok(price && trade)
    assertClose(valueOf(price), trade.p)
    assert.equal(calls.length, sent, 'no REST request once streaming')
  })
})
