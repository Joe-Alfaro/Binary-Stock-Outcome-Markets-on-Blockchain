import type { Ticker } from '../../src/lib/chain'
import type { IntradayClient, IntradayPoint, IntradaySeries } from '../../src/lib/intraday'

/**
 * Stands in for the worker's intraday route. Each ticker answers with its configured series or
 * error; a ticker with neither rejects, as an unreachable worker would.
 */
export class FakeIntraday implements IntradayClient {
  series = new Map<Ticker, IntradaySeries | Error>()
  calls: Ticker[] = []

  async get(ticker: Ticker): Promise<IntradaySeries> {
    this.calls.push(ticker)
    const answer = this.series.get(ticker)
    if (answer === undefined) throw new Error(`no intraday series for ${ticker}`)
    if (answer instanceof Error) throw answer
    return answer
  }

  callsFor(ticker: Ticker): number {
    return this.calls.filter((call) => call === ticker).length
  }
}

/** A series whose points run one per `stepSecs` from `openTs`, with the given prices. */
export function intradaySeries(
  fields: Omit<IntradaySeries, 'points' | 'endTs' | 'earlyClose'> & {
    prices: number[]
    stepSecs?: number
    earlyClose?: boolean
  },
): IntradaySeries {
  const { prices, stepSecs = 60, earlyClose = false, ...rest } = fields
  const points: IntradayPoint[] = prices.map((price, i) => ({
    t: fields.openTs + i * stepSecs,
    price,
  }))
  return { ...rest, earlyClose, endTs: points.at(-1)?.t ?? fields.openTs, points }
}
