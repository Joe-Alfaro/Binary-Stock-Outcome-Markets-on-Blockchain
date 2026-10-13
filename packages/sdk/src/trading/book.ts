import type { BookLevel, YesBook } from './types.js'

/** The No view of a Yes book. Both sides are sorted best-first. */
export interface NoBook {
  bids: YesBook['bids']
  asks: YesBook['asks']
}

/** Prices in cents that can actually execute now; `null` when the needed Yes side is empty. */
export interface ExecutableQuotes {
  buyYes: number | null
  sellYes: number | null
  buyNo: number | null
  sellNo: number | null
}

function complement(levels: readonly BookLevel[]): BookLevel[] {
  return levels.map(({ priceCents, qty }) => ({ priceCents: impliedNoPrice(priceCents), qty }))
}

function bestBid(levels: readonly BookLevel[]): number | null {
  if (levels.length === 0) return null
  return Math.max(...levels.map((level) => level.priceCents))
}

function bestAsk(levels: readonly BookLevel[]): number | null {
  if (levels.length === 0) return null
  return Math.min(...levels.map((level) => level.priceCents))
}

/** No asks are `100 − Yes bids` and No bids are `100 − Yes asks`, with the same quantities. */
export function noView(book: YesBook): NoBook {
  return {
    bids: complement(book.asks).sort((a, b) => b.priceCents - a.priceCents),
    asks: complement(book.bids).sort((a, b) => a.priceCents - b.priceCents),
  }
}

/** Buy No fills against the best Yes bid and Sell No against the best Yes ask. */
export function executableQuotes(book: YesBook): ExecutableQuotes {
  const yesBid = bestBid(book.bids)
  const yesAsk = bestAsk(book.asks)
  return {
    buyYes: yesAsk,
    sellYes: yesBid,
    buyNo: yesBid === null ? null : impliedNoPrice(yesBid),
    sellNo: yesAsk === null ? null : impliedNoPrice(yesAsk),
  }
}

export function impliedNoPrice(yesPriceCents: number): number {
  return 100 - yesPriceCents
}
