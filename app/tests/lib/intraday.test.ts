import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createIntradayClient } from '../../src/lib/intraday'
import type { IntradaySeries } from '../../src/lib/intraday'

const SERIES: IntradaySeries = {
  ticker: 'AAPL',
  live: true,
  sessionDate: '2026-10-12',
  openTs: 1791819000,
  endTs: 1791822000,
  earlyClose: false,
  points: [
    { t: 1791819000, price: 230 },
    { t: 1791822000, price: 231.42 },
  ],
}

function fakeFetch(answer: () => Response) {
  const urls: string[] = []
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(input instanceof Request ? input.url : String(input))
    return answer()
  }) as typeof fetch
  return { fetchImpl, urls }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

// R66: the browser reads the chart's series from the worker's intraday route only.
describe('R66 intraday client', () => {
  it("reads the ticker's series from the worker's intraday route", async () => {
    const { fetchImpl, urls } = fakeFetch(() => json(SERIES))
    const client = createIntradayClient('https://worker.example', fetchImpl)

    assert.deepEqual(await client.get('AAPL'), SERIES)
    assert.deepEqual(urls, ['https://worker.example/prices/intraday/AAPL'])
  })

  it('tolerates a trailing slash on the worker URL', async () => {
    const { fetchImpl, urls } = fakeFetch(() => json(SERIES))
    await createIntradayClient('https://worker.example/', fetchImpl).get('AAPL')
    assert.deepEqual(urls, ['https://worker.example/prices/intraday/AAPL'])
  })

  it('rejects when the worker answers an error', async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: 'rate-limited' }, 503))
    await assert.rejects(createIntradayClient('https://worker.example', fetchImpl).get('AAPL'))
  })

  it('rejects without a request when no worker URL is configured', async () => {
    const { fetchImpl, urls } = fakeFetch(() => json(SERIES))
    await assert.rejects(createIntradayClient(undefined, fetchImpl).get('AAPL'))
    assert.equal(urls.length, 0)
  })
})
