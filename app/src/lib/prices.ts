import { formatEt } from './format'

/** A latest price older than this is shown as stale (R47). */
export const STALE_AFTER_SECONDS = 300

export function isStale(publishTs: number, nowTs: number): boolean {
  return nowTs - publishTs > STALE_AFTER_SECONDS
}

/** Publish time in America/New_York, for example `10:19:30 AM ET`. */
export function formatPublishTime(publishTs: number): string {
  return formatEt(publishTs)
}
