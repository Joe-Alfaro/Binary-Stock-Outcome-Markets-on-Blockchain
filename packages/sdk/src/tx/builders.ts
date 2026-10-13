import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import type { AccountMeta } from '@solana/web3.js'
import { assertPositionConstraint } from '../trading/index.js'
import type { BuyNoOrder, SellNoOrder, TradeContext, TradeOrderKind, YesOrder } from './types.js'

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111')

/** Enough for a full fill-cap sweep plus the other steps (D44). */
const COMPUTE_UNIT_LIMIT = 1_400_000

// Borsh enum tags of the program's `Side` and `OrderKind`.
const SIDE = { Bid: 0, Ask: 1 } as const
const KIND: Record<TradeOrderKind, number> = { Limit: 0, Market: 1 }

type Side = keyof typeof SIDE

type Method = 'mint_pair' | 'merge_pair_up_to' | 'place_order' | 'settle_funds'

/** Anchor instruction discriminators: the first 8 bytes of `sha256("global:<method>")`. */
const DISCRIMINATOR: Record<Method, Buffer> = {
  mint_pair: Buffer.from([19, 149, 94, 110, 181, 186, 33, 107]),
  merge_pair_up_to: Buffer.from([24, 95, 222, 136, 113, 222, 25, 154]),
  place_order: Buffer.from([51, 194, 155, 175, 109, 130, 96, 106]),
  settle_funds: Buffer.from([238, 64, 163, 96, 75, 171, 16, 33]),
}

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
  const message = new TransactionMessage({
    payerKey: ctx.owner,
    recentBlockhash: ctx.recentBlockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ...steps,
    ],
  }).compileToV0Message(ctx.lookupTables)
  return new VersionedTransaction(message)
}

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0]
}

type MintName = 'usdcMint' | 'yesMint' | 'noMint'

/** `CreateIdempotent` for each of the wallet's token accounts, paid by the wallet. */
function createAccounts(ctx: TradeContext, mints: MintName[]): TransactionInstruction[] {
  return mints.map((name) => {
    const mint = ctx.market[name]
    return new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        writable(ctx.owner, true),
        writable(ata(ctx.owner, mint)),
        readonly(ctx.owner),
        readonly(mint),
        readonly(SYSTEM_PROGRAM),
        readonly(TOKEN_PROGRAM),
      ],
      data: Buffer.from([1]),
    })
  })
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

function settleFunds(ctx: TradeContext): TransactionInstruction {
  const m = ctx.market
  return meridian(
    ctx,
    'settle_funds',
    [
      readonly(ctx.owner, true),
      readonly(m.market),
      writable(m.book),
      writable(m.yesEscrow),
      writable(m.usdcEscrow),
      writable(ata(ctx.owner, m.yesMint)),
      writable(ata(ctx.owner, m.usdcMint)),
      readonly(TOKEN_PROGRAM),
    ],
    [],
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

function meridian(
  ctx: TradeContext,
  method: Method,
  keys: AccountMeta[],
  args: Buffer[],
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ctx.market.programId,
    keys,
    data: Buffer.concat([DISCRIMINATOR[method], ...args]),
  })
}

function u64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

function writable(pubkey: PublicKey, isSigner = false): AccountMeta {
  return { pubkey, isSigner, isWritable: true }
}

function readonly(pubkey: PublicKey, isSigner = false): AccountMeta {
  return { pubkey, isSigner, isWritable: false }
}
