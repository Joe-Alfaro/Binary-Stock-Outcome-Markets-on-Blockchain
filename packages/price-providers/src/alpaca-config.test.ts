// R67: Alpaca env settings. ALPACA_API_ENDPOINT is usually the trading API (paper or live), which
// market data never uses; market data has its own optional ALPACA_DATA_URL and ALPACA_STREAM_URL.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { alpacaConfigFromEnv, createRelaySource } from './index.js'
import { readAlpacaJson } from './alpaca-test-support.js'
import { fakeFetch, jsonResponse } from './test-support.js'

const KEYS = { ALPACA_API_KEY: 'test-key-id-PK0000', ALPACA_API_SECRET: 'test-secret-0000' }
const DATA = 'https://data.alpaca.markets'
const STREAM = 'wss://stream.data.alpaca.markets/v2/iex'
/** Trading and account routes the market-data source must never call. */
const TRADING_PATH = /\/v2\/(orders|account|positions|assets|watchlists|clock|calendar)/

describe('Alpaca URL settings (R67)', () => {
  it('defaults to the market-data REST and stream hosts', () => {
    const config = alpacaConfigFromEnv({ ...KEYS })
    assert.equal(config.restUrl, DATA)
    assert.equal(config.streamUrl, STREAM)
    assert.equal(config.keyId, KEYS.ALPACA_API_KEY)
    assert.equal(config.secretKey, KEYS.ALPACA_API_SECRET)
  })

  it('treats blank URL variables as unset', () => {
    const config = alpacaConfigFromEnv({
      ...KEYS,
      ALPACA_API_ENDPOINT: ' ',
      ALPACA_DATA_URL: '',
      ALPACA_STREAM_URL: '',
    })
    assert.equal(config.restUrl, DATA)
    assert.equal(config.streamUrl, STREAM)
  })

  it('takes ALPACA_DATA_URL and ALPACA_STREAM_URL when set', () => {
    const config = alpacaConfigFromEnv({
      ...KEYS,
      ALPACA_DATA_URL: 'https://data.sandbox.alpaca.markets',
      ALPACA_STREAM_URL: 'wss://stream.data.alpaca.markets/v2/sip',
    })
    assert.equal(config.restUrl, 'https://data.sandbox.alpaca.markets')
    assert.equal(config.streamUrl, 'wss://stream.data.alpaca.markets/v2/sip')
  })

  ;[
    'https://paper-api.alpaca.markets/v2',
    'https://paper-api.alpaca.markets',
    'https://api.alpaca.markets/v2',
  ].forEach((endpoint) => {
    it(`ignores a trading ALPACA_API_ENDPOINT (${endpoint}) for market data`, () => {
      const config = alpacaConfigFromEnv({ ...KEYS, ALPACA_API_ENDPOINT: endpoint })
      assert.equal(config.restUrl, DATA)
      assert.equal(config.streamUrl, STREAM)
    })
  })

  it('uses ALPACA_API_ENDPOINT for REST data when it is a data host, without its /v2 path', () => {
    const config = alpacaConfigFromEnv({
      ...KEYS,
      ALPACA_API_ENDPOINT: 'https://data.sandbox.alpaca.markets/v2',
    })
    assert.equal(config.restUrl, 'https://data.sandbox.alpaca.markets')
  })

  it('prefers ALPACA_DATA_URL over a data ALPACA_API_ENDPOINT', () => {
    const config = alpacaConfigFromEnv({
      ...KEYS,
      ALPACA_API_ENDPOINT: 'https://data.sandbox.alpaca.markets/v2',
      ALPACA_DATA_URL: DATA,
    })
    assert.equal(config.restUrl, DATA)
  })

  it('rejects an invalid URL at startup, naming the variable', () => {
    assert.throws(
      () => alpacaConfigFromEnv({ ...KEYS, ALPACA_DATA_URL: 'not a url' }),
      /ALPACA_DATA_URL/,
    )
    assert.throws(
      () => alpacaConfigFromEnv({ ...KEYS, ALPACA_STREAM_URL: 'https://not-a-websocket' }),
      /ALPACA_STREAM_URL/,
    )
  })

  it('still requires both keys', () => {
    assert.throws(
      () => alpacaConfigFromEnv({ ALPACA_API_ENDPOINT: 'https://paper-api.alpaca.markets/v2' }),
      /ALPACA_API_KEY/,
    )
  })

  it('with the paper endpoint set, the selected source only calls market-data routes', async () => {
    const daily = readAlpacaJson<unknown>('bars-1day-7-2026-10-13-sip.json')
    const { fetch, calls } = fakeFetch(() => jsonResponse(daily))
    const source = createRelaySource(
      {
        RELAY_1_SOURCE: 'alpaca',
        ...KEYS,
        ALPACA_API_ENDPOINT: 'https://paper-api.alpaca.markets/v2',
      },
      1,
      { fetch, now: () => Date.parse('2026-10-14T15:00:00Z') / 1000 },
    )

    await source.previousClose('AAPL', '2026-10-13')
    await source.prepareClose('AAPL', Date.parse('2026-10-13T20:00:00Z') / 1000).catch(() => null)

    assert.ok(calls.length > 0)
    calls.forEach(({ url }) => {
      assert.equal(url.origin, DATA, `request to ${url.origin}`)
      assert.ok(url.pathname.startsWith('/v2/stocks/'), `market-data route: ${url.pathname}`)
      assert.doesNotMatch(url.pathname, TRADING_PATH)
    })
  })

  it('the selected source sends REST requests to ALPACA_DATA_URL', async () => {
    const daily = readAlpacaJson<unknown>('bars-1day-7-2026-10-13-sip.json')
    const { fetch, calls } = fakeFetch(() => jsonResponse(daily))
    const source = createRelaySource(
      { RELAY_1_SOURCE: 'alpaca', ...KEYS, ALPACA_DATA_URL: 'http://127.0.0.1:9' },
      1,
      { fetch, now: () => Date.parse('2026-10-14T15:00:00Z') / 1000 },
    )
    await source.previousClose('AAPL', '2026-10-13')
    assert.ok(calls.length > 0 && calls.every(({ url }) => url.origin === 'http://127.0.0.1:9'))
  })
})

describe('.env.example lists the Alpaca settings as placeholders (R67)', () => {
  const lines = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split('\n')

  ;[
    'ALPACA_API_KEY',
    'ALPACA_API_SECRET',
    'ALPACA_API_ENDPOINT',
    'ALPACA_DATA_URL',
    'ALPACA_STREAM_URL',
  ].forEach((name) => {
    it(`${name} is listed with an empty value`, () => {
      const line = lines.find((entry) => entry.startsWith(`${name}=`))
      assert.ok(line, `${name} is missing`)
      assert.equal(line, `${name}=`, `${name} must be an empty placeholder`)
    })
  })

  it('names alpaca among the relay sources', () => {
    const comment = lines.filter((line) => line.startsWith('#')).join('\n')
    assert.match(comment, /alpaca/)
  })
})
