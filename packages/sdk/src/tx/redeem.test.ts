import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'
import { RedeemError, buildCloseOutAndRedeem, buildRedeem } from './index.js'
import type { CloseOutContext, MarketAccounts, RedeemContext, RestingOrder } from './index.js'

const MAX_TX_BYTES = 1232
const MAX_TX_COMPUTE_UNITS = 1_400_000
const UNIT = 1_000_000n
const PROGRAM_ID = new PublicKey('9o9a9HpN6Aq4UBeozWshAKBugjtToxWdsVzSMPkVHEMX')
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const BLOCKHASH = Keypair.generate().publicKey.toBase58()
/** Resting orders per book side on-chain (`BOOK_SIDE_CAPACITY`). */
const BOOK_SIDE_CAPACITY = 32

function newMarket(): MarketAccounts {
  const key = () => Keypair.generate().publicKey
  return {
    programId: PROGRAM_ID,
    config: key(),
    market: key(),
    usdcMint: key(),
    yesMint: key(),
    noMint: key(),
    vault: key(),
    book: key(),
    yesEscrow: key(),
    usdcEscrow: key(),
  }
}

/** A settled market (Yes won) and a wallet holding `yes` and `no` whole tokens. */
function redeemContext(
  yes: bigint,
  no: bigint,
  overrides: Partial<RedeemContext> = {},
): RedeemContext {
  return {
    owner: Keypair.generate().publicKey,
    market: newMarket(),
    outcome: 'Yes',
    walletYesBaseUnits: yes * UNIT,
    walletNoBaseUnits: no * UNIT,
    recentBlockhash: BLOCKHASH,
    ...overrides,
  }
}

function closeOutContext(overrides: Partial<CloseOutContext> = {}): CloseOutContext {
  return {
    ...redeemContext(0n, 0n),
    restingOrders: [],
    seat: null,
    ...overrides,
  }
}

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0]
}

function discriminator(name: string): Buffer {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)
}

const METHODS = ['cancel_order', 'settle_funds', 'redeem'] as const
type Method = (typeof METHODS)[number]

/** Decompiles the transaction (static keys only). */
function instructions(tx: VersionedTransaction): TransactionInstruction[] {
  const msg = tx.message
  const keys = msg.staticAccountKeys
  const keyAt = (i: number) => {
    const key = keys[i]
    assert.ok(key, `account index ${i} is in the static keys`)
    return key
  }
  return msg.compiledInstructions.map(
    (ix) =>
      new TransactionInstruction({
        programId: keyAt(ix.programIdIndex),
        keys: ix.accountKeyIndexes.map((i) => ({
          pubkey: keyAt(i),
          isSigner: msg.isAccountSigner(i),
          isWritable: msg.isAccountWritable(i),
        })),
        data: Buffer.from(ix.data),
      }),
  )
}

function methodOf(ix: TransactionInstruction): Method {
  const method = METHODS.find((m) => discriminator(m).equals(ix.data.subarray(0, 8)))
  assert.ok(method, 'a known meridian instruction')
  return method
}

function meridianCalls(tx: VersionedTransaction): TransactionInstruction[] {
  return instructions(tx).filter((ix) => ix.programId.equals(PROGRAM_ID))
}

function call(tx: VersionedTransaction, method: Method): TransactionInstruction {
  const found = meridianCalls(tx).filter((ix) => methodOf(ix) === method)
  assert.equal(found.length, 1, `exactly one ${method}`)
  const ix = found[0]
  assert.ok(ix)
  return ix
}

function u64Arg(ix: TransactionInstruction, index: number): bigint {
  return ix.data.readBigUInt64LE(8 + 8 * index)
}

function key(ix: TransactionInstruction, index: number): PublicKey {
  const meta = ix.keys[index]
  assert.ok(meta, `account ${index}`)
  return meta.pubkey
}

function isAtaCreate(ix: TransactionInstruction): boolean {
  return ix.programId.equals(ATA_PROGRAM)
}

function isComputeBudget(ix: TransactionInstruction): boolean {
  return ix.programId.equals(ComputeBudgetProgram.programId)
}

