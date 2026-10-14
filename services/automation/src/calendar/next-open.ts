/**
 * The next regular-session open on the NYSE calendar, for the Markets cards' Closed tag (R68).
 * Pure functions of `now` (Unix seconds); every answer is in America/New_York whatever the host's
 * time zone. Imports only the calendar, so the web app can bundle it.
 */
import { isTradingDay, tradingDayTimes } from './index.js'

const DAY_MS = 24 * 60 * 60 * 1000

const newYorkDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

const newYorkWeekday = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
})

const WEEKEND = new Set(['Sat', 'Sun'])

/** The calendar day after a `YYYY-MM-DD` date. */
function dayAfter(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
}

/** The first trading day strictly after `date`. Throws a `RangeError` past the calendar data. */
function nextTradingDay(date: string): string {
  const candidate = dayAfter(date)
  return isTradingDay(candidate) ? candidate : nextTradingDay(candidate)
}

/** The trading day whose open comes next at `now`, or null while the session is open. */
function nextOpenDate(now: number): string | null {
  const today = newYorkDate.format(new Date(now * 1000))
  if (!isTradingDay(today)) return nextTradingDay(today)
  const times = tradingDayTimes(today)
  if (now < times.tradingOpenTs) return today
  if (now < times.closeTs) return null
  return nextTradingDay(today)
}

/** "today", "tomorrow" or the weekday of `date`'s open, as seen from `now` in New York. */
function reopenDay(now: number, date: string): string {
  const today = newYorkDate.format(new Date(now * 1000))
  if (date === today) return 'today'
  const weekday = (ts: number) => newYorkWeekday.format(ts * 1000)
  // Over a weekend the tag always names the day: Sunday evening reads "Reopens Mon".
  if (date === dayAfter(today) && !WEEKEND.has(weekday(now))) return 'tomorrow'
  return weekday(tradingDayTimes(date).tradingOpenTs)
}

/** Runs a calendar lookup, mapping "outside the calendar data" to null like `chartSession`. */
function withinCalendar<T>(lookup: () => T): T | null {
  try {
    return lookup()
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

/**
 * 9:30 AM ET (Unix seconds) of the next trading day's open while the regular session is closed:
 * later today before the open, otherwise the next trading day, skipping weekends and holidays.
 * Early closes don't move it. Null while the session is open (9:30 AM ET up to but excluding the
 * close, 4:00 PM ET or 1:00 PM ET on an early close) or when the answer falls outside the
 * calendar data.
 */
export function nextOpen(now: number): number | null {
  return withinCalendar(() => {
    const date = nextOpenDate(now)
    return date === null ? null : tradingDayTimes(date).tradingOpenTs
  })
}

/**
 * The Closed tag's reopen line, "Reopens today 9:30 AM ET", "Reopens tomorrow 9:30 AM ET" or
 * "Reopens <Mon|Tue|…> 9:30 AM ET", with today and tomorrow meant as New York calendar days.
 * On a Saturday or Sunday it always names the day, so Sunday evening reads "Reopens Mon".
 * Null exactly when `nextOpen(now)` is null: no tag while the session is open.
 */
export function reopenLabel(now: number): string | null {
  return withinCalendar(() => {
    const date = nextOpenDate(now)
    if (date === null) return null
    return `Reopens ${reopenDay(now, date)} 9:30 AM ET`
  })
}
