import type { AddressLookupTableAccount, PublicKey, VersionedTransaction } from '@solana/web3.js'
import type { Holdings } from '../trading/constraints.js'

/** Every account of one strike market that the trade paths touch. */
export interface MarketAccounts {
  programId: PublicKey
  config: PublicKey
  market: PublicKey
  usdcMint: PublicKey
  yesMint: PublicKey
  noMint: PublicKey
  vault: PublicKey
  book: PublicKey
  yesEscrow: PublicKey
  usdcEscrow: PublicKey
}

/** What a builder needs besides the order. Builders are pure: callers fetch balances first. */
export interface TradeContext {
  /** The wallet: the only signer and the fee payer. */
  owner: PublicKey
  market: MarketAccounts
  /** Wallet plus book holdings for this strike, in whole tokens (R28). */
  holdings: Holdings
  /**
   * The wallet's Yes balance in base units before this transaction. Passed to
   * `merge_pair_up_to` as `keep_yes`, so only the Yes the transaction added is merged.
   */
  walletYesBaseUnits: bigint
  recentBlockhash: string
  /** Optional per-market lookup tables, compiled into the v0 message when given. */
  lookupTables?: AddressLookupTableAccount[]
}

export type TradeOrderKind = 'Market' | 'Limit'

/** Buy or sell Yes at `priceCents` (the worst price for a market order). */
export interface YesOrder {
  kind: TradeOrderKind
  priceCents: number
  qty: number
}

/** Buy No at `noPriceCents`: the Yes leg is an ask at `100 − noPriceCents`. */
export interface BuyNoOrder {
  kind: TradeOrderKind
  noPriceCents: number
  qty: number
}

/** Sell No at `noPriceCents` or better: a market Yes bid at worst price `100 − noPriceCents`. */
export interface SellNoOrder {
  noPriceCents: number
  qty: number
}

export type SettledOutcome = 'Yes' | 'No'

/** What the redeem builders need. Like `TradeContext`, callers fetch balances first. */
export interface RedeemContext {
  /** The wallet: the only signer and the fee payer. */
  owner: PublicKey
  market: MarketAccounts
  /** The settled outcome, or null while the market is not settled yet. */
  outcome: SettledOutcome | null
  /** The wallet's Yes and No balances in base units before this transaction. */
  walletYesBaseUnits: bigint
  walletNoBaseUnits: bigint
  recentBlockhash: string
  /** Optional per-market lookup tables, compiled into the v0 message when given. */
  lookupTables?: AddressLookupTableAccount[]
}

/** One of the wallet's resting orders on the market's book. */
export interface RestingOrder {
  orderId: bigint
  side: 'Bid' | 'Ask'
  priceCents: number
  /** Remaining whole tokens. */
  qty: number
}

/** The wallet's seat in the book: what `settle_funds` would withdraw now, in base units. */
export interface BookSeat {
  freeYesBaseUnits: bigint
  freeUsdcBaseUnits: bigint
}

export interface CloseOutContext extends RedeemContext {
  restingOrders: RestingOrder[]
  /** Null when the wallet has no seat in the book (`settle_funds` would fail with `NoSeat`). */
  seat: BookSeat | null
}

/** The close-out transactions, to sign and send in order. */
export interface CloseOutPlan {
  transactions: VersionedTransaction[]
  /** True when the steps did not fit one transaction and were split. */
  split: boolean
}