/** Mints for which the instructions create the owner's associated token account idempotently. */
function createdAtaMints(ixs: TransactionInstruction[], owner: PublicKey): string[] {
  return ixs.filter(isAtaCreate).map((ix) => {
    assert.deepEqual([...ix.data], [1], 'CreateIdempotent, never Create')
    const mint = key(ix, 3)
    assert.ok(key(ix, 0).equals(owner), 'the wallet pays')
    assert.ok(key(ix, 1).equals(ata(owner, mint)))
    assert.ok(key(ix, 2).equals(owner))
    return mint.toBase58()
  })
}

function assertCreatesAllThreeAccounts(ixs: TransactionInstruction[], ctx: RedeemContext): void {
  const m = ctx.market
  assert.deepEqual(
    [...new Set(createdAtaMints(ixs, ctx.owner))].sort(),
    [m.usdcMint, m.yesMint, m.noMint].map((k) => k.toBase58()).sort(),
    'creates the USDC, Yes and No accounts, since redeem needs all three to exist',
  )
}

/** One v0 transaction, signed only by the wallet, within 1232 bytes and the compute cap. */
function assertSingleApprovalTransaction(tx: VersionedTransaction, ctx: RedeemContext): void {
  assert.ok(tx instanceof VersionedTransaction)
  assert.equal(tx.version, 0)
  assert.equal(tx.message.header.numRequiredSignatures, 1, 'one signature')
  assert.equal(tx.signatures.length, 1)
  const payer = tx.message.staticAccountKeys[0]
  assert.ok(payer?.equals(ctx.owner), 'the wallet is the fee payer and only signer')
  assert.equal(tx.message.recentBlockhash, ctx.recentBlockhash)
  const bytes = tx.serialize().length
  assert.ok(bytes <= MAX_TX_BYTES, `transaction is ${bytes} bytes`)

  const limits = instructions(tx)
    .filter(isComputeBudget)
    .filter((ix) => ComputeBudgetInstruction.decodeInstructionType(ix) === 'SetComputeUnitLimit')
  assert.ok(limits.length <= 1, 'at most one compute unit limit')
  const limit = limits[0]
  if (limit) {
    const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit)
    assert.ok(units <= MAX_TX_COMPUTE_UNITS, `${units} compute units`)
  }
}

/** Token accounts are created before any Meridian call uses them. */
function assertAccountsCreatedFirst(ixs: TransactionInstruction[]): void {
  const lastAta = ixs.map(isAtaCreate).lastIndexOf(true)
  const firstUser = ixs.findIndex(
    (ix) => ix.programId.equals(PROGRAM_ID) && methodOf(ix) !== 'cancel_order',
  )
  assert.ok(lastAta < firstUser, 'token accounts exist before settle_funds and redeem')
}

/** `redeem` accounts: user, config, market, Yes mint, No mint, vault, user USDC/Yes/No, token program. */
function assertRedeemAccounts(ix: TransactionInstruction, ctx: RedeemContext): void {
  const m = ctx.market
  const expected = [
    ctx.owner,
    m.config,
    m.market,
    m.yesMint,
    m.noMint,
    m.vault,
    ata(ctx.owner, m.usdcMint),
    ata(ctx.owner, m.yesMint),
    ata(ctx.owner, m.noMint),
    TOKEN_PROGRAM,
  ]
  assert.deepEqual(
    ix.keys.map((k) => k.pubkey.toBase58()),
    expected.map((k) => k.toBase58()),
  )
  assert.ok(ix.keys[0]?.isSigner, 'the wallet signs')
  for (const i of [2, 3, 4, 5, 6, 7, 8]) {
    assert.ok(ix.keys[i]?.isWritable, `redeem account ${i} is writable`)
  }
}

/** `cancel_order` accounts: owner, market, book. */
function assertCancelAccounts(ix: TransactionInstruction, ctx: RedeemContext): void {
  const m = ctx.market
  assert.deepEqual(
    ix.keys.map((k) => k.pubkey.toBase58()),
    [ctx.owner, m.market, m.book].map((k) => k.toBase58()),
  )
  assert.ok(ix.keys[0]?.isSigner)
  assert.ok(ix.keys[2]?.isWritable, 'the book is writable')
}

