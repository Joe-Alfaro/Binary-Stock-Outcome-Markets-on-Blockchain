import type { TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import {
  TOKEN_PROGRAM,
  ata,
  cancelOrder,
  compile,
  createAccounts,
  meridian,
  pack,
  readonly,
  settleFunds,
  u64,
  writable,
} from './instructions.js'
import type { CloseOutContext, CloseOutPlan } from './types.js'

const UNIT = 1_000_000n

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
 * USDC is back in the wallet. One wallet-signed v0 transaction. Cancel works after settlement too
 * (R18), so the outcome is not checked.
 */
export function buildCancelOrder(ctx: CloseOutContext, orderId: bigint): VersionedTransaction {
  if (!ctx.restingOrders.some((o) => o.orderId === orderId)) {
    throw new UnwindError('ORDER_NOT_FOUND', `The wallet has no resting order ${orderId}.`)
  }
  return compile(ctx, [
    cancelOrder(ctx, orderId),
    ...createAccounts(ctx, ['usdcMint', 'yesMint']),
    settleFunds(ctx),
  ])
}

/**
 * R28 [G]: before settlement, cancels every resting order, settles funds and merges the Yes+No
 * pairs back to USDC. Packed in order into as few transactions as fit.
 */
export function buildCloseOutPosition(ctx: CloseOutContext): CloseOutPlan {
  if (ctx.outcome !== null) {
    throw new UnwindError('MARKET_SETTLED', 'The market has settled; redeem instead.')
  }
  const { restingOrders, seat } = ctx
  const askYes = restingOrders
    .filter((o) => o.side === 'Ask')
    .reduce((sum, o) => sum + BigInt(o.qty) * UNIT, 0n)
  // The Yes the wallet will hold once the asks are cancelled and the seat is settled.
  const yes = ctx.walletYesBaseUnits + (seat?.freeYesBaseUnits ?? 0n) + askYes
  const no = ctx.walletNoBaseUnits
  const pairs = (yes < no ? yes : no) / UNIT
  const hasSeat = seat !== null || restingOrders.length > 0
  const seatHolds = seat !== null && (seat.freeYesBaseUnits > 0n || seat.freeUsdcBaseUnits > 0n)
  if (restingOrders.length === 0 && !seatHolds && pairs === 0n) {
    throw new UnwindError(
      'NOTHING_TO_CLOSE_OUT',
      'The wallet has no orders, funds or pairs to close out in this market.',
    )
  }

  const steps = [
    ...restingOrders.map((o) => cancelOrder(ctx, o.orderId)),
    ...createAccounts(ctx, ['usdcMint', 'yesMint', 'noMint']),
  ]
  if (hasSeat) steps.push(settleFunds(ctx))
  if (pairs > 0n) steps.push(mergePair(ctx, pairs))

  const transactions = pack(ctx, steps)
  return { transactions, split: transactions.length > 1 }
}

/** Burns `n` whole Yes+No pairs for `n` USDC. */
function mergePair(ctx: CloseOutContext, n: bigint): TransactionInstruction {
  const m = ctx.market
  return meridian(
    ctx,
    'merge_pair',
    [
      readonly(ctx.owner, true),
      readonly(m.config),
      writable(m.market),
      writable(m.yesMint),
      writable(m.noMint),
      writable(m.vault),
      writable(ata(ctx.owner, m.usdcMint)),
      writable(ata(ctx.owner, m.yesMint)),
      writable(ata(ctx.owner, m.noMint)),
      readonly(TOKEN_PROGRAM),
    ],
    [u64(n)],
  )
}
