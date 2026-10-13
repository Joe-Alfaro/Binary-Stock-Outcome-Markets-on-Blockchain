import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PriceSourceError, createYahooSource } from './index.js'
import {
  FIXTURE_CLOSE_TS as CLOSE_TS,
  fakeFetch,
  jsonResponse,
  readFixtureText,
  readYahooFixture,
} from './test-support.js'
import type { Route } from './test-support.js'

const minute = readYahooFixture('AAPL-2026-10-09-1m.json')

function rateLimited(retryAfter?: number): Response {
  const headers: Record<string, string> = { 'content-type': 'text/plain' }
  if (retryAfter !== undefined) headers['retry-after'] = String(retryAfter)
  return new Response(readFixtureText('yahoo/rate-limited.txt'), { status: 429, headers })
}

function setup(route: Route) {
  const clock = { now: CLOSE_TS + 900 }
  const { fetch, calls } = fakeFetch(route)
  const source = createYahooSource({ fetch, now: () => clock.now, timeoutMs: 1_000 })
  return { source, calls, clock }
}

async function rejectsRateLimited(promise: Promise<unknown>) {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof PriceSourceError && error.code === 'rate-limited',
  )
}

describe('yahoo source: 429 handling (R39)', () => {
  it('falls back from query1 to query2 when query1 is rate-limited', async () => {
    const { source, calls } = setup((url) =>
      url.hostname.startsWith('query1') ? rateLimited() : jsonResponse(minute),
    )

    assert.ok(await source.prepareClose('AAPL', CLOSE_TS))
    assert.deepEqual(
      calls.map((call) => call.url.hostname),
      ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'],
    )
  })

  it('falls back to query2 on a server error', async () => {
    const { source } = setup((url) =>
      url.hostname.startsWith('query1') ? new Response('', { status: 503 }) : jsonResponse(minute),
    )

    assert.ok(await source.prepareClose('AAPL', CLOSE_TS))
  })

  it('makes one request per host, then fails fast without the network while backing off', async () => {
    const { source, calls, clock } = setup(() => rateLimited())

    await rejectsRateLimited(source.prepareClose('AAPL', CLOSE_TS))
    assert.equal(calls.length, 2)

    clock.now += 29
    await rejectsRateLimited(source.prepareClose('AAPL', CLOSE_TS))
    assert.equal(calls.length, 2, 'no request during the 30 s backoff')

    clock.now += 1
    await rejectsRateLimited(source.prepareClose('AAPL', CLOSE_TS))
    assert.equal(calls.length, 4, 'retries once the backoff has passed')
  })

  it('doubles the backoff for each consecutive 429, up to 8 minutes', async () => {
    const { source, calls, clock } = setup(() => rateLimited())
    const expected = [30, 60, 120, 240, 480, 480]

    await expected.reduce(async (previous, delay) => {
      await previous
      await rejectsRateLimited(source.prepareClose('AAPL', CLOSE_TS))
      const made = calls.length
      clock.now += delay - 1
      await rejectsRateLimited(source.prepareClose('AAPL', CLOSE_TS))
      assert.equal(calls.length, made, `still backing off ${delay - 1} s later`)
      clock.now += 1
    }, Promise.resolve())
  })

  it('honors a longer Retry-After header', async () => {
    const { source, calls, clock } = setup(() => rateLimited(90))

    await rejectsRateLimited(source.prepareClose('AAPL', CLOSE_TS))
    clock.now += 89
    await rejectsRateLimited(source.previousClose('AAPL', '2026-10-09'))
    assert.equal(calls.length, 2)
  })

  it('resets the backoff after a success', async () => {
    const answers = [rateLimited(), rateLimited(), jsonResponse(minute), rateLimited()]
    const { source, calls, clock } = setup(() => answers.shift() ?? rateLimited())

    await rejectsRateLimited(source.prepareClose('AAPL', CLOSE_TS))
    clock.now += 30
    assert.ok(await source.prepareClose('AAPL', CLOSE_TS))
    await rejectsRateLimited(source.prepareClose('AAPL', CLOSE_TS))
    const made = calls.length
    clock.now += 30
    await rejectsRateLimited(source.prepareClose('AAPL', CLOSE_TS))
    assert.ok(calls.length > made, 'backoff restarted at 30 s')
  })
})
