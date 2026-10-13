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

/**
 * The session the chart shows at `now` (Unix seconds). The session is open from 9:30 AM ET up to
 * but excluding the close. Returns null when the answer falls outside the calendar data.
 */
export function chartSession(now: number): ChartSession | null {
  throw new Error(`chartSession not implemented (now ${now})`)
}
