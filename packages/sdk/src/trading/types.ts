/** Which outcome token a price, position or trade refers to. */
export type OutcomeSide = 'Yes' | 'No'

/** The four trade paths, plus the two order-management actions R28 must never block. */
export type TradeAction = 'BuyYes' | 'SellYes' | 'BuyNo' | 'SellNo' | 'Cancel' | 'CloseOut'

/** Whether the taker of a fill bought Yes (`Bid`) or sold Yes (`Ask`). */
export type BookSide = 'Bid' | 'Ask'

/** One price level of the Yes book. Prices are whole cents (1-99); quantities are whole tokens. */
export interface BookLevel {
  priceCents: number
  qty: number
}

/** The on-chain book, which only ever holds Yes orders. */
export interface YesBook {
  bids: BookLevel[]
  asks: BookLevel[]
}

/**
 * Program events after decoding and normalization: prices in cents, quantities in whole tokens,
 * listed in chain order. `signature` is the transaction the event was emitted in.
 */
export interface OrderFilledEvent {
  kind: 'OrderFilled'
  signature: string
  ts: number
  market: string
  maker: string
  taker: string
  makerOrderId: string
  takerSide: BookSide
  priceCents: number
  qty: number
}

export interface PairMintedEvent {
  kind: 'PairMinted'
  signature: string
  ts: number
  market: string
  owner: string
  qty: number
}

export interface PairMergedEvent {
  kind: 'PairMerged'
  signature: string
  ts: number
  market: string
  owner: string
  qty: number
}

export interface RedeemedEvent {
  kind: 'Redeemed'
  signature: string
  ts: number
  market: string
  owner: string
  yesQty: number
  noQty: number
}

export interface MarketSettledEvent {
  kind: 'MarketSettled'
  signature: string
  ts: number
  market: string
  outcome: OutcomeSide
}

export type ProgramEvent =
  OrderFilledEvent | PairMintedEvent | PairMergedEvent | RedeemedEvent | MarketSettledEvent
