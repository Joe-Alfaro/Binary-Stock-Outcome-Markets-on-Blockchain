/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import type { OutcomeSide, ProgramEvent } from './types.js'

export interface PortfolioOptions {
  wallet: string
  /** Current Yes mark in cents per market; the No mark is `100 −` it. Settled markets use the outcome. */
  yesMarks: ReadonlyMap<string, number>
}

/** One side of one market. Closed positions stay listed with qty 0 so realized P&L remains visible. */
export interface Position {
  market: string
  side: OutcomeSide
  qty: number
  avgEntryCents: number
  markCents: number
  currentValueCents: number
  realizedPnlCents: number
  unrealizedPnlCents: number
}

/** A trade in outcome-token terms, with No trades priced net of the mint or merge. */
export interface Trade {
  market: string
  signature: string
  side: OutcomeSide
  action: 'Buy' | 'Sell'
  qty: number
  priceCents: number
  /** True when the wallet was the resting order, so the fill sits in someone else's transaction. */
  maker: boolean
}

export interface Portfolio {
  positions: Position[]
  trades: Trade[]
}

/** Net exposure per strike for the market-maker view. */
export interface MarketExposure {
  market: string
  yes: number
  no: number
  /** `yes − no`: positive is long Yes, negative is long No. */
  netYes: number
  fills: number
  makerFills: number
  realizedPnlCents: number
  unrealizedPnlCents: number
}

export function computePortfolio(
  _events: readonly ProgramEvent[],
  _options: PortfolioOptions,
): Portfolio {
  throw new Error('not implemented')
}

export function marketMakerSummary(
  _events: readonly ProgramEvent[],
  _options: PortfolioOptions,
): MarketExposure[] {
  throw new Error('not implemented')
}
