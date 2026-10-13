import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PriceSourceError } from '@meridian/price-providers'
import type { OpenMarket } from '../chain/index.js'
import { FakeClock } from '../jobs/fake-clock.js'
import { recordingLogger } from '../jobs/test-support.js'
import { CLOSE_LOOKBACK_SECS, runCloseLoop, skippingUnknownTickers } from './run.js'
import type { CloseOutcome, RelayPublisher } from './types.js'

const CLOSE = 1_800_000_000

function market(ticker: string, strike: bigint, closeTs = CLOSE, tradingDay = '2027-01-15') {
  return { address: `${ticker}-${strike}`, ticker, tradingDay, strike, closeTs } as OpenMarket
}

function recordingPublisher() {
  const closes: [string, string, number][] = []
  const publisher = {
    async publishClose(ticker: string, tradingDay: string, closeTs: number) {
      closes.push([ticker, tradingDay, closeTs])
      return { ticker, status: 'published' } as CloseOutcome
    },
  } as RelayPublisher
  return { publisher, closes }
}

/** Runs the loop for one scan at `nowSecs` and stops it. */
async function oneScan(markets: OpenMarket[] | Error, nowSecs: number) {
  const clock = new FakeClock(nowSecs * 1000)
  const { publisher, closes } = recordingPublisher()
  const log = recordingLogger(clock)
  const controller = new AbortController()
  const chain = {
    async listOpenMarkets() {
      if (markets instanceof Error) throw markets
      return markets
    },
  }
  const done = runCloseLoop({ publisher, chain, clock, log, signal: controller.signal })
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await done
  return { closes, log }
}

describe('R40 relay close loop', () => {
  it('publishes each ticker-day once after its close, not before', async () => {
    const markets = [
      market('AAPL', 240n),
      market('AAPL', 250n),
      market('MSFT', 520n),
      market('NVDA', 180n, CLOSE + 60),
    ]
    const { closes } = await oneScan(markets, CLOSE + 5)
    assert.deepEqual(closes, [
      ['AAPL', '2027-01-15', CLOSE],
      ['MSFT', '2027-01-15', CLOSE],
    ])
  })

  it('leaves markets closed beyond the lookback to the admin fallback', async () => {
    const { closes } = await oneScan([market('AAPL', 240n)], CLOSE + CLOSE_LOOKBACK_SECS + 1)
    assert.deepEqual(closes, [])
  })

  it('logs a failed market scan and keeps running', async () => {
    const { closes, log } = await oneScan(new Error('rpc down'), CLOSE + 5)
    assert.deepEqual(closes, [])
    assert.ok(log.entries.some((entry) => entry.level === 'error'))
  })
})

describe('R47 live source for the worker', () => {
  const failing = (error: Error) => ({
    name: 'scripted',
    latest: async () => {
      throw error
    },
  })

  it('skips a ticker the source has no data for, reporting it once', async () => {
    const reported: string[] = []
    const source = skippingUnknownTickers(
      failing(new PriceSourceError('not-found', 'no ZZZ')),
      (ticker) => reported.push(ticker),
    )
    assert.equal(await source.latest('ZZZ'), null)
    assert.equal(await source.latest('ZZZ'), null)
    assert.deepEqual(reported, ['ZZZ'])
  })

  it('still fails on other source errors, so the relay backs off', async () => {
    const source = skippingUnknownTickers(failing(new PriceSourceError('timeout', 'slow')))
    await assert.rejects(source.latest('AAPL'), /slow/)
  })
})
