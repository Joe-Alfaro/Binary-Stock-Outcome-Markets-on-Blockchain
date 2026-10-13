import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { PriceSourceError, createMockSource, createYahooSource } from './index.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  fakeFetch,
  readYahooFixture,
  valueOf,
  yahooRoute,
} from './test-support.js'

const DAY = 24 * 60 * 60

describe('mock relay source (R39)', () => {
  const realFetch = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = (() => {
      throw new Error('the mock source must not use the network')
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('is named mock', () => {
    assert.equal(createMockSource().name, 'mock')
  })

  it('replays the recorded close exactly as the yahoo source parses it', async () => {
    const { fetch } = fakeFetch(
      yahooRoute(
        readYahooFixture('AAPL-2026-10-09-1m.json'),
        readYahooFixture('AAPL-2026-10-09-1d.json'),
      ),
    )
    const recorded = createYahooSource({ fetch, now: () => CLOSE_TS + 900 })

    const replayed = await createMockSource().prepareClose('AAPL', CLOSE_TS)

    assert.ok(replayed)
    assert.deepEqual(replayed, await recorded.prepareClose('AAPL', CLOSE_TS))
  })

  it('re-stamps the recorded close to any requested close_ts', async () => {
    const source = createMockSource()
    const recorded = await source.prepareClose('AAPL', CLOSE_TS)
    const monday = CLOSE_TS + 3 * DAY

    const replayed = await source.prepareClose('AAPL', monday)

    assert.ok(recorded && replayed)
    assert.equal(replayed.closeTs, monday)
    assert.equal(replayed.updates.length, recorded.updates.length)
    replayed.updates.forEach((update, i) => {
      const original = recorded.updates[i]
      assert.ok(original)
      assert.equal(update.publishTime - monday, original.publishTime - CLOSE_TS)
      assert.equal(valueOf(update), valueOf(original))
      assert.equal(update.officialClose, original.officialClose)
    })
    assert.ok(replayed.updates.some((update) => update.officialClose))
  })

  it('replays a second ticker', async () => {
    const replayed = await createMockSource().prepareClose('MSFT', CLOSE_TS)

    assert.ok(replayed)
    assert.ok(replayed.updates.every((update) => update.ticker === 'MSFT'))
  })

  it('returns the recorded previous close dated the requested day', async () => {
    const previous = await createMockSource().previousClose('AAPL', '2026-10-13')

    assert.deepEqual(previous, { ticker: 'AAPL', price: 245.27, tradingDay: '2026-10-13' })
  })

  it('rejects a ticker it has no recording for as not-found', async () => {
    await assert.rejects(
      createMockSource().prepareClose('ZZZZ', CLOSE_TS),
      (error: unknown) => error instanceof PriceSourceError && error.code === 'not-found',
    )
  })
})
