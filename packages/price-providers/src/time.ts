const HOUR = 60 * 60

/** 09:30 ET, in seconds after New York midnight. */
export const REGULAR_OPEN_SECS = 9.5 * HOUR

/** 16:00 ET, the regular close on a full trading day. */
export const REGULAR_CLOSE_SECS = 16 * HOUR

const newYorkClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function newYorkParts(ts: number) {
  const parts = Object.fromEntries(
    newYorkClock.formatToParts(new Date(ts * 1000)).map((part) => [part.type, part.value]),
  )
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    secondsIntoDay: Number(parts.hour) * HOUR + Number(parts.minute) * 60 + Number(parts.second),
  }
}

/** The `YYYY-MM-DD` New York calendar day of a Unix timestamp. */
export function newYorkDay(ts: number): string {
  return newYorkParts(ts).day
}

/**
 * Unix time of New York midnight on the day of `ts`. DST changes fall at 2:00 AM on Sundays, so
 * this is exact for any time during a trading day.
 */
export function newYorkMidnight(ts: number): number {
  return ts - newYorkParts(ts).secondsIntoDay
}

/** Whether `ts` falls in the regular session that ends at `closeTs`: 09:30 ET to close, inclusive. */
export function inRegularSession(ts: number, closeTs: number): boolean {
  return ts >= newYorkMidnight(closeTs) + REGULAR_OPEN_SECS && ts <= closeTs
}
