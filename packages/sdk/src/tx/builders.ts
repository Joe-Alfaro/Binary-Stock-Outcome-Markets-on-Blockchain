/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import type { VersionedTransaction } from '@solana/web3.js'
import type { BuyNoOrder, SellNoOrder, TradeContext, YesOrder } from './types.js'

/**
 * The four trade paths (ARCHITECTURE.md §3.4), each one v0 transaction signed only by the wallet,
 * with idempotent associated-token-account creation for a fresh wallet. Each throws
 * `PositionConstraintError` when R28 blocks the trade and `RangeError` for an invalid order.
 */
export function buildBuyYesTransaction(_ctx: TradeContext, _order: YesOrder): VersionedTransaction {
  throw new Error('not implemented')
}

export function buildSellYesTransaction(
  _ctx: TradeContext,
  _order: YesOrder,
): VersionedTransaction {
  throw new Error('not implemented')
}

export function buildBuyNoTransaction(
  _ctx: TradeContext,
  _order: BuyNoOrder,
): VersionedTransaction {
  throw new Error('not implemented')
}

export function buildSellNoTransaction(
  _ctx: TradeContext,
  _order: SellNoOrder,
): VersionedTransaction {
  throw new Error('not implemented')
}
