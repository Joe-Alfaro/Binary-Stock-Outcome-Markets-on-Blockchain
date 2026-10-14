export type PriceSourceErrorCode =
  | 'timeout'
  | 'rate-limited'
  | 'malformed'
  | 'http'
  | 'not-found'
  | 'stale'
  | 'unauthorized'

/** Every failure a price source reports, so callers can decide whether to retry or alert. */
export class PriceSourceError extends Error {
  readonly code: PriceSourceErrorCode

  constructor(code: PriceSourceErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PriceSourceError'
    this.code = code
  }
}

/** Placeholder body for interfaces awaiting implementation. */
export function notImplemented(...args: unknown[]): never {
  throw new Error(`not implemented (called with ${args.length} arguments)`)
}
