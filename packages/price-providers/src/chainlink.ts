import { isRecord, malformed, parseInteger, parseTimestamp } from './parse.js'
import type { NormalizedPrice } from './types.js'

/** v11 prices are fixed-point with 18 decimals. */
const V11_EXPO = -18

/** `marketStatus` values in a v11 report. Only regular hours counts as the regular session. */
const MARKET_STATUS_REGULAR = 2

function optionalPrice(report: Record<string, unknown>, field: string): bigint | null {
  if (report[field] === undefined || report[field] === null) return null
  const value = parseInteger(report[field], field)
  return value > 0n ? value : null
}

/**
 * Normalizes a decoded Data Streams RWA Advanced (v11) report: price is `lastTradedPrice` when
 * present, else `mid`; conf is half the bid-ask spread; session is regular only when
 * `marketStatus` is regular hours. Never an official close.
 */
export function normalizeChainlinkV11Report(
  report: unknown,
  context: { ticker: string },
): NormalizedPrice {
  if (!isRecord(report)) throw malformed('v11 report is not an object')
  const price = optionalPrice(report, 'lastTradedPrice') ?? optionalPrice(report, 'mid')
  if (price === null) throw malformed('v11 report has neither a last traded price nor a mid')
  const bid = parseInteger(report.bid, 'bid')
  const ask = parseInteger(report.ask, 'ask')
  if (ask < bid) throw malformed(`v11 report has a crossed quote: bid ${bid}, ask ${ask}`)
  // Round half a tick up so the published band never understates the spread.
  const conf = (ask - bid + 1n) / 2n
  return {
    ticker: context.ticker,
    price,
    conf,
    expo: V11_EXPO,
    publishTime: parseTimestamp(report.observationsTimestamp, 'observationsTimestamp'),
    session: report.marketStatus === MARKET_STATUS_REGULAR ? 'regular' : 'outside-regular',
    officialClose: false,
  }
}
