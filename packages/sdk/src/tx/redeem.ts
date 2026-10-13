import type { TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import {
  TOKEN_PROGRAM,
  ata,
  compile,
  createAccounts,
  meridian,
  readonly,
  settleFunds,
  u64,
  writable,
} from './instructions.js'
import type { CloseOutContext, CloseOutPlan, RedeemContext } from './types.js'

/** The packet limit a serialized transaction must fit. */
const MAX_TX_BYTES = 1232
const UNIT = 1_000_000n

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

/**
 * R5: burns the wallet's Yes and No and pays the winning side, in one transaction. It creates all
 * three token accounts first, since `redeem` needs them even for a wallet holding one side (D53).
 */
export function buildRedeem(ctx: RedeemContext): VersionedTransaction {
  assertSettled(ctx)
  const { walletYesBaseUnits: yes, walletNoBaseUnits: no } = ctx
  if (yes === 0n && no === 0n) {
    throw new RedeemError('NOTHING_TO_REDEEM', 'The wallet holds no Yes or No in this market.')
  }
  return compile(ctx, [...createAllAccounts(ctx), redeem(ctx, yes, no)])
}

/**
 * R52: cancels the wallet's resting orders, settles funds and redeems. The steps are packed in
 * order into as few transactions as fit; `split` says whether it took more than one (D53).
 */
export function buildCloseOutAndRedeem(ctx: CloseOutContext): CloseOutPlan {
  assertSettled(ctx)
  const { restingOrders, seat } = ctx
  const askYes = restingOrders
    .filter((o) => o.side === 'Ask')
    .reduce((sum, o) => sum + BigInt(o.qty) * UNIT, 0n)
  const yes = ctx.walletYesBaseUnits + (seat?.freeYesBaseUnits ?? 0n) + askYes
  const no = ctx.walletNoBaseUnits
  const hasSeat = seat !== null || restingOrders.length > 0
  const seatHolds = seat !== null && (seat.freeYesBaseUnits > 0n || seat.freeUsdcBaseUnits > 0n)
  const redeems = yes > 0n || no > 0n
  if (restingOrders.length === 0 && !seatHolds && !redeems) {
    throw new RedeemError(
      'NOTHING_TO_REDEEM',
      'The wallet has no orders, funds or tokens in this market.',
    )
  }

  const steps = [
    ...restingOrders.map((o) => cancelOrder(ctx, o.orderId)),
    ...createAllAccounts(ctx),
  ]
  if (hasSeat) steps.push(settleFunds(ctx))
  if (redeems) steps.push(redeem(ctx, yes, no))

  const transactions = pack(ctx, steps)
  return { transactions, split: transactions.length > 1 }
}

function assertSettled(ctx: RedeemContext): void {
  if (ctx.outcome === null) {
    throw new RedeemError('NOT_SETTLED', 'The market has not settled yet.')
  }
}

function createAllAccounts(ctx: RedeemContext): TransactionInstruction[] {
  return createAccounts(ctx, ['usdcMint', 'yesMint', 'noMint'])
}

/** Greedy in-order packing: each transaction takes steps until the next one wouldn't fit. */
function pack(ctx: RedeemContext, steps: TransactionInstruction[]): VersionedTransaction[] {
  const transactions: VersionedTransaction[] = []
  let current: TransactionInstruction[] = []
  let built: VersionedTransaction | null = null
  for (const step of steps) {
    const candidate = fitting(ctx, [...current, step])
    if (candidate) {
      current.push(step)
      built = candidate
      continue
    }
    if (!built) throw new RangeError('one close-out step does not fit in a transaction')
    transactions.push(built)
    current = [step]
    built = fitting(ctx, current)
    if (!built) throw new RangeError('one close-out step does not fit in a transaction')
  }
  if (built) transactions.push(built)
  return transactions
}

/** The compiled transaction, or null when it exceeds the size limit. */
function fitting(ctx: RedeemContext, steps: TransactionInstruction[]): VersionedTransaction | null {
  try {
    const tx = compile(ctx, steps)
    return tx.serialize().length <= MAX_TX_BYTES ? tx : null
  } catch {
    // Too many accounts or bytes for the message encoder.
    return null
  }
}

function cancelOrder(ctx: RedeemContext, orderId: bigint): TransactionInstruction {
  const m = ctx.market
  return meridian(
    ctx,
    'cancel_order',
    [readonly(ctx.owner, true), readonly(m.market), writable(m.book)],
    [u64(orderId)],
  )
}

function redeem(ctx: RedeemContext, yes: bigint, no: bigint): TransactionInstruction {
  const m = ctx.market
  return meridian(
    ctx,
    'redeem',
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
    [u64(yes), u64(no)],
  )
}
