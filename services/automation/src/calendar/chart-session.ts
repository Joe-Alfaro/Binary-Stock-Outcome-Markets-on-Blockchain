import { isTradingDay, previousTradingDay, tradingDayTimes } from './index.js'

/**
 * Which regular session the Markets chart shows at a given instant (R66): today's session so far
 * while the market is open, otherwise the most recent complete session.
 */
export interface ChartSession {
  /** The session's trading day, `YYYY-MM-DD` in America/New_York. */
  date: string
  /** True while the session is open: the chart runs from the open to `now`. */
  live: boolean
  /** 9:30 AM ET on `date`, Unix seconds. */
  openTs: number
  /** `now` while live, else the session's close (4:00 PM ET, or 1:00 PM ET on an early close). */
  endTs: number
  earlyClose: boolean
}

const newYorkDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The full session of a trading day, `date` in America/New_York. */
function completeSession(date: string): ChartSession {
  const times = tradingDayTimes(date)
  return {
    date,
    live: false,
    openTs: times.tradingOpenTs,
    endTs: times.closeTs,
    earlyClose: times.earlyClose,
  }
}

function sessionAt(now: number): ChartSession {
  const today = newYorkDate.format(new Date(now * 1000))
  if (!isTradingDay(today)) return completeSession(previousTradingDay(today))
  const times = tradingDayTimes(today)
  if (now < times.tradingOpenTs) return completeSession(previousTradingDay(today))
  if (now >= times.closeTs) return completeSession(today)
  return {
    date: today,
    live: true,
    openTs: times.tradingOpenTs,
    endTs: now,
    earlyClose: times.earlyClose,
  }
}

/**
 * The session the chart shows at `now` (Unix seconds). The session is open from 9:30 AM ET up to
 * but excluding the close. Returns null when the answer falls outside the calendar data.
 */
export function chartSession(now: number): ChartSession | null {
  try {
    return sessionAt(now)
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}
