import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { NormalizedPrice } from './types.js'

/** 2026-10-09 16:00 ET, the close every recorded fixture is built around. */
export const FIXTURE_CLOSE_TS = 1791576000

export type Bar = (number | null)[]

export interface YahooChartFixture {
  chart: {
    result: {
      meta: {
        symbol: string
        regularMarketPrice: number
        regularMarketTime: number
        postMarketPrice?: number
        [key: string]: unknown
      }
      timestamp?: number[]
      indicators: { quote: { open: Bar; high: Bar; low: Bar; close: Bar; volume: Bar }[] }
    }[]
    error: unknown
  }
}

export function readFixtureText(path: string): string {
  return readFileSync(new URL(`../fixtures/${path}`, import.meta.url), 'utf8')
}

export function readYahooFixture(name: string): YahooChartFixture {
  return JSON.parse(readFixtureText(`yahoo/${name}`)) as YahooChartFixture
}

export function chartOf(fixture: YahooChartFixture) {
  const result = fixture.chart.result[0]
  assert.ok(result, 'fixture has a chart result')
  const quote = result.indicators.quote[0]
  assert.ok(quote, 'fixture has a quote series')
  return { meta: result.meta, timestamp: result.timestamp ?? [], quote }
}

/** Index of the 1-minute bar that starts at `ts`. */
export function barIndex(fixture: YahooChartFixture, ts: number): number {
  const index = chartOf(fixture).timestamp.indexOf(ts)
  assert.notEqual(index, -1, `fixture has a bar at ${ts}`)
  return index
}

/** Blanks bars the way Yahoo reports missing minutes: every field null. */
export function blankBars(fixture: YahooChartFixture, starts: number[]): void {
  const { quote } = chartOf(fixture)
  starts.forEach((ts) => {
    const index = barIndex(fixture, ts)
    quote.open[index] = null
    quote.high[index] = null
    quote.low[index] = null
    quote.close[index] = null
    quote.volume[index] = null
  })
}

/** Removes bars entirely, as when Yahoo has no row for those minutes. */
export function dropBars(fixture: YahooChartFixture, starts: number[]): void {
  const result = fixture.chart.result[0]
  assert.ok(result?.timestamp)
  const keep = result.timestamp.map((ts) => !starts.includes(ts))
  const series = chartOf(fixture).quote
  result.timestamp = result.timestamp.filter((_, i) => keep[i])
  series.open = series.open.filter((_, i) => keep[i])
  series.high = series.high.filter((_, i) => keep[i])
  series.low = series.low.filter((_, i) => keep[i])
  series.close = series.close.filter((_, i) => keep[i])
  series.volume = series.volume.filter((_, i) => keep[i])
}

export function barAt(fixture: YahooChartFixture, ts: number) {
  const index = barIndex(fixture, ts)
  const { quote } = chartOf(fixture)
  return {
    open: quote.open[index],
    high: quote.high[index],
    low: quote.low[index],
    close: quote.close[index],
  }
}

/** The decimal value of a normalized price, `price × 10^expo`. */
export function valueOf(price: NormalizedPrice): number {
  return Number(price.price) * 10 ** price.expo
}

export function confOf(price: NormalizedPrice): number {
  return Number(price.conf) * 10 ** price.expo
}

export function assertClose(actual: number, expected: number, message?: string): void {
  const tolerance = 1e-9 * Math.max(1, Math.abs(expected))
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be close to ${expected}`,
  )
}

export function assertNormalizedShape(price: NormalizedPrice): void {
  assert.equal(typeof price.price, 'bigint')
  assert.equal(typeof price.conf, 'bigint')
  assert.ok(Number.isInteger(price.expo))
  assert.ok(Number.isInteger(price.publishTime))
  assert.ok(price.conf >= 0n, 'conf is non-negative')
}

export interface RecordedCall {
  url: URL
  headers: Headers
}

export type Route = (url: URL) => Response | Promise<Response>

/** A fetch stand-in that records each request and answers from `route`. */
export function fakeFetch(route: Route): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  async function fetchStub(input: string | URL | Request, init?: RequestInit) {
    const request = input instanceof Request ? input : null
    const url = new URL(request ? request.url : String(input))
    const headers = new Headers(request ? request.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    calls.push({ url, headers })
    return route(url)
  }
  return { fetch: fetchStub as typeof fetch, calls }
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8' },
  })
}

/** Answers 1-minute requests with `minute` and daily requests with `daily`. */
export function yahooRoute(minute: YahooChartFixture, daily: YahooChartFixture): Route {
  return (url) => jsonResponse(url.searchParams.get('interval') === '1d' ? daily : minute)
}
