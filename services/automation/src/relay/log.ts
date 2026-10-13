import type { NormalizedPrice } from '@meridian/price-providers'
import type { LineWriter } from '../alerts/index.js'

export type RelayLogEntry = Record<string, unknown> & { event: string }

/** Writes JSON lines. In demo mode every line carries `replayed: true` (R44). */
export function createRelayLog(write: LineWriter, demo: boolean) {
  return (entry: RelayLogEntry) => {
    write(JSON.stringify(demo ? { ...entry, replayed: true } : entry))
  }
}

/** A published value's fields as JSON-safe log fields; bigints become decimal strings. */
export function valueFields(update: NormalizedPrice) {
  return {
    ticker: update.ticker,
    price: update.price.toString(),
    conf: update.conf.toString(),
    expo: update.expo,
    publishTime: update.publishTime,
    session: update.session,
    officialClose: update.officialClose,
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
