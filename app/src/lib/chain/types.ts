import type { Holdings, OutcomeSide, ProgramEvent, TradeAction, YesBook } from '@meridian/sdk'

export const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'] as const
export type Ticker = (typeof TICKERS)[number]

/** Solana commitment levels the app can confirm at. The app always uses `confirmed` (R55). */
export type Commitment = 'processed' | 'confirmed' | 'finalized'

export type Unsubscribe = () => void

/** One on-chain latest-price account (display only, never a settlement input). */
export interface LatestPrice {
  ticker: Ticker
  /** Price in dollars. */
  price: number
  /** Publish time, Unix seconds. */
  publishTs: number
}

export type MarketStatus = 'Open' | 'Closed' | 'Settled'
export type SettlementSource = 'Oracle' | 'Admin'

export interface Settlement {
  /** Settlement price in dollars. */
  price: number
  source: SettlementSource
  outcome: OutcomeSide
}

/** One contract (one strike of one ticker-day). `market` is the market account address. */
export interface ContractSummary {
  market: string
  ticker: Ticker
  /** Strike in dollars. */
  strike: number
  /** Unix seconds. */
  closeTs: number
  status: MarketStatus
  /** Created in demo mode (R44). */
  demo: boolean
  /** Reference Yes price in cents; the implied No price is `100 −` it. `null` when there is none. */
  yesPriceCents: number | null
  settlement: Settlement | null
}

export type TradePath = Exclude<TradeAction, 'Cancel' | 'CloseOut'>
export type OrderType = 'Market' | 'Limit'

/**
 * What the trade panel asks for. `priceCents` is in the terms of the side being traded (a No price
 * for No actions): the limit price for a limit order, or the executable quote, used as the worst
 * price, for a market order.
 */
export interface TradeIntent {
  market: string
  owner: string
  action: TradePath
  orderType: OrderType
  qty: number
  priceCents: number
}

export interface MarketOwner {
  market: string
  owner: string
}

/** One of the wallet's resting orders, in Yes-book terms. A resting Buy No limit is an `Ask`. */
export interface OpenOrder {
  /** The on-chain order id, as a decimal string. */
  orderId: string
  side: 'Bid' | 'Ask'
  priceCents: number
  /** Remaining whole tokens. */
  qty: number
}

export interface CancelOrderRequest extends MarketOwner {
  orderId: string
}

/** A built transaction waiting for the wallet. Opaque to the UI. */
export interface UnsignedTx {
  readonly raw: unknown
}

/** A transaction the wallet signed. Opaque to the UI. */
export interface SignedTx {
  readonly raw: unknown
}

export interface Confirmation {
  signature: string
}

/**
 * Everything the app reads from or sends to the chain. Methods reject with `ChainError` for the
 * failures the UI explains (R54). The Solana implementation lives in `solana.ts`; tests use a fake.
 */
export interface ChainClient {
  readonly commitment: Commitment
  getLatestPrices(): Promise<LatestPrice[]>
  subscribeLatestPrices(onPrice: (price: LatestPrice) => void): Unsubscribe
  /** The ticker's current contracts, or every current contract when `ticker` is omitted. */
  listMarkets(ticker?: Ticker): Promise<ContractSummary[]>
  getBook(market: string): Promise<YesBook>
  /** Account subscription on the book; `onError` fires when the websocket fails (R22). */
  subscribeBook(
    market: string,
    onBook: (book: YesBook) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe
  getUsdcBalance(owner: string): Promise<number>
  /** Yes and No for one strike, wallet balance plus anything escrowed in the book. */
  getHoldings(owner: string, market: string): Promise<Holdings>
  /** Decoded program events that involve `owner`, in chain order, plus `MarketSettled` events. */
  getEvents(owner: string): Promise<ProgramEvent[]>
  buildTrade(intent: TradeIntent): Promise<UnsignedTx>
  buildRedeem(request: MarketOwner): Promise<UnsignedTx>
  /**
   * Cancels resting orders, settles funds and redeems: one transaction, or several in order when
   * the wallet has more orders than one transaction fits.
   */
  buildCloseOutAndRedeem(request: MarketOwner): Promise<UnsignedTx[]>
  /** The wallet's resting orders on one market's book (R28 [G]). */
  getOpenOrders(owner: string, market: string): Promise<OpenOrder[]>
  /** Cancels one resting order and settles funds back to the wallet: one transaction (R28 [G]). */
  buildCancelOrder(request: CancelOrderRequest): Promise<UnsignedTx>
  /**
   * Before settlement: cancels the wallet's resting orders, settles funds and merges its Yes+No
   * pairs back to USDC. Several transactions in order only when the orders don't fit one (R28 [G]).
   */
  buildCloseOutPosition(request: MarketOwner): Promise<UnsignedTx[]>
  sendAndConfirm(tx: SignedTx, commitment: Commitment): Promise<Confirmation>
}

export interface WalletOption {
  name: string
}

/** The connected wallet, adapted from the Solana wallet adapter. Each `signTransaction` is one prompt. */
export interface WalletPort {
  readonly wallets: readonly WalletOption[]
  getPublicKey(): string | null
  subscribe(listener: () => void): Unsubscribe
  connect(walletName: string): Promise<void>
  disconnect(): Promise<void>
  signTransaction(tx: UnsignedTx): Promise<SignedTx>
}
