/**
 * NYSE trading calendar for the years with checked-in holiday and early-close data (2026, 2027).
 * Dates are exchange-local calendar days written as `YYYY-MM-DD` (America/New_York).
 */

/** Unix timestamps (seconds) for one trading day. */
export interface TradingDayTimes {
  /** 9:00 AM ET: minting opens. */
  mintOpenTs: number
  /** 9:30 AM ET: the regular session and trading open. */
  tradingOpenTs: number
  /** 4:00 PM ET, or 1:00 PM ET on an early-close day. */
  closeTs: number
  earlyClose: boolean
}

/** First and last calendar years covered by the checked-in data. */
export const CALENDAR_FIRST_YEAR = 2026
export const CALENDAR_LAST_YEAR = 2027

/**
 * True when the exchange has a session on `date`.
 * Throws a `RangeError` for a malformed date or one outside the covered years.
 */
export function isTradingDay(date: string): boolean {
  throw new Error(`not implemented: isTradingDay(${date})`)
}

/** True when `date` is a trading day that closes at 1:00 PM ET. Throws like `isTradingDay`. */
export function isEarlyClose(date: string): boolean {
  throw new Error(`not implemented: isEarlyClose(${date})`)
}

/**
 * The last trading day strictly before `date`, whose close is the "previous close" for `date`.
 * Throws a `RangeError` when the answer would fall outside the covered years.
 */
export function previousTradingDay(date: string): string {
  throw new Error(`not implemented: previousTradingDay(${date})`)
}

/** Mint open, trading open and close for a trading day. Throws a `RangeError` on a non-trading day. */
export function tradingDayTimes(date: string): TradingDayTimes {
  throw new Error(`not implemented: tradingDayTimes(${date})`)
}
