import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { describe, it } from 'node:test'
import { PriceSourceError, createDataStreamsClient } from './index.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  fakeFetch,
  jsonResponse,
  readFixtureText,
} from './test-support.js'

const BASE_URL = 'https://streams.test'
const USERNAME = 'test-user-id'
const SECRET = 'test-hmac-secret'
const NOW_MS = 1_791_576_090_123

interface V11Fixture {
  feedId: string
  validFromTimestamp: number
  observationsTimestamp: number
}

/** The recorded v11 report's stream, the AAPL stream here. */
const v11 = JSON.parse(
  readFixtureText('chainlink/v11-AAPL-2026-10-09-before-close.json'),
) as V11Fixture
const AAPL_STREAM = v11.feedId.toLowerCase().replace(/^0x/, '')

/** Opaque signed report bytes; only the verifier program decodes them. */
const FULL_REPORT = Buffer.from(`signed v11 report ${AAPL_STREAM} ${CLOSE_TS}`)

/** The REST API's `GET /api/v1/reports` body around the recorded report. */
function reportResponse() {
  return {
    report: {
      feedID: v11.feedId,
      validFromTimestamp: v11.validFromTimestamp,
      observationsTimestamp: v11.observationsTimestamp,
      fullReport: `0x${FULL_REPORT.toString('hex')}`,
    },
  }
}

function client(route: (url: URL) => Response) {
  const { fetch, calls } = fakeFetch(route)
  const streams = createDataStreamsClient({
    baseUrl: BASE_URL,
    username: USERNAME,
    secret: SECRET,
    streamIds: { AAPL: AAPL_STREAM },
    fetch,
    now: () => NOW_MS,
  })
  return { streams, calls }
}

// R32: switching a slot to Data Streams needs only env vars, so the worker fetches signed reports.
describe('Data Streams client over HTTP, around the recorded v11 report (R32)', () => {
  it('requests the report at close_ts for the ticker stream', async () => {
    const { streams, calls } = client(() => jsonResponse(reportResponse()))

    await streams.reportsAt('AAPL', CLOSE_TS)

    assert.equal(calls.length, 1)
    const [call] = calls
    assert.ok(call)
    assert.equal(call.url.origin, BASE_URL)
    assert.equal(call.url.pathname, '/api/v1/reports')
    assert.equal(call.url.searchParams.get('feedID')?.toLowerCase(), `0x${AAPL_STREAM}`)
    assert.equal(call.url.searchParams.get('timestamp'), String(CLOSE_TS))
  })

  it('signs the request with the HMAC credentials', async () => {
    const { streams, calls } = client(() => jsonResponse(reportResponse()))

    await streams.reportsAt('AAPL', CLOSE_TS)

    const [call] = calls
    assert.ok(call)
    const timestamp = String(NOW_MS)
    const bodyHash = createHash('sha256').update('').digest('hex')
    const signed = `GET ${call.url.pathname}${call.url.search} ${bodyHash} ${USERNAME} ${timestamp}`
    assert.equal(call.headers.get('authorization'), USERNAME)
    assert.equal(call.headers.get('x-authorization-timestamp'), timestamp)
    assert.equal(
      call.headers.get('x-authorization-signature-sha256'),
      createHmac('sha256', SECRET).update(signed).digest('hex'),
    )
  })

  it('returns the fullReport bytes that settle_market_with_reports takes', async () => {
    const { streams } = client(() => jsonResponse(reportResponse()))

    const reports = await streams.reportsAt('AAPL', CLOSE_TS)

    assert.equal(streams.name, 'chainlink')
    assert.ok(reports, 'a report for AAPL')
    assert.equal(reports.ticker, 'AAPL')
    assert.equal(reports.closeTs, CLOSE_TS)
    assert.deepEqual(
      reports.fullReports.map((bytes) => Buffer.from(bytes).toString('hex')),
      [FULL_REPORT.toString('hex')],
    )
  })

  it('returns null when there is no report at that time yet', async () => {
    const { streams } = client(() => jsonResponse({ error: 'not found' }, 404))

    assert.equal(await streams.reportsAt('AAPL', CLOSE_TS), null)
  })

  it('rejects a ticker with no configured stream ID without sending a request', async () => {
    const { streams, calls } = client(() => jsonResponse(reportResponse()))

    await assert.rejects(streams.reportsAt('MSFT', CLOSE_TS), /MSFT/)
    assert.equal(calls.length, 0)
  })

  it('reports a refused signature as an http PriceSourceError', async () => {
    const { streams } = client(() => jsonResponse({ error: 'unauthorized' }, 401))

    await assert.rejects(
      streams.reportsAt('AAPL', CLOSE_TS),
      (error: unknown) => error instanceof PriceSourceError && error.code === 'http',
    )
  })
})
