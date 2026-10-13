import type { TradeAction } from './types.js'

export type PositionConstraintCode = 'HOLDS_NO' | 'HOLDS_YES'

/** Thrown by the SDK builders, and shown by the UI, when a trade would mix Yes and No. */
export class PositionConstraintError extends Error {
  readonly code: PositionConstraintCode
  readonly exitAction: 'SellNo' | 'SellYes'

  constructor(code: PositionConstraintCode, exitAction: 'SellNo' | 'SellYes', message: string) {
    super(message)
    this.name = 'PositionConstraintError'
    this.code = code
    this.exitAction = exitAction
  }
}

/** Total holdings for one strike: wallet balance plus anything escrowed in the book. */
export interface Holdings {
  yes: number
  no: number
}

export type ConstraintResult =
  { allowed: true } | { allowed: false; error: PositionConstraintError }

/**
 * Only buying the opposite side is blocked. Sells, `Cancel` and `CloseOut` always pass, so a wallet
 * holding both tokens through a resting Buy No limit can still unwind.
 */
export function checkPositionConstraint(action: TradeAction, holdings: Holdings): ConstraintResult {
  if (action === 'BuyYes' && holdings.no > 0) {
    return {
      allowed: false,
      error: new PositionConstraintError(
        'HOLDS_NO',
        'SellNo',
        'You hold No for this strike. Sell No before buying Yes.',
      ),
    }
  }
  if (action === 'BuyNo' && holdings.yes > 0) {
    return {
      allowed: false,
      error: new PositionConstraintError(
        'HOLDS_YES',
        'SellYes',
        'You hold Yes for this strike. Sell Yes before buying No.',
      ),
    }
  }
  return { allowed: true }
}

export function assertPositionConstraint(action: TradeAction, holdings: Holdings): void {
  const result = checkPositionConstraint(action, holdings)
  if (!result.allowed) throw result.error
}
