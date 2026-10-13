import { ComputeBudgetProgram, PublicKey } from '@solana/web3.js'
import type { TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { assertPositionConstraint } from '../trading/index.js'
import {
  TOKEN_PROGRAM,
  ata,
  compile as compileMessage,
  createAccounts,
  meridian,
  readonly,
  settleFunds,
  u64,
  writable,
} from './instructions.js'
import type { BuyNoOrder, SellNoOrder, TradeContext, TradeOrderKind, YesOrder } from './types.js'

/** Enough for a full fill-cap sweep plus the other steps (D44). */
const COMPUTE_UNIT_LIMIT = 1_400_000

// Borsh enum tags of the program's `Side` and `OrderKind`.
const SIDE = { Bid: 0, Ask: 1 } as const
const KIND: Record<TradeOrderKind, number> = { Limit: 0, Market: 1 }

type Side = keyof typeof SIDE

/**
 * The four trade paths (ARCHITECTURE.md §3.4), each one v0 transaction signed only by the wallet,
 * with idempotent associated-token-account creation for a fresh wallet. Each throws
 * `PositionConstraintError` when R28 blocks the trade and `RangeError` for an invalid order.
 */
export function buildBuyYesTransaction(ctx: TradeContext, order: YesOrder): VersionedTransaction {
  validate(order.priceCents, order.qty)
  assertPositionConstraint('BuyYes', ctx.holdings)
  return compile(ctx, [
    ...createAccounts(ctx, ['usdcMint', 'yesMint']),
    placeOrder(ctx, 'Bid', order.kind, order.priceCents, order.qty),
    settleFunds(ctx),
  ])
}

export function buildSellYesTransaction(ctx: TradeContext, order: YesOrder): VersionedTransaction {
  validate(order.priceCents, order.qty)
  return compile(ctx, [
    ...createAccounts(ctx, ['usdcMint', 'yesMint']),
    placeOrder(ctx, 'Ask', order.kind, order.priceCents, order.qty),
    settleFunds(ctx),
  ])
}

/**
 * Mint pairs, sell the Yes at `100 − noPriceCents`, settle. A market order then merges back
 * whatever didn't fill (R25); a limit order keeps both tokens until the ask fills.
 */
export function buildBuyNoTransaction(ctx: TradeContext, order: BuyNoOrder): VersionedTransaction {
  validate(order.noPriceCents, order.qty)
  assertPositionConstraint('BuyNo', ctx.holdings)
  const steps = [
    ...createAccounts(ctx, ['usdcMint', 'yesMint', 'noMint']),
    collateral(ctx, 'mint_pair', [u64(order.qty)]),
    placeOrder(ctx, 'Ask', order.kind, 100 - order.noPriceCents, order.qty),
    settleFunds(ctx),
  ]
  if (order.kind === 'Market') {
    steps.push(mergeUpTo(ctx, order.qty))
  }
  return compile(ctx, steps)
}

/** Buy Yes at market with worst price `100 − noPriceCents`, settle, then merge what filled (R26). */
export function buildSellNoTransaction(
  ctx: TradeContext,
  order: SellNoOrder,
): VersionedTransaction {
  validate(order.noPriceCents, order.qty)
  return compile(ctx, [
    ...createAccounts(ctx, ['usdcMint', 'yesMint', 'noMint']),
    placeOrder(ctx, 'Bid', 'Market', 100 - order.noPriceCents, order.qty),
    settleFunds(ctx),
    mergeUpTo(ctx, order.qty),
  ])
}

function validate(priceCents: number, qty: number): void {
  if (!Number.isInteger(priceCents) || priceCents < 1 || priceCents > 99) {
    throw new RangeError(`price must be a whole number of cents from 1 to 99, got ${priceCents}`)
  }
  if (!Number.isSafeInteger(qty) || qty < 1) {
    throw new RangeError(`quantity must be a positive whole number, got ${qty}`)
  }
}

function compile(ctx: TradeContext, steps: TransactionInstruction[]): VersionedTransaction {
  return compileMessage(ctx, [
    ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
    ...steps,
  ])
}

function placeOrder(
  ctx: TradeContext,
  side: Side,
  kind: TradeOrderKind,
  priceCents: number,
  qty: number,
): TransactionInstruction {
  const m = ctx.market
  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    m.programId,
  )[0]
  return meridian(
    ctx,
    'place_order',
    [
      writable(ctx.owner, true),
      readonly(m.config),
      readonly(m.market),
      writable(m.book),
      writable(m.yesEscrow),
      writable(m.usdcEscrow),
      writable(ata(ctx.owner, m.usdcMint)),
      writable(ata(ctx.owner, m.yesMint)),
      readonly(TOKEN_PROGRAM),
      readonly(eventAuthority),
      readonly(m.programId),
    ],
    [Buffer.from([SIDE[side], KIND[kind], priceCents]), u64(qty)],
  )
}

/** Merges up to `maxN` pairs, keeping the Yes the wallet held before this transaction (D18). */
function mergeUpTo(ctx: TradeContext, maxN: number): TransactionInstruction {
  return collateral(ctx, 'merge_pair_up_to', [u64(maxN), u64(ctx.walletYesBaseUnits)])
}

function collateral(
  ctx: TradeContext,
  method: 'mint_pair' | 'merge_pair_up_to',
  args: Buffer[],
): TransactionInstruction {
  const m = ctx.market
  return meridian(
    ctx,
    method,
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
    args,
  )
}
