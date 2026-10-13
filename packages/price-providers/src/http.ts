import { PriceSourceError } from './errors.js'
import { malformed } from './parse.js'

const DEFAULT_TIMEOUT_MS = 10_000

export interface GetJsonOptions {
  fetch: typeof fetch
  headers: Record<string, string>
  /** Names the service in errors. */
  label: string
  timeoutMs?: number
}

/**
 * One GET, never retried: the JSON body, or null on a 404 (nothing at that time yet). Any other
 * failure is a `PriceSourceError`. Error messages never include the request headers, which carry
 * credentials.
 */
export async function getJson(url: URL, options: GetJsonOptions): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await options.fetch(url, {
      headers: options.headers,
      signal: controller.signal,
    })
    const text = await response.text()
    if (response.status === 404) return null
    if (response.status === 429) {
      throw new PriceSourceError('rate-limited', `${options.label} answered 429`)
    }
    if (!response.ok) {
      throw new PriceSourceError('http', `${options.label} answered ${response.status}`)
    }
    try {
      return JSON.parse(text) as unknown
    } catch (cause) {
      throw malformed(`${options.label} sent invalid JSON`, cause)
    }
  } catch (error) {
    if (error instanceof PriceSourceError) throw error
    if (controller.signal.aborted) {
      throw new PriceSourceError('timeout', `${options.label} took over ${timeoutMs} ms`)
    }
    throw new PriceSourceError('http', `${options.label} request failed`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

/** Bytes from hex, with or without `0x`; null when it isn't whole bytes of hex. */
export function hexBytes(hex: string): Uint8Array | null {
  const bare = hex.replace(/^0x/i, '')
  if (bare.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(bare)) return null
  return Uint8Array.from(Buffer.from(bare, 'hex'))
}
