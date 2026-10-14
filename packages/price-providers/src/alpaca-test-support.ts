import type { StreamTranscript } from './alpaca-fake-stream.js'
import { jsonResponse, readFixtureText } from './test-support.js'
import type { Route } from './test-support.js'

/** 2026-10-13 16:00 ET, the close the Alpaca fixtures are built around. */
export const ALPACA_CLOSE_TS = 1791921600
/** 2026-10-13 09:30 ET. */
export const ALPACA_OPEN_TS = 1791898200
/** 2026-10-14 11:11:30 ET, just after the recorded websocket sessions. */
export const STREAM_NOW = Date.parse('2026-10-14T15:11:30Z') / 1000

export const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA']

/** Test credentials; real ones never appear in tests or fixtures. */
export const KEYS = { keyId: 'test-key-id-PK0000', secretKey: 'test-secret-0000000000' }

export interface AlpacaBar {
  t: string
  o: number
  h: number
  l: number
  c: number
  v: number
  n: number
  vw: number
}

export interface BarsResponse {
  bars: Record<string, AlpacaBar[]>
  next_page_token: string | null
}

export interface AlpacaTrade {
  c: string[]
  i: number
  p: number
  s: number
  t: string
  x: string
  z: string
}

export interface Snapshot {
  latestTrade: AlpacaTrade
  latestQuote: { ap: number; bp: number; t: string }
  dailyBar: AlpacaBar
  prevDailyBar: AlpacaBar
  minuteBar: AlpacaBar
}

export function readAlpacaText(name: string): string {
  return readFixtureText(`alpaca/${name}`)
}

export function readAlpacaJson<T>(name: string): T {
  return JSON.parse(readAlpacaText(name)) as T
}

export const fixtures = {
  daily: () => readAlpacaJson<BarsResponse>('bars-1day-7-2026-10-13-sip.json'),
  session: () => readAlpacaJson<BarsResponse>('bars-1min-AAPL-MSFT-2026-10-13-session-sip.json'),
  closeSip: () => readAlpacaJson<BarsResponse>('bars-1min-7-2026-10-13-close-sip.json'),
  closeIex: () => readAlpacaJson<BarsResponse>('bars-1min-AAPL-2026-10-13-close-iex.json'),
  closeTrades: () =>
    readAlpacaJson<{ trades: Record<string, AlpacaTrade[]> }>(
      'trades-AAPL-2026-10-13-close-sip.json',
    ),
  snapshots: () => readAlpacaJson<Record<string, Snapshot>>('snapshots-7-iex-2026-10-14.json'),
  trades: () => readAlpacaJson<StreamTranscript>('stream-iex-trades-2026-10-14.json'),
  quotes: () => readAlpacaJson<StreamTranscript>('stream-iex-quotes-2026-10-14.json'),
}

export function unixOf(iso: string): number {
  return Date.parse(iso) / 1000
}

/** The bar of `ticker` that starts at `ts`. */
export function barAt(response: BarsResponse, ticker: string, ts: number): AlpacaBar {
  const bar = response.bars[ticker]?.find((entry) => unixOf(entry.t) === ts)
  if (!bar) throw new Error(`fixture has no ${ticker} bar at ${ts}`)
  return bar
}

/** Removes the bars of every ticker whose start matches `drop`. */
export function withoutBars(response: BarsResponse, drop: (ts: number) => boolean): BarsResponse {
  const bars = Object.fromEntries(
    Object.entries(response.bars).map(([ticker, list]) => [
      ticker,
      list.filter((bar) => !drop(unixOf(bar.t))),
    ]),
  )
  return { ...response, bars }
}

function timeParam(value: string | null): number | null {
  if (value === null) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed / 1000 : null
}

function symbolsOf(url: URL): string[] {
  return (url.searchParams.get('symbols') ?? '').split(',').filter(Boolean)
}

export interface AlpacaRouteSpec {
  /** Bars responses keyed `<timeframe>:<feed>`, for example `1Min:sip`. */
  bars?: Record<string, BarsResponse>
  snapshots?: Record<string, Snapshot>
  /** Answer every `feed=sip` request with the recorded 403 for recent SIP data. */
  sipRefused?: boolean
}

export function sipRefusedResponse(): Response {
  return new Response(readAlpacaText('sip-recent-refused.json'), {
    status: 403,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  })
}

/**
 * Answers the multi-symbol `/v2/stocks/bars` and `/v2/stocks/snapshots` endpoints from fixtures,
 * keeping only the requested symbols and the bars inside `start`..`end` (both inclusive), as the
 * API does. A request without an explicit `feed`, or for data there's no fixture for, gets 404.
 */
export function alpacaRoute(spec: AlpacaRouteSpec): Route {
  return (url) => {
    const feed = url.searchParams.get('feed')
    if (feed === 'sip' && spec.sipRefused) return sipRefusedResponse()
    const symbols = symbolsOf(url)
    if (url.pathname === '/v2/stocks/snapshots' && spec.snapshots) {
      const snapshots = spec.snapshots
      return jsonResponse(
        Object.fromEntries(
          symbols
            .filter((symbol) => snapshots[symbol])
            .map((symbol) => [symbol, snapshots[symbol]]),
        ),
      )
    }
    const fixture = spec.bars?.[`${url.searchParams.get('timeframe')}:${feed}`]
    if (url.pathname !== '/v2/stocks/bars' || !fixture) {
      return jsonResponse({ message: 'not found' }, 404)
    }
    const start = timeParam(url.searchParams.get('start')) ?? -Infinity
    const end = timeParam(url.searchParams.get('end')) ?? Infinity
    const bars = Object.fromEntries(
      symbols
        .map((symbol): [string, AlpacaBar[]] => [
          symbol,
          (fixture.bars[symbol] ?? []).filter((bar) => {
            const ts = unixOf(bar.t)
            return ts >= start && ts <= end
          }),
        ])
        .filter(([, list]) => list.length > 0),
    )
    return jsonResponse({ bars, next_page_token: null })
  }
}

/** The last trade per ticker in a recorded stream session. */
export function lastTrades(recording: StreamTranscript): Map<string, { p: number; t: string }> {
  const last = new Map<string, { p: number; t: string }>()
  recording.transcript
    .filter((entry) => entry.dir === 'server' && Array.isArray(entry.message))
    .flatMap((entry) => entry.message as Record<string, unknown>[])
    .filter((message) => message.T === 't')
    .forEach((message) =>
      last.set(String(message.S), { p: Number(message.p), t: String(message.t) }),
    )
  return last
}

/** The last quote per ticker in a recorded stream session. */
export function lastQuotes(recording: StreamTranscript): Map<string, { bp: number; ap: number }> {
  const last = new Map<string, { bp: number; ap: number }>()
  recording.transcript
    .filter((entry) => entry.dir === 'server' && Array.isArray(entry.message))
    .flatMap((entry) => entry.message as Record<string, unknown>[])
    .filter((message) => message.T === 'q')
    .forEach((message) =>
      last.set(String(message.S), { bp: Number(message.bp), ap: Number(message.ap) }),
    )
  return last
}

/** A trade message in the stream's schema, for tickers the recorded session didn't trade. */
export function tradeMessage(ticker: string, price: number, iso: string): Record<string, unknown> {
  return { T: 't', S: ticker, i: 1, x: 'V', p: price, s: 1, c: ['@'], t: iso, z: 'C' }
}
