/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import type { YesBook } from './types.js'

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

export function noView(_book: YesBook): NoBook {
  throw new Error('not implemented')
}

export function executableQuotes(_book: YesBook): ExecutableQuotes {
  throw new Error('not implemented')
}

export function impliedNoPrice(_yesPriceCents: number): number {
  throw new Error('not implemented')
}
