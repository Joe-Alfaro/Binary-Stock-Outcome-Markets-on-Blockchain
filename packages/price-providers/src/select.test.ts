import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRelaySource } from './index.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  fakeFetch,
  readYahooFixture,
  yahooRoute,
} from './test-support.js'

describe('relay source selection by RELAY_<n>_SOURCE (R39, R32)', () => {
  it('selects the mock source', () => {
    assert.equal(createRelaySource({ RELAY_1_SOURCE: 'mock' }).name, 'mock')
  })

  it('selects the yahoo source', () => {
    assert.equal(createRelaySource({ RELAY_1_SOURCE: 'yahoo' }).name, 'yahoo')
  })

  it('defaults to yahoo when the variable is unset or empty', () => {
    assert.equal(createRelaySource({}).name, 'yahoo')
    assert.equal(createRelaySource({ RELAY_1_SOURCE: '' }).name, 'yahoo')
  })

  it('reads the variable for the requested slot', () => {
    const env = { RELAY_1_SOURCE: 'yahoo', RELAY_2_SOURCE: 'mock' }

    assert.equal(createRelaySource(env, 2).name, 'mock')
    assert.equal(createRelaySource(env, 1).name, 'yahoo')
  })

  it('rejects an unknown source name, naming the variable', () => {
    assert.throws(() => createRelaySource({ RELAY_1_SOURCE: 'ticker-tape' }), /RELAY_1_SOURCE/)
  })

  it('passes the fetch option through to the yahoo source', async () => {
    const { fetch, calls } = fakeFetch(
      yahooRoute(
        readYahooFixture('AAPL-2026-10-09-1m.json'),
        readYahooFixture('AAPL-2026-10-09-1d.json'),
      ),
    )
    const source = createRelaySource({ RELAY_1_SOURCE: 'yahoo' }, 1, {
      fetch,
      now: () => CLOSE_TS + 900,
    })

    assert.ok(await source.prepareClose('AAPL', CLOSE_TS))
    assert.ok(calls.length > 0)
  })

  it('gives a mock source that settles offline through the same interface', async () => {
    const source = createRelaySource({ RELAY_1_SOURCE: 'mock' })

    const inputs = await source.prepareClose('AAPL', CLOSE_TS)

    assert.ok(inputs)
    assert.equal(inputs.ticker, 'AAPL')
  })
})
