import { readFileSync, readdirSync } from 'node:fs'
import { PriceSourceError } from './errors.js'
import { REGULAR_CLOSE_SECS, REGULAR_OPEN_SECS, newYorkMidnight } from './time.js'
import type {
  IntradayPoint,
  IntradayPriceProvider,
  LivePriceProvider,
  PriceProvider,
} from './types.js'
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

const MINUTE = 60

/** A stable 32-bit seed per ticker, so each ticker's mock series has its own shape. */
function tickerSeed(ticker: string): number {
  return [...ticker.toUpperCase()].reduce(
    (seed, char) => Math.imul(seed ^ char.charCodeAt(0), 0x01000193),
    0x811c9dc5,
  )
}

/** A deterministic value in [-0.5, 0.5) for one minute of one ticker's series. */
function noise(seed: number, minute: number): number {
  let x = Math.imul(seed ^ minute, 0x9e3779b1)
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b)
  x ^= x >>> 13
  return (x >>> 0) / 2 ** 32 - 0.5
}

/** Per-minute step of the mock walk, about 0.1% of the price. */
const MOCK_STEP = 0.002

/**
 * A synthetic 1-minute series around `base`: a random walk from the New York day's 9:30 open
 * that only depends on the ticker and the minute, so a refresh extends the same line instead of
 * redrawing a different one.
 */
export function syntheticIntraday(
  ticker: string,
  base: number,
  fromTs: number,
  toTs: number,
): IntradayPoint[] {
  const seed = tickerSeed(ticker)
  const openTs = newYorkMidnight(fromTs) + REGULAR_OPEN_SECS
  const first = Math.max(openTs, Math.ceil(fromTs / MINUTE) * MINUTE)
  const count = Math.max(0, Math.floor((toTs - first) / MINUTE) + 1)
  const skip = (first - openTs) / MINUTE
  const walk = Array.from({ length: skip + count }, (_, i) => noise(seed, openTs / MINUTE + i))
  const levels = walk.reduce<number[]>((acc, step) => {
    acc.push((acc.at(-1) ?? 0) + step * MOCK_STEP)
    return acc
  }, [])
  return levels.slice(skip).map((level, i) => ({
    t: first + i * MINUTE,
    price: Number((base * Math.exp(level)).toFixed(2)),
  }))
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

    /** A synthetic series around the recording's last price, for any window. */
    async intraday(ticker, fromTs, toTs) {
      const { chart } = recording(ticker, '1m')
      return syntheticIntraday(ticker, chart.regularMarketPrice, fromTs, toTs)
    },
  }
}
