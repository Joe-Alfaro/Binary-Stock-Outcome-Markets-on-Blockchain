import type { VersionedTransaction } from '@solana/web3.js'
import type { CloseOutContext, CloseOutPlan, RedeemContext } from './types.js'

export type RedeemErrorCode = 'NOT_SETTLED' | 'NOTHING_TO_REDEEM'

/** Thrown by the redeem builders before any transaction is built. */
export class RedeemError extends Error {
  readonly code: RedeemErrorCode

  constructor(code: RedeemErrorCode, message: string) {
    super(message)
    this.name = 'RedeemError'
    this.code = code
  }
}

/** R5: burns the wallet's Yes and No and pays the winning side, in one transaction. */
export function buildRedeem(ctx: RedeemContext): VersionedTransaction {
  void ctx
  throw new Error('not implemented')
}

/** R52: cancels the wallet's resting orders, settles funds and redeems. */
export function buildCloseOutAndRedeem(ctx: CloseOutContext): CloseOutPlan {
  void ctx
  throw new Error('not implemented')
}
