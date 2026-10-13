import type {
  NormalizedPrice,
  PreviousClose,
  PriceProvider,
  SettlementInputs,
} from '@meridian/price-providers'
import type { Clock, CloseRequest, LivePriceSource, OracleClient } from './types.js'

export const RELAY_SIGNER = 'RelaySigner1111111111111111111111111111111'
export const EXPO = -10
/** One dollar at `EXPO`. */
export const DOLLAR = 10_000_000_000n

/** Unix seconds for a wall-clock time in New York during EDT (UTC-4), e.g. 2026-10-12. */
export function edt(date: string, time: string): number {
  return Date.parse(`${date}T${time}-04:00`) / 1000
}

/** Unix seconds for a wall-clock time in New York during EST (UTC-5), e.g. 2026-11-27. */
export function est(date: string, time: string): number {
  return Date.parse(`${date}T${time}-05:00`) / 1000
}

export interface FakeClock extends Clock {
  /** Every `sleep` duration requested, in order. */
  readonly sleeps: number[]
}

/** A clock whose `sleep` advances time instantly. Throws if a loop sleeps implausibly often. */
export function createFakeClock(start: number, maxSleeps = 200_000): FakeClock {
  let now = start
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => now,
    async sleep(seconds) {
      sleeps.push(seconds)
      if (sleeps.length > maxSleeps) throw new Error(`fake clock: more than ${maxSleeps} sleeps`)
      if (!(seconds > 0)) throw new Error(`fake clock: tight loop, sleep(${seconds})`)
      now += seconds
    },
  }
}

export interface OracleCall {
  method: 'publishPrice' | 'publishClose' | 'publishLatest'
  at: number
  signature: string
  updates: NormalizedPrice[]
  close?: CloseRequest
}

export interface FakeOracle extends OracleClient {
  readonly calls: OracleCall[]
  /** Existing `PriceUpdate` keys, `ticker:publishTime`. */
  readonly prices: Set<string>
  /** Existing `CloseRecord` keys, `ticker:tradingDay`. */
  readonly closes: Set<string>
  /** When set and returning true, `publishLatest` rejects. */
  failLatest?: (now: number) => boolean
}

/**
 * In-memory `meridian_oracle` for one signer. Like the program, a second `PriceUpdate` at the same
 * `(ticker, publishTime)` or a second `CloseRecord` for the same `(ticker, tradingDay)` fails.
 */
export function createFakeOracle(clock: Clock, signer = RELAY_SIGNER): FakeOracle {
  const calls: OracleCall[] = []
  const prices = new Set<string>()
  const closes = new Set<string>()
  const oracle: FakeOracle = {
    signer,
    calls,
    prices,
    closes,
    async priceUpdateExists(ticker, publishTime) {
      return prices.has(`${ticker}:${publishTime}`)
    },
    async closeRecordExists(ticker, tradingDay) {
      return closes.has(`${ticker}:${tradingDay}`)
    },
    async publishPrice(update) {
      const key = `${update.ticker}:${update.publishTime}`
      if (prices.has(key)) throw new Error(`PriceUpdate ${key} already exists`)
      prices.add(key)
      const signature = `sig-${calls.length + 1}`
      calls.push({ method: 'publishPrice', at: clock.now(), signature, updates: [update] })
      return signature
    },
    async publishClose(request) {
      const key = `${request.ticker}:${request.tradingDay}`
      if (closes.has(key)) throw new Error(`CloseRecord ${key} already exists`)
      request.updates.forEach((update) => {
        const priceKey = `${update.ticker}:${update.publishTime}`
        if (!prices.has(priceKey))
          throw new Error(`CloseRecord ${key} needs PriceUpdate ${priceKey}`)
      })
      closes.add(key)
      const signature = `sig-${calls.length + 1}`
      calls.push({
        method: 'publishClose',
        at: clock.now(),
        signature,
        updates: request.updates,
        close: request,
      })
      return signature
    },
    async publishLatest(updates) {
      if (oracle.failLatest?.(clock.now()))
        throw new Error('publish_latest failed: blockhash expired')
      const signature = `sig-${calls.length + 1}`
      calls.push({ method: 'publishLatest', at: clock.now(), signature, updates })
      return signature
    },
  }
  return oracle
}

export function price(
  ticker: string,
  dollars: number,
  publishTime: number,
  extra: Partial<NormalizedPrice> = {},
): NormalizedPrice {
  return {
    ticker,
    price: BigInt(Math.round(dollars * 10_000)) * (DOLLAR / 10_000n),
    conf: 0n,
    expo: EXPO,
    publishTime,
    session: 'regular',
    officialClose: false,
    ...extra,
  }
}

/** What a scripted source answers for one ticker at a given time. */
export type CloseScript = (ticker: string, closeTs: number, now: number) => NormalizedPrice[] | null

export interface FakeCloseSource extends PriceProvider {
  /** Times `prepareClose` was called, per ticker. */
  readonly asked: Map<string, number[]>
}

/** A relay source driven by a script, recording every call. A script may throw to simulate errors. */
export function createScriptedSource(
  clock: Clock,
  script: CloseScript,
  name = 'scripted',
): FakeCloseSource {
  const asked = new Map<string, number[]>()
  return {
    name,
    asked,
    async prepareClose(ticker, closeTs): Promise<SettlementInputs | null> {
      asked.set(ticker, [...(asked.get(ticker) ?? []), clock.now()])
      const updates = script(ticker, closeTs, clock.now())
      return updates === null ? null : { ticker, closeTs, updates }
    },
    async previousClose(ticker, previousTradingDay): Promise<PreviousClose> {
      return { ticker, price: 100, tradingDay: previousTradingDay }
    },
  }
}

export interface FakeLiveSource extends LivePriceSource {
  readonly asked: number[]
  /** When set and returning true, `latest` rejects. */
  fail?: (now: number) => boolean
  /** Tickers the source has no price for. */
  missing: Set<string>
}

export function createFakeLiveSource(clock: Clock): FakeLiveSource {
  const asked: number[] = []
  const source: FakeLiveSource = {
    name: 'scripted',
    asked,
    missing: new Set(),
    async latest(ticker) {
      asked.push(clock.now())
      if (source.fail?.(clock.now())) throw new Error('HTTP 429')
      if (source.missing.has(ticker)) return null
      return price(ticker, 100, clock.now() - 5)
    },
  }
  return source
}

export interface LogCapture {
  write: (line: string) => void
  lines: string[]
  /** Every line parsed as JSON. Fails the test on a line that isn't. */
  entries: () => Record<string, unknown>[]
}

export function captureLog(): LogCapture {
  const lines: string[] = []
  return {
    lines,
    write: (line) => {
      lines.push(line)
    },
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  }
}

/** The log entry that records a published value: same ticker, publish time, price and signature. */
export function findValueLog(
  entries: Record<string, unknown>[],
  update: NormalizedPrice,
  signature: string,
): Record<string, unknown> | undefined {
  return entries.find(
    (entry) =>
      entry.ticker === update.ticker &&
      entry.publishTime === update.publishTime &&
      entry.price === update.price.toString() &&
      entry.conf === update.conf.toString() &&
      entry.expo === update.expo &&
      entry.signature === signature,
  )
}
