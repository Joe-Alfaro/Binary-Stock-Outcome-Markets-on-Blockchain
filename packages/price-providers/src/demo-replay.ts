import { readFileSync } from 'node:fs'
import { createMockSource, syntheticIntraday } from './mock.js'
import type { MockSourceOptions } from './mock.js'
import { isRecord, malformed } from './parse.js'
import type { IntradayPriceProvider, LivePriceProvider, PriceProvider } from './types.js'
import { closeInputs, parseChart, toNormalized } from './yahoo.js'

/** Values transcribed from one live chart API response on the evening of 2026-10-12. */
const RECORDING = new URL('../fixtures/yahoo/AAPL-2026-10-12-close.json', import.meta.url)
const TICKER = 'AAPL'

function load() {
  const body: unknown = JSON.parse(readFileSync(RECORDING, 'utf8'))
  const chart = parseChart(body, TICKER)
  const meta = (body as { chart: { result: { meta: Record<string, unknown> }[] } }).chart.result[0]
    ?.meta
  const period = isRecord(meta?.currentTradingPeriod) ? meta.currentTradingPeriod.regular : null
  const closeTs = isRecord(period) ? period.end : undefined
  const previousClose = meta?.previousClose
  if (typeof closeTs !== 'number' || typeof previousClose !== 'number') {
    throw malformed('the recorded close has no regular session end or previous close')
  }
  return { chart, closeTs, previousClose }
}

const isRecorded = (ticker: string) => ticker.toUpperCase() === TICKER

/**
 * Offline relay source for demo mode (R44): replays the recorded AAPL close of 2026-10-12,
 * re-stamped to the requested `closeTs`. Other tickers have no recorded close, so they fall back
 * to the mock source's hand-written fixtures. Never touches the network. It is named `mock` so
 * the publisher's demo guard, which refuses live sources, accepts it.
 */
export function createDemoReplaySource(
  options: MockSourceOptions = {},
): PriceProvider & LivePriceProvider & IntradayPriceProvider {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  const recording = load()
  const handWritten = createMockSource({ now })
  return {
    name: 'mock',

    async prepareClose(ticker, closeTs) {
      if (!isRecorded(ticker)) return handWritten.prepareClose(ticker, closeTs)
      const inputs = closeInputs(recording.chart, TICKER, recording.closeTs)
      if (inputs === null) return null
      const shift = closeTs - recording.closeTs
      return {
        ...inputs,
        closeTs,
        updates: inputs.updates.map((update) => ({
          ...update,
          publishTime: update.publishTime + shift,
        })),
      }
    },

    /** The close before the recorded day, dated as the caller asks. */
    async previousClose(ticker, previousTradingDay) {
      if (!isRecorded(ticker)) return handWritten.previousClose(ticker, previousTradingDay)
      return { ticker: TICKER, price: recording.previousClose, tradingDay: previousTradingDay }
    },

    /** The recorded close, re-stamped to now. */
    async latest(ticker) {
      if (!isRecorded(ticker)) return handWritten.latest(ticker)
      return toNormalized(TICKER, recording.chart.regularMarketPrice, 0, now(), false)
    },

    /** A synthetic series around the recorded close; it has no recorded minute bars to chart. */
    async intraday(ticker, fromTs, toTs) {
      if (!isRecorded(ticker)) return handWritten.intraday(ticker, fromTs, toTs)
      return syntheticIntraday(TICKER, recording.chart.regularMarketPrice, fromTs, toTs)
    },
  }
}