/** `settle_funds` accounts: owner, market, book, yes_escrow, usdc_escrow, user_yes, user_usdc, token program. */
function assertSettleFundsAccounts(ix: TransactionInstruction, ctx: RedeemContext): void {
  const m = ctx.market
  const expected = [
    ctx.owner,
    m.market,
    m.book,
    m.yesEscrow,
    m.usdcEscrow,
    ata(ctx.owner, m.yesMint),
    ata(ctx.owner, m.usdcMint),
    TOKEN_PROGRAM,
  ]
  assert.deepEqual(
    ix.keys.map((k) => k.pubkey.toBase58()),
    expected.map((k) => k.toBase58()),
  )
}

function redeemAmounts(tx: VersionedTransaction) {
  const ix = call(tx, 'redeem')
  assert.equal(ix.data.length, 8 + 8 + 8)
  return { yes: u64Arg(ix, 0), no: u64Arg(ix, 1) }
}

/** `count` resting orders alternating bid and ask, with distinct ids and quantities. */
function orders(count: number): RestingOrder[] {
  return Array.from({ length: count }, (_, i) => ({
    orderId: 1_000_000_000_000n + BigInt(i * 7),
    side: i % 2 === 0 ? 'Bid' : 'Ask',
    priceCents: 40 + (i % 20),
    qty: 1 + (i % 5),
  }))
}

function askYesBaseUnits(list: RestingOrder[]): bigint {
  return list.filter((o) => o.side === 'Ask').reduce((sum, o) => sum + BigInt(o.qty) * UNIT, 0n)
}

function isRedeemError(code: RedeemError['code']) {
  return (e: unknown) => e instanceof RedeemError && e.code === code
}

describe('R5 redeem builder', () => {
  it('builds one wallet-signed transaction that creates the accounts and burns the held amounts', () => {
    const ctx = redeemContext(7n, 3n)
    const tx = buildRedeem(ctx)

    assertSingleApprovalTransaction(tx, ctx)
    assert.deepEqual(meridianCalls(tx).map(methodOf), ['redeem'])
    assertCreatesAllThreeAccounts(instructions(tx), ctx)
    assertAccountsCreatedFirst(instructions(tx))
    assert.deepEqual(redeemAmounts(tx), { yes: 7n * UNIT, no: 3n * UNIT })
    assertRedeemAccounts(call(tx, 'redeem'), ctx)
  })

  it('creates the No account for a wallet holding only Yes, and burns no No', () => {
    const ctx = redeemContext(10n, 0n)
    const tx = buildRedeem(ctx)

    assertSingleApprovalTransaction(tx, ctx)
    assert.ok(createdAtaMints(instructions(tx), ctx.owner).includes(ctx.market.noMint.toBase58()))
    assert.deepEqual(redeemAmounts(tx), { yes: 10n * UNIT, no: 0n })
  })

  it('creates the Yes account for a wallet holding only No', () => {
    const ctx = redeemContext(0n, 4n, { outcome: 'No' })
    const tx = buildRedeem(ctx)

    assertCreatesAllThreeAccounts(instructions(tx), ctx)
    assert.deepEqual(redeemAmounts(tx), { yes: 0n, no: 4n * UNIT })
  })

  it('burns losing tokens for nothing without an error', () => {
    const ctx = redeemContext(0n, 5n, { outcome: 'Yes' })
    assert.deepEqual(redeemAmounts(buildRedeem(ctx)), { yes: 0n, no: 5n * UNIT })
  })

  it('redeems a dust balance below one whole token exactly', () => {
    const ctx = redeemContext(0n, 0n, { walletYesBaseUnits: 250_000n })
    assert.deepEqual(redeemAmounts(buildRedeem(ctx)), { yes: 250_000n, no: 0n })
  })

  it(`fits ${MAX_TX_BYTES} bytes at the largest balances`, () => {
    const max = BigInt('18446744073709551615')
    const ctx = redeemContext(0n, 0n, { walletYesBaseUnits: max, walletNoBaseUnits: max })
    assertSingleApprovalTransaction(buildRedeem(ctx), ctx)
  })

  it('throws NOT_SETTLED before settlement', () => {
    const ctx = redeemContext(10n, 10n, { outcome: null })
    assert.throws(() => buildRedeem(ctx), isRedeemError('NOT_SETTLED'))
  })

  it('throws NOTHING_TO_REDEEM for a wallet holding no Yes and no No', () => {
    const ctx = redeemContext(0n, 0n)
    assert.throws(() => buildRedeem(ctx), isRedeemError('NOTHING_TO_REDEEM'))
  })
})

