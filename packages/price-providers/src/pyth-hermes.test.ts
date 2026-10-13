import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PYTH_FEED_IDS, PriceSourceError, createPythHermesProvider } from './index.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  assertClose,
  confOf,
  fakeFetch,
  jsonResponse,
  readFixtureText,
  valueOf,
} from './test-support.js'

const BASE_URL = 'https://hermes.test'
const TOKEN = 'test-access-token'
const AAPL_FEED = PYTH_FEED_IDS.AAPL as string

interface HermesFixture {
  binary: { encoding: string; data: string[] }
  parsed: { id: string }[]
}

/**
 * The recorded Hermes sample. Its hand-written `binary.data` has an odd number of hex digits;
 * real Hermes data is whole bytes, so the last digit is dropped.
 */
function hermes(): HermesFixture {
  const response = JSON.parse(
    readFixtureText('pyth/hermes-2026-10-09-before-close.json'),
  ) as HermesFixture
  response.binary.data = response.binary.data.map((hex) => hex.slice(0, hex.length & ~1))
  return response
}

function provider(route: (url: URL) => Response) {
  const { fetch, calls } = fakeFetch(route)
  const source = createPythHermesProvider({
    baseUrl: BASE_URL,
    accessToken: TOKEN,
    feedIds: { AAPL: AAPL_FEED, MSFT: PYTH_FEED_IDS.MSFT as string },
    fetch,
  })
  return { source, calls }
}

const bareHex = (id: string) => id.toLowerCase().replace(/^0x/, '')

// R32: switching a slot to Pyth needs only env vars, so the worker reads Hermes itself.
describe('Pyth Hermes provider over HTTP, against the recorded Hermes payload (R32)', () => {
  it('requests the update at close_ts for the ticker feed, sending the access token', async () => {
    const { source, calls } = provider(() => jsonResponse(hermes()))

    await source.prepareClose('AAPL', CLOSE_TS)

    assert.equal(calls.length, 1)
    const [call] = calls
    assert.ok(call)
    assert.equal(call.url.origin, BASE_URL)
    assert.equal(call.url.pathname, `/v2/updates/price/${CLOSE_TS}`)
    assert.deepEqual(call.url.searchParams.getAll('ids[]').map(bareHex), [AAPL_FEED])
    const inHeader = call.headers.get('authorization') === `Bearer ${TOKEN}`
    const inQuery = [...call.url.searchParams.values()].includes(TOKEN)
    assert.ok(inHeader || inQuery, 'the access token is sent as a bearer token or a query param')
  })

  it('returns the normalized AAPL update and the signed update data the receiver posts', async () => {
    const response = hermes()
    const { source } = provider(() => jsonResponse(response))

    const update = await source.prepareClose('AAPL', CLOSE_TS)

    assert.ok(update, 'an update for AAPL')
    assert.equal(source.name, 'pyth')
    assert.equal(update.ticker, 'AAPL')
    assert.equal(update.closeTs, CLOSE_TS)
    assert.equal(update.feedId, AAPL_FEED)
    // Only the requested ticker, even when Hermes answers with other feeds too.
    assert.deepEqual(
      update.updates.map((price) => price.ticker),
      ['AAPL'],
    )
    const [price] = update.updates
    assert.ok(price)
    assertClose(valueOf(price), 245.25)
    assertClose(confOf(price), 0.12)
    assert.equal(price.publishTime, 1791575970)
    assert.equal(price.session, 'regular')
    assert.deepEqual(
      update.binary.map((bytes) => Buffer.from(bytes).toString('hex')),
      response.binary.data,
    )
  })

  it('returns null when Hermes has no update at that time yet', async () => {
    const { source } = provider(() => jsonResponse({ message: 'not found' }, 404))

    assert.equal(await source.prepareClose('AAPL', CLOSE_TS), null)
  })

  it('returns null when the response has no update for the ticker feed', async () => {
    const response = hermes()
    response.parsed = response.parsed.filter((entry) => bareHex(entry.id) !== AAPL_FEED)
    const { source } = provider(() => jsonResponse(response))

    assert.equal(await source.prepareClose('AAPL', CLOSE_TS), null)
  })

  it('rejects a ticker with no configured feed ID without sending a request', async () => {
    const { source, calls } = provider(() => jsonResponse(hermes()))

    await assert.rejects(source.prepareClose('TSLA', CLOSE_TS), /TSLA/)
    assert.equal(calls.length, 0)
  })

  it('reports a server error as an http PriceSourceError', async () => {
    const { source } = provider(() => new Response('upstream down', { status: 503 }))

    await assert.rejects(
      source.prepareClose('AAPL', CLOSE_TS),
      (error: unknown) => error instanceof PriceSourceError && error.code === 'http',
    )
  })
})
