/**
 * The next regular-session open on the NYSE calendar, for the Markets cards' Closed tag (R68).
 * Pure functions of `now` (Unix seconds); every answer is in America/New_York whatever the host's
 * time zone.
 */

/**
 * 9:30 AM ET (Unix seconds) of the next trading day's open while the regular session is closed:
 * later today before the open, otherwise the next trading day, skipping weekends and holidays.
 * Early closes don't move it. Null while the session is open (9:30 AM ET up to but excluding the
 * close, 4:00 PM ET or 1:00 PM ET on an early close) or when the answer falls outside the
 * calendar data.
 */
export function nextOpen(now: number): number | null {
  void now
  throw new Error('not implemented: nextOpen (R68)')
}

/**
 * The Closed tag's reopen line, "Reopens today 9:30 AM ET", "Reopens tomorrow 9:30 AM ET" or
 * "Reopens <Mon|Tue|…> 9:30 AM ET", with today and tomorrow meant as New York calendar days.
 * Null exactly when `nextOpen(now)` is null: no tag while the session is open.
 */
export function reopenLabel(now: number): string | null {
  void now
  throw new Error('not implemented: reopenLabel (R68)')
}
