/**
 * NYSE trading calendar for the years with checked-in holiday and early-close data (2026, 2027).
 * Dates are exchange-local calendar days written as `YYYY-MM-DD` (America/New_York).
 */
import { NYSE_CALENDAR } from './nyse-data.js'

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

const EXCHANGE_TIME_ZONE = 'America/New_York'
const DAY_MS = 24 * 60 * 60 * 1000
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

const HOLIDAYS = new Set(Object.values(NYSE_CALENDAR).flatMap((year) => year.holidays))
const EARLY_CLOSES = new Set(Object.values(NYSE_CALENDAR).flatMap((year) => year.earlyCloses))

const exchangeClock = new Intl.DateTimeFormat('en-US', {
  timeZone: EXCHANGE_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
})

interface CalendarDate {
  year: number
  month: number
  day: number
}

/** Parses and range-checks a `YYYY-MM-DD` date, throwing a `RangeError` on bad input. */
function parseDate(date: string): CalendarDate {
  const match = DATE_PATTERN.exec(date)
  if (!match) throw new RangeError(`malformed date ${JSON.stringify(date)}, expected YYYY-MM-DD`)
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const parsed = new Date(Date.UTC(year, month - 1, day))
  if (parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new RangeError(`invalid calendar date ${date}`)
  }
  if (year < CALENDAR_FIRST_YEAR || year > CALENDAR_LAST_YEAR) {
    throw new RangeError(
      `${date} is outside the calendar data (${CALENDAR_FIRST_YEAR}-${CALENDAR_LAST_YEAR})`,
    )
  }
  return { year, month, day }
}

function isWeekend({ year, month, day }: CalendarDate): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday === 0 || weekday === 6
}

/** The calendar day before `date`, as `YYYY-MM-DD`, without range checks. */
function dayBefore({ year, month, day }: CalendarDate): string {
  return new Date(Date.UTC(year, month - 1, day) - DAY_MS).toISOString().slice(0, 10)
}

/** Offset of exchange-local wall time from UTC at `instantMs`, in milliseconds. */
function exchangeOffsetMs(instantMs: number): number {
  const parts = Object.fromEntries(
    exchangeClock.formatToParts(instantMs).map((part) => [part.type, Number(part.value)]),
  )
  const wallMs = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  )
  return wallMs - (instantMs - (instantMs % 1000))
}

/**
 * Unix seconds for an exchange-local wall-clock time. DST changes happen at 2:00 AM on Sundays,
 * so session times on trading days are never ambiguous or skipped.
 */
function exchangeTimeToUnix({ year, month, day }: CalendarDate, hour: number, minute: number) {
  const wallAsUtcMs = Date.UTC(year, month - 1, day, hour, minute)
  const firstGuess = wallAsUtcMs - exchangeOffsetMs(wallAsUtcMs)
  return (wallAsUtcMs - exchangeOffsetMs(firstGuess)) / 1000
}

/**
 * True when the exchange has a session on `date`.
 * Throws a `RangeError` for a malformed date or one outside the covered years.
 */
export function isTradingDay(date: string): boolean {
  const parsed = parseDate(date)
  return !isWeekend(parsed) && !HOLIDAYS.has(date)
}

/** True when `date` is a trading day that closes at 1:00 PM ET. Throws like `isTradingDay`. */
export function isEarlyClose(date: string): boolean {
  return isTradingDay(date) && EARLY_CLOSES.has(date)
}

/**
 * The last trading day strictly before `date`, whose close is the "previous close" for `date`.
 * Throws a `RangeError` when the answer would fall outside the covered years.
 */
export function previousTradingDay(date: string): string {
  const candidate = dayBefore(parseDate(date))
  return isTradingDay(candidate) ? candidate : previousTradingDay(candidate)
}

/** Mint open, trading open and close for a trading day. Throws a `RangeError` on a non-trading day. */
export function tradingDayTimes(date: string): TradingDayTimes {
  if (!isTradingDay(date)) throw new RangeError(`${date} is not a trading day`)
  const parsed = parseDate(date)
  const earlyClose = EARLY_CLOSES.has(date)
  return {
    mintOpenTs: exchangeTimeToUnix(parsed, 9, 0),
    tradingOpenTs: exchangeTimeToUnix(parsed, 9, 30),
    closeTs: exchangeTimeToUnix(parsed, earlyClose ? 13 : 16, 0),
    earlyClose,
  }
}
