import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { RELAY_SOURCE_NAMES, createRelaySource, isRelaySourceName } from './index.js'
import { readAlpacaJson } from './alpaca-test-support.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  fakeFetch,
  jsonResponse,
  readYahooFixture,
  yahooRoute,
} from './test-support.js'

const ALPACA_KEYS = { ALPACA_API_KEY: 'test-key-id-PK0000', ALPACA_API_SECRET: 'test-secret-0000' }

describe('relay source selection by RELAY_<n>_SOURCE (R39, R32)', () => {
  it('selects the mock source', () => {
    assert.equal(createRelaySource({ RELAY_1_SOURCE: 'mock' }).name, 'mock')
  })

  it('selects the yahoo source', () => {
    assert.equal(createRelaySource({ RELAY_1_SOURCE: 'yahoo' }).name, 'yahoo')
  })

  // R67 replaced the yahoo default: alpaca when its keys are set, otherwise mock.
  it('defaults to mock when the variable is unset or empty and no Alpaca keys are set', () => {
    assert.equal(createRelaySource({}).name, 'mock')
    assert.equal(createRelaySource({ RELAY_1_SOURCE: '' }).name, 'mock')
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

describe('Alpaca source selection (R67)', () => {
  it('selects alpaca by name', () => {
    assert.equal(createRelaySource({ RELAY_1_SOURCE: 'alpaca', ...ALPACA_KEYS }).name, 'alpaca')
  })

  it('lists alpaca among the accepted names', () => {
    assert.ok(RELAY_SOURCE_NAMES.includes('alpaca' as never))
    assert.equal(isRelaySourceName('alpaca'), true)
  })

  it('defaults to alpaca when both keys are set', () => {
    assert.equal(createRelaySource({ ...ALPACA_KEYS }).name, 'alpaca')
    assert.equal(createRelaySource({ RELAY_1_SOURCE: ' ', ...ALPACA_KEYS }).name, 'alpaca')
  })

  it('defaults to mock when only one key is set', () => {
    assert.equal(createRelaySource({ ALPACA_API_KEY: ALPACA_KEYS.ALPACA_API_KEY }).name, 'mock')
    assert.equal(
      createRelaySource({ ALPACA_API_SECRET: ALPACA_KEYS.ALPACA_API_SECRET }).name,
      'mock',
    )
  })

  it('keeps yahoo and mock selectable when the keys are set', () => {
    assert.equal(createRelaySource({ RELAY_1_SOURCE: 'yahoo', ...ALPACA_KEYS }).name, 'yahoo')
    assert.equal(createRelaySource({ RELAY_1_SOURCE: 'mock', ...ALPACA_KEYS }).name, 'mock')
  })

  it('fails at startup when alpaca is selected without keys, naming both variables', () => {
    assert.throws(
      () => createRelaySource({ RELAY_1_SOURCE: 'alpaca' }),
      (error: unknown) =>
        error instanceof Error &&
        /ALPACA_API_KEY/.test(error.message) &&
        /ALPACA_API_SECRET/.test(error.message),
    )
  })

  it('names the missing variable without printing the one that is set', () => {
    assert.throws(
      () =>
        createRelaySource({ RELAY_1_SOURCE: 'alpaca', ALPACA_API_KEY: ALPACA_KEYS.ALPACA_API_KEY }),
      (error: unknown) =>
        error instanceof Error &&
        /ALPACA_API_SECRET/.test(error.message) &&
        !error.message.includes(ALPACA_KEYS.ALPACA_API_KEY),
    )
    assert.throws(
      () =>
        createRelaySource({
          RELAY_1_SOURCE: 'alpaca',
          ALPACA_API_KEY: '  ',
          ALPACA_API_SECRET: '',
        }),
      /ALPACA_API_KEY/,
    )
  })

  it('passes fetch and the clock through to the alpaca source, without a request at startup', async () => {
    const daily = readAlpacaJson<unknown>('bars-1day-7-2026-10-13-sip.json')
    const { fetch, calls } = fakeFetch(() => jsonResponse(daily))
    const source = createRelaySource({ RELAY_1_SOURCE: 'alpaca', ...ALPACA_KEYS }, 1, {
      fetch,
      now: () => Date.parse('2026-10-14T15:00:00Z') / 1000,
    })
    assert.equal(calls.length, 0, 'no request at construction')

    const close = await source.previousClose('AAPL', '2026-10-13')

    assert.equal(close.price, 341.27)
    assert.ok(calls.length > 0)
    assert.equal(calls[0]?.headers.get('APCA-API-KEY-ID'), ALPACA_KEYS.ALPACA_API_KEY)
  })
})
