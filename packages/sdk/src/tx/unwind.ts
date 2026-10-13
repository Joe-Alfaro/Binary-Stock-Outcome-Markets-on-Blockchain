import type { VersionedTransaction } from '@solana/web3.js'
import type { CloseOutContext, CloseOutPlan } from './types.js'

export type UnwindErrorCode = 'ORDER_NOT_FOUND' | 'MARKET_SETTLED' | 'NOTHING_TO_CLOSE_OUT'

/** Thrown by the unwind builders before any transaction is built. */
export class UnwindError extends Error {
  readonly code: UnwindErrorCode

  constructor(code: UnwindErrorCode, message: string) {
    super(message)
    this.name = 'UnwindError'
    this.code = code
  }
}

/**
 * R28 [G]: cancels one of the wallet's resting orders and settles funds, so the escrowed Yes or
 * USDC is back in the wallet. One wallet-signed v0 transaction.
 */
export function buildCancelOrder(ctx: CloseOutContext, orderId: bigint): VersionedTransaction {
  void ctx
  void orderId
  throw new Error('buildCancelOrder is not implemented')
}

/**
 * R28 [G]: before settlement, cancels every resting order, settles funds and merges the Yes+No
 * pairs back to USDC. Packed in order into as few transactions as fit.
 */
export function buildCloseOutPosition(ctx: CloseOutContext): CloseOutPlan {
  void ctx
  throw new Error('buildCloseOutPosition is not implemented')
}