describe('R52 close out orders and redeem', () => {
  it('cancels every resting order, settles funds and redeems in one transaction', () => {
    const restingOrders: RestingOrder[] = [
      { orderId: 11n, side: 'Ask', priceCents: 70, qty: 2 },
      { orderId: 12n, side: 'Bid', priceCents: 30, qty: 4 },
      { orderId: 13n, side: 'Ask', priceCents: 75, qty: 3 },
    ]
    const ctx = closeOutContext({
      walletYesBaseUnits: 5n * UNIT,
      walletNoBaseUnits: 1n * UNIT,
      restingOrders,
      seat: { freeYesBaseUnits: 1n * UNIT, freeUsdcBaseUnits: 420_000n },
    })
    const plan = buildCloseOutAndRedeem(ctx)

    assert.equal(plan.transactions.length, 1)
    assert.equal(plan.split, false)
    const tx = plan.transactions[0]
    assert.ok(tx)
    assertSingleApprovalTransaction(tx, ctx)
    assert.deepEqual(meridianCalls(tx).map(methodOf), [
      'cancel_order',
      'cancel_order',
      'cancel_order',
      'settle_funds',
      'redeem',
    ])
    assertCreatesAllThreeAccounts(instructions(tx), ctx)
    assertAccountsCreatedFirst(instructions(tx))

    const cancels = meridianCalls(tx).filter((ix) => methodOf(ix) === 'cancel_order')
    assert.deepEqual(
      cancels.map((ix) => {
        assert.equal(ix.data.length, 8 + 8)
        return u64Arg(ix, 0)
      }),
      [11n, 12n, 13n],
    )
    cancels.forEach((ix) => assertCancelAccounts(ix, ctx))
    assertSettleFundsAccounts(call(tx, 'settle_funds'), ctx)
    assertRedeemAccounts(call(tx, 'redeem'), ctx)

    // Wallet Yes, the seat's free Yes and the Yes the cancelled asks release all reach the wallet.
    assert.deepEqual(redeemAmounts(tx), { yes: (5n + 1n + 2n + 3n) * UNIT, no: 1n * UNIT })
  })

  it('settles and redeems without cancelling when nothing rests', () => {
    const ctx = closeOutContext({
      walletYesBaseUnits: 2n * UNIT,
      seat: { freeYesBaseUnits: 3n * UNIT, freeUsdcBaseUnits: 0n },
    })
    const plan = buildCloseOutAndRedeem(ctx)

    assert.equal(plan.transactions.length, 1)
    assert.equal(plan.split, false)
    const tx = plan.transactions[0]
    assert.ok(tx)
    assert.deepEqual(meridianCalls(tx).map(methodOf), ['settle_funds', 'redeem'])
    assert.deepEqual(redeemAmounts(tx), { yes: 5n * UNIT, no: 0n })
  })

  it('skips settle_funds for a wallet without a seat in the book', () => {
    const ctx = closeOutContext({ walletYesBaseUnits: 2n * UNIT, seat: null })
    const tx = buildCloseOutAndRedeem(ctx).transactions[0]
    assert.ok(tx)
    assert.deepEqual(meridianCalls(tx).map(methodOf), ['redeem'])
  })

  it('cancels and settles without redeem when only USDC bids rest', () => {
    const ctx = closeOutContext({
      restingOrders: [{ orderId: 5n, side: 'Bid', priceCents: 40, qty: 2 }],
      seat: { freeYesBaseUnits: 0n, freeUsdcBaseUnits: 0n },
    })
    const tx = buildCloseOutAndRedeem(ctx).transactions[0]
    assert.ok(tx)
    assertSingleApprovalTransaction(tx, ctx)
    assert.deepEqual(meridianCalls(tx).map(methodOf), ['cancel_order', 'settle_funds'])
  })

  it('splits a full book of orders into the fewest transactions and says so', () => {
    const restingOrders = orders(2 * BOOK_SIDE_CAPACITY)
    const ctx = closeOutContext({
      walletYesBaseUnits: 4n * UNIT,
      walletNoBaseUnits: 2n * UNIT,
      restingOrders,
      seat: { freeYesBaseUnits: 1n * UNIT, freeUsdcBaseUnits: 0n },
    })
    const plan = buildCloseOutAndRedeem(ctx)

    assert.equal(plan.split, true)
    assert.ok(plan.transactions.length > 1, 'too many orders for one transaction')
    plan.transactions.forEach((tx) => assertSingleApprovalTransaction(tx, ctx))

    // Together, the transactions run every step once, in order.
    const all = plan.transactions.flatMap(instructions)
    const calls = all.filter((ix) => ix.programId.equals(PROGRAM_ID))
    assert.deepEqual(calls.map(methodOf), [
      ...restingOrders.map(() => 'cancel_order'),
      'settle_funds',
      'redeem',
    ])
    assert.deepEqual(
      calls.filter((ix) => methodOf(ix) === 'cancel_order').map((ix) => u64Arg(ix, 0)),
      restingOrders.map((o) => o.orderId),
    )
    assertCreatesAllThreeAccounts(all, ctx)
    assertAccountsCreatedFirst(all)
    const last = plan.transactions.at(-1)
    assert.ok(last)
    assert.deepEqual(redeemAmounts(last), {
      yes: (4n + 1n) * UNIT + askYesBaseUnits(restingOrders),
      no: 2n * UNIT,
    })

    // Fewest: no transaction could also have taken the next transaction's first step.
    plan.transactions.slice(0, -1).forEach((tx, i) => {
      const next = plan.transactions[i + 1]
      assert.ok(next)
      const nextStep = instructions(next).find((ix) => !isComputeBudget(ix))
      assert.ok(nextStep)
      const merged = new VersionedTransaction(
        new TransactionMessage({
          payerKey: ctx.owner,
          recentBlockhash: ctx.recentBlockhash,
          instructions: [...instructions(tx), nextStep],
        }).compileToV0Message(),
      )
      assert.ok(
        merged.serialize().length > MAX_TX_BYTES,
        `transaction ${i} had room for the next step`,
      )
    })
  })

  it('splits deterministically: the same input gives the same transactions', () => {
    const ctx = closeOutContext({
      walletYesBaseUnits: 1n * UNIT,
      restingOrders: orders(2 * BOOK_SIDE_CAPACITY),
      seat: { freeYesBaseUnits: 0n, freeUsdcBaseUnits: 0n },
    })
    const first = buildCloseOutAndRedeem(ctx).transactions.map((tx) => [...tx.serialize()])
    const second = buildCloseOutAndRedeem(ctx).transactions.map((tx) => [...tx.serialize()])
    assert.deepEqual(first, second)
  })

  it('throws NOT_SETTLED before settlement, even with orders to cancel', () => {
    const ctx = closeOutContext({
      outcome: null,
      walletYesBaseUnits: 3n * UNIT,
      restingOrders: orders(2),
      seat: { freeYesBaseUnits: 0n, freeUsdcBaseUnits: 0n },
    })
    assert.throws(() => buildCloseOutAndRedeem(ctx), isRedeemError('NOT_SETTLED'))
  })

  it('throws NOTHING_TO_REDEEM for a wallet with no tokens, no orders and no seat', () => {
    assert.throws(
      () => buildCloseOutAndRedeem(closeOutContext()),
      isRedeemError('NOTHING_TO_REDEEM'),
    )
  })
})
