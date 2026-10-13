import type { Holdings } from '@meridian/sdk'
import type { AddressLookupTableAccount, PublicKey, VersionedTransaction } from '@solana/web3.js'

/*
 * The SDK transaction builders, declared by shape. The four trade paths mirror
 * `packages/sdk/src/tx` (ARCHITECTURE.md §3.4); the redeem builders are what the portfolio needs
 * from the settlement builders. `createSolanaChainClient` takes an implementation so the app
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

/** What redeeming one market needs: balances to burn and resting orders to cancel first. */
export interface RedeemContext {
  owner: PublicKey
  market: MarketAccounts
  yesBaseUnits: bigint
  noBaseUnits: bigint
  /** The owner's resting order IDs, cancelled before `settle_funds` by close-out-and-redeem. */
  restingOrderIds: bigint[]
  recentBlockhash: string
}

export interface TradeBuilders {
  buildBuyYesTransaction(ctx: TradeContext, order: YesOrder): VersionedTransaction
  buildSellYesTransaction(ctx: TradeContext, order: YesOrder): VersionedTransaction
  buildBuyNoTransaction(ctx: TradeContext, order: BuyNoOrder): VersionedTransaction
  buildSellNoTransaction(ctx: TradeContext, order: SellNoOrder): VersionedTransaction
  buildRedeemTransaction?(ctx: RedeemContext): VersionedTransaction
  /** Cancel, `settle_funds` and `redeem` in one transaction. */
  buildCloseOutAndRedeemTransaction?(ctx: RedeemContext): VersionedTransaction
}
