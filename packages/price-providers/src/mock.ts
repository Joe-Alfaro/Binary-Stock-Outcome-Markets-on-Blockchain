import { readFileSync, readdirSync } from 'node:fs'
import { PriceSourceError, notImplemented } from './errors.js'
import { REGULAR_CLOSE_SECS, newYorkMidnight } from './time.js'
import type { IntradayPriceProvider, LivePriceProvider, PriceProvider } from './types.js'
import { closeInputs, completedDailyCloses, parseChart, toNormalized } from './yahoo.js'
import type { YahooChart } from './yahoo.js'

const FIXTURES = new URL('../fixtures/yahoo/', import.meta.url)

/** 16:00 ET on a `YYYY-MM-DD` day. Recordings are named for full trading days. */
function closeOfDay(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  // 20:00 UTC is 15:00 or 16:00 in New York, so it always lands on the same calendar day.
  const sameDay = Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1, 20) / 1000
  return newYorkMidnight(sameDay) + REGULAR_CLOSE_SECS
}

/** The latest recording `<TICKER>-<YYYY-MM-DD>-<interval>.json` for a ticker. */
function recording(ticker: string, interval: '1m' | '1d'): { chart: YahooChart; day: string } {
  const pattern = new RegExp(`^${ticker.toUpperCase()}-(\\d{4}-\\d{2}-\\d{2})-${interval}\\.json$`)
  const name = readdirSync(FIXTURES)
    .filter((file) => pattern.test(file))
    .sort()
    .at(-1)
  if (name === undefined) {
    throw new PriceSourceError('not-found', `mock source has no ${interval} recording of ${ticker}`)
  }
  const body: unknown = JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'))
  return { chart: parseChart(body, ticker), day: pattern.exec(name)?.[1] as string }
}

export interface MockSourceOptions {
  /** Current Unix time in seconds, used to stamp live prices. Injected for tests. */
  now?: () => number
}

/**
 * Offline relay source that replays the recorded Yahoo fixtures in `fixtures/yahoo/`, re-stamped
 * to the requested `closeTs`. Never touches the network. It answers as if the close has already
 * passed, and as if the session is open for live prices, so callers decide when to ask.
 */
export function createMockSource(
  options: MockSourceOptions = {},
): PriceProvider & LivePriceProvider & IntradayPriceProvider {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000))
  return {
    name: 'mock',

    async prepareClose(ticker, closeTs) {
      const { chart, day } = recording(ticker, '1m')
      const recordedClose = closeOfDay(day)
      const inputs = closeInputs(chart, ticker, recordedClose)
      if (inputs === null) return null
      const shift = closeTs - recordedClose
      return {
        ...inputs,
        closeTs,
        updates: inputs.updates.map((update) => ({
          ...update,
          publishTime: update.publishTime + shift,
        })),
      }
    },

    async previousClose(ticker, previousTradingDay) {
      const latest = completedDailyCloses(
        recording(ticker, '1d').chart,
        Number.MAX_SAFE_INTEGER,
      ).at(-1)
      if (latest === undefined) {
        throw new PriceSourceError('not-found', `mock source has no daily close for ${ticker}`)
      }
      return { ticker, price: latest.price, tradingDay: previousTradingDay }
    },

    /** The recording's last regular-session price, re-stamped to now. */
    async latest(ticker) {
      const { chart } = recording(ticker, '1m')
      return toNormalized(ticker, chart.regularMarketPrice, 0, now(), false)
    },

    async intraday(ticker, fromTs, toTs) {
      return notImplemented(ticker, fromTs, toTs)
    },
  }
}
