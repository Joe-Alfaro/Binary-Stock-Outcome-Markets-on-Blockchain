import type { AlertSink } from './types.js'

/** Long enough for a slow endpoint, short enough that a hung one can't stall the caller. */
const DEFAULT_TIMEOUT_MS = 10_000

export interface WebhookSinkOptions {
  url: string
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Abort the request after this many milliseconds. Defaults to 10 s. */
  timeoutMs?: number
}

/**
 * Generic webhook sink: POSTs the alert as a JSON body (`kind`, `message`, `details`) with
 * `content-type: application/json`. Rejects on a network error, a timeout or a non-2xx response.
 */
export function createWebhookSink(options: WebhookSinkOptions): AlertSink {
  const { url, fetch: fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  return {
    name: 'webhook',
    async send(alert) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: alert.kind, message: alert.message, details: alert.details }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      // Release the connection; the endpoint's reply body carries nothing we use.
      await response.body?.cancel()
      if (!response.ok) {
        throw new Error(`webhook answered ${response.status} ${response.statusText}`.trim())
      }
    },
  }
}
