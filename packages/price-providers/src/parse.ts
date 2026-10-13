import { PriceSourceError } from './errors.js'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function malformed(message: string, cause?: unknown): PriceSourceError {
  return new PriceSourceError('malformed', message, cause === undefined ? undefined : { cause })
}

/** An integer sent as a decimal string (the usual encoding for 64-bit values) or a safe number. */
export function parseInteger(value: unknown, field: string): bigint {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  throw malformed(`${field} is not an integer: ${String(value)}`)
}

export function parseTimestamp(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  throw malformed(`${field} is not a Unix timestamp: ${String(value)}`)
}
