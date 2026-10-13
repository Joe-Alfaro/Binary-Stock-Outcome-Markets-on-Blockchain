import { isTradingDay, tradingDayTimes } from '../calendar/index.js'

const DAY_SECS = 24 * 60 * 60
/** How far ahead `nextOpen` looks; the longest market closure is well under this. */
const LOOKAHEAD_DAYS = 10

const newYorkDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The `YYYY-MM-DD` New York calendar day of a Unix timestamp. */
function newYorkDay(ts: number): string {
  return newYorkDate.format(new Date(ts * 1000))
}

/** The regular session of `day`, or null on a non-trading day or one outside the calendar data. */
function sessionOf(day: string): { open: number; close: number } | null {
  try {
    if (!isTradingDay(day)) return null
    const times = tradingDayTimes(day)
    return { open: times.tradingOpenTs, close: times.closeTs }
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

/** Whether `now` is inside a regular session: from the open, up to but excluding the close. */
export function isRegularSessionOpen(now: number): boolean {
  const session = sessionOf(newYorkDay(now))
  return session !== null && now >= session.open && now < session.close
}

/** The next regular-session open after `now`, or null when the calendar data doesn't cover it. */
export function nextOpen(now: number): number | null {
  const opens = Array.from({ length: LOOKAHEAD_DAYS }, (_, offset) =>
    sessionOf(newYorkDay(now + offset * DAY_SECS)),
  ).map((session) => session?.open)
  return opens.find((open) => open !== undefined && open > now) ?? null
}
