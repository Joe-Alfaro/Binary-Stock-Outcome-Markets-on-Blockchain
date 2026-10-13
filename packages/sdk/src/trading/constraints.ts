/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
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

export function checkPositionConstraint(
  _action: TradeAction,
  _holdings: Holdings,
): ConstraintResult {
  throw new Error('not implemented')
}

export function assertPositionConstraint(_action: TradeAction, _holdings: Holdings): void {
  throw new Error('not implemented')
}
