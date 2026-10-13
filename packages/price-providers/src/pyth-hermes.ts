import { PriceSourceError } from './errors.js'
import { getJson, hexBytes } from './http.js'
import { isRecord, malformed } from './parse.js'
import { bareFeedId, normalizePythUpdates } from './pyth.js'
import type { PriceProvider, SettlementInputs } from './types.js'

export interface PythHermesOptions {
  /** Hermes base URL, without a trailing slash. */
  baseUrl: string
  /** Sent with every request. */
  accessToken: string
  /** Feed ID per ticker: 64 hex digits, with or without `0x`. */
  feedIds: Readonly<Record<string, string>>
  fetch?: typeof fetch
}

/** One ticker's Hermes update at a close: the normalized prices and the signed update data. */
export interface PythCloseUpdate extends SettlementInputs {
  /** The feed ID the update is for: 64 lowercase hex digits, no `0x`. */
  feedId: string
  /**
   * The signed accumulator update data from the response's `binary.data`, decoded from hex, as
   * the receiver program takes it when posting `PriceUpdateV2` accounts.
   */
  binary: Uint8Array[]
}

export interface PythHermesProvider extends PriceProvider {
  /**
   * `GET /v2/updates/price/{closeTs}` for the ticker's feed: the update published at `closeTs`, or
   * null when Hermes has none for that time yet (404).
   */
  prepareClose(ticker: string, closeTs: number): Promise<PythCloseUpdate | null>
}

function binaryOf(response: Record<string, unknown>): Uint8Array[] {
  const { binary } = response
  if (!isRecord(binary) || binary.encoding !== 'hex' || !Array.isArray(binary.data)) {
    throw malformed('Hermes response has no hex binary data')
  }
  return binary.data.map((hex) => {
    const bytes = typeof hex === 'string' ? hexBytes(hex) : null
    if (!bytes) throw malformed('Hermes binary data is not hex bytes')
    return bytes
  })
}

/** A Pyth `PriceProvider` that reads Hermes over HTTP. */
export function createPythHermesProvider(options: PythHermesOptions): PythHermesProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const headers = {
    Authorization: `Bearer ${options.accessToken}`,
    Accept: 'application/json',
  }

  return {
    name: 'pyth',

    async prepareClose(ticker, closeTs) {
      const configured = options.feedIds[ticker]
      if (configured === undefined) {
        throw new PriceSourceError('not-found', `no Pyth feed ID configured for ${ticker}`)
      }
      const feedId = bareFeedId(configured)
      const url = new URL(`${options.baseUrl}/v2/updates/price/${closeTs}`)
      url.searchParams.append('ids[]', `0x${feedId}`)
      url.searchParams.set('encoding', 'hex')
      url.searchParams.set('parsed', 'true')
      const body = await getJson(url, { fetch: fetchImpl, headers, label: 'Hermes' })
      if (body === null) return null
      if (!isRecord(body)) throw malformed('Hermes response is not an object')
      const updates = normalizePythUpdates(body, {
        closeTs,
        feedIds: { [ticker]: feedId },
      }).filter((update) => update.ticker === ticker)
      if (updates.length === 0) return null
      return { ticker, closeTs, updates, feedId, binary: binaryOf(body) }
    },

    // Strikes come from the relay source's daily closes; Hermes serves prices at a time only.
    async previousClose(ticker) {
      throw new PriceSourceError('not-found', `Hermes serves no daily close for ${ticker}`)
    },
  }
}
