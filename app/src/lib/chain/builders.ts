import type { Holdings } from '@meridian/sdk'
import type { AddressLookupTableAccount, PublicKey, VersionedTransaction } from '@solana/web3.js'

/*
 * The SDK transaction builders, declared by shape. The four trade paths and the two redeem
 * builders mirror `packages/sdk/src/tx` (ARCHITECTURE.md §3.4, D53). `createSolanaChainClient` takes an implementation so the app
 * compiles and runs before those modules land; until one is passed, building rejects with a
 * `ChainError` that says trading isn't available.
 */

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

export interface TradeContext {
  owner: PublicKey
  market: MarketAccounts
  holdings: Holdings
  walletYesBaseUnits: bigint
  recentBlockhash: string
  lookupTables?: AddressLookupTableAccount[]
}

export interface YesOrder {
  kind: 'Market' | 'Limit'
  priceCents: number
  qty: number
}

export interface BuyNoOrder {
  kind: 'Market' | 'Limit'
  noPriceCents: number
  qty: number
}

export interface SellNoOrder {
  noPriceCents: number
  qty: number
}

/** What redeeming one market needs. Balances are the wallet's, before the transaction. */
export interface RedeemContext {
  owner: PublicKey
  market: MarketAccounts
  /** Null while the market is not settled. */
  outcome: 'Yes' | 'No' | null
  walletYesBaseUnits: bigint
  walletNoBaseUnits: bigint
  recentBlockhash: string
  lookupTables?: AddressLookupTableAccount[]
}

export interface RestingOrder {
  orderId: bigint
  side: 'Bid' | 'Ask'
  priceCents: number
  qty: number
}

/** What `settle_funds` would withdraw from the wallet's seat now, in base units. */
export interface BookSeat {
  freeYesBaseUnits: bigint
  freeUsdcBaseUnits: bigint
}

/** Close-out also cancels the wallet's resting orders and settles its seat. */
export interface CloseOutContext extends RedeemContext {
  restingOrders: RestingOrder[]
  seat: BookSeat | null
}

/** The close-out transactions, signed and sent in order. More than one only for many orders. */
export interface CloseOutPlan {
  transactions: VersionedTransaction[]
  split: boolean
}

export interface TradeBuilders {
  buildBuyYesTransaction(ctx: TradeContext, order: YesOrder): VersionedTransaction
  buildSellYesTransaction(ctx: TradeContext, order: YesOrder): VersionedTransaction
  buildBuyNoTransaction(ctx: TradeContext, order: BuyNoOrder): VersionedTransaction
  buildSellNoTransaction(ctx: TradeContext, order: SellNoOrder): VersionedTransaction
  buildRedeem?(ctx: RedeemContext): VersionedTransaction
  /** Cancel, `settle_funds` and `redeem`, in as few transactions as fit. */
  buildCloseOutAndRedeem?(ctx: CloseOutContext): CloseOutPlan
}
