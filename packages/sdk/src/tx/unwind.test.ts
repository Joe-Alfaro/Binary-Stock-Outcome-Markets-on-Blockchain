import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import type { VersionedTransaction } from '@solana/web3.js'
import { UnwindError, buildCancelOrder, buildCloseOutPosition } from './index.js'
import type { BookSeat, CloseOutContext, MarketAccounts, RestingOrder } from './index.js'

/**
 * R28 [G]: a wallet holding Yes and No because of a resting Buy No limit (the Yes leg rests as an
 * ask) can cancel and close out before settlement: cancel, `settle_funds`, then `merge_pair`.
 */

const MAX_TX_BYTES = 1232
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

const EMPTY_SEAT: BookSeat = { freeYesBaseUnits: 0n, freeUsdcBaseUnits: 0n }

function ask(orderId: bigint, qty: number, priceCents = 60): RestingOrder {
  return { orderId, side: 'Ask', priceCents, qty }
}

function bid(orderId: bigint, qty: number, priceCents = 40): RestingOrder {
  return { orderId, side: 'Bid', priceCents, qty }
}

/**
 * An open market and the wallet after a resting Buy No limit of `qty` at 40¢: it minted `qty`
 * pairs, holds the No, and its Yes rests in the book as an ask at 60¢.
 */
function restingBuyNo(qty = 5, overrides: Partial<CloseOutContext> = {}): CloseOutContext {
  return {
    owner: Keypair.generate().publicKey,
    market: newMarket(),
    outcome: null,
    walletYesBaseUnits: 0n,
    walletNoBaseUnits: BigInt(qty) * UNIT,
    restingOrders: [ask(7n, qty)],
    seat: EMPTY_SEAT,
    recentBlockhash: BLOCKHASH,
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

const METHODS = [
  'cancel_order',
  'settle_funds',
  'merge_pair',
  'merge_pair_up_to',
  'mint_pair',
  'place_order',
  'redeem',
] as const
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

function methods(tx: VersionedTransaction): Method[] {
  return meridianCalls(tx).map(methodOf)
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

/** The token accounts the transaction creates idempotently, in order. */
function createdAccounts(tx: VersionedTransaction): PublicKey[] {
  return instructions(tx)
    .filter((ix) => ix.programId.equals(ATA_PROGRAM))
    .map((ix) => {
      assert.deepEqual([...ix.data], [1], 'CreateIdempotent')
      return key(ix, 1)
    })
}

function indexOf(tx: VersionedTransaction, predicate: (ix: TransactionInstruction) => boolean) {
  return instructions(tx).findIndex(predicate)
}

/** Index of the last associated-token-account creation. */
function lastCreateIndex(tx: VersionedTransaction): number {
  return instructions(tx).reduce((last, ix, i) => (ix.programId.equals(ATA_PROGRAM) ? i : last), -1)
}

function isMethod(method: Method) {
  return (ix: TransactionInstruction) => ix.programId.equals(PROGRAM_ID) && methodOf(ix) === method
}

/** One wallet signature, the wallet pays, a v0 message, and it fits the packet limit. */
function assertOneSignatureV0(tx: VersionedTransaction, owner: PublicKey) {
  assert.equal(tx.version, 0, 'a v0 transaction')
  assert.equal(tx.message.header.numRequiredSignatures, 1, 'exactly one signature')
  assert.ok(tx.message.staticAccountKeys[0]?.equals(owner), 'the wallet is the fee payer')
  assert.ok(
    tx.serialize().length <= MAX_TX_BYTES,
    `${tx.serialize().length} bytes is over ${MAX_TX_BYTES}`,
  )
}

function only<T>(items: T[]): T {
  assert.equal(items.length, 1, 'exactly one transaction')
  const item = items[0]
  assert.ok(item)
  return item
}

describe('R28 [G] buildCloseOutPosition: close out a resting Buy No before settlement', () => {
  it('is one wallet-signed v0 transaction within 1232 bytes', () => {
    const ctx = restingBuyNo()
    const plan = buildCloseOutPosition(ctx)
    assert.equal(plan.split, false)
    assertOneSignatureV0(only(plan.transactions), ctx.owner)
  })

  it('cancels the resting order, settles funds, then merges the pairs back to USDC, in that order', () => {
    const ctx = restingBuyNo(5)
    const tx = only(buildCloseOutPosition(ctx).transactions)
    assert.deepEqual(methods(tx), ['cancel_order', 'settle_funds', 'merge_pair'])
  })

  it('cancels the order by its id, signed by the wallet, on the market book', () => {
    const ctx = restingBuyNo(5)
    const ix = call(only(buildCloseOutPosition(ctx).transactions), 'cancel_order')
    assert.equal(u64Arg(ix, 0), 7n)
    assert.ok(key(ix, 0).equals(ctx.owner))
    assert.equal(ix.keys[0]?.isSigner, true)
    assert.ok(key(ix, 1).equals(ctx.market.market))
    assert.ok(key(ix, 2).equals(ctx.market.book))
    assert.equal(ix.keys[2]?.isWritable, true)
  })

  it('settles funds into the wallet Yes and USDC accounts', () => {
    const ctx = restingBuyNo(5)
    const ix = call(only(buildCloseOutPosition(ctx).transactions), 'settle_funds')
    const m = ctx.market
    assert.ok(key(ix, 0).equals(ctx.owner))
    assert.ok(key(ix, 2).equals(m.book))
    assert.ok(key(ix, 3).equals(m.yesEscrow))
    assert.ok(key(ix, 4).equals(m.usdcEscrow))
    assert.ok(key(ix, 5).equals(ata(ctx.owner, m.yesMint)))
    assert.ok(key(ix, 6).equals(ata(ctx.owner, m.usdcMint)))
  })

  it('merges every pair the wallet will hold: the returned Yes against its No', () => {
    const ctx = restingBuyNo(5)
    const ix = call(only(buildCloseOutPosition(ctx).transactions), 'merge_pair')
    const m = ctx.market
    assert.equal(u64Arg(ix, 0), 5n, 'merge_pair takes whole pairs')
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
    expected.forEach((pubkey, i) => assert.ok(key(ix, i).equals(pubkey), `merge account ${i}`))
    assert.equal(ix.keys[0]?.isSigner, true)
  })

  it('creates the wallet USDC, Yes and No accounts idempotently before settling', () => {
    const ctx = restingBuyNo(5)
    const tx = only(buildCloseOutPosition(ctx).transactions)
    const m = ctx.market
    const created = createdAccounts(tx)
    ;[m.usdcMint, m.yesMint, m.noMint].forEach((mint) =>
      assert.ok(
        created.some((a) => a.equals(ata(ctx.owner, mint))),
        `creates the ${mint.toBase58()} account`,
      ),
    )
    const lastCreate = lastCreateIndex(tx)
    assert.ok(lastCreate < indexOf(tx, isMethod('settle_funds')), 'accounts exist before settle')
  })

  it('after a partial fill merges only the Yes that comes back and leaves the extra No', () => {
    // 2 of the 5 Yes sold at 60¢: 3 still rest, and the seat holds $1.20 from the fill.
    const ctx = restingBuyNo(5, {
      restingOrders: [ask(7n, 3)],
      seat: { freeYesBaseUnits: 0n, freeUsdcBaseUnits: 1_200_000n },
    })
    const tx = only(buildCloseOutPosition(ctx).transactions)
    assert.deepEqual(methods(tx), ['cancel_order', 'settle_funds', 'merge_pair'])
    assert.equal(u64Arg(call(tx, 'merge_pair'), 0), 3n)
  })

  it('counts Yes already in the wallet and free in the seat toward the pairs it merges', () => {
    const ctx = restingBuyNo(5, {
      walletYesBaseUnits: 1n * UNIT,
      restingOrders: [ask(7n, 2)],
      seat: { freeYesBaseUnits: 1n * UNIT, freeUsdcBaseUnits: 0n },
    })
    const tx = only(buildCloseOutPosition(ctx).transactions)
    assert.equal(u64Arg(call(tx, 'merge_pair'), 0), 4n, '1 wallet + 1 seat + 2 escrowed Yes')
  })

  it('merges only whole pairs', () => {
    const ctx = restingBuyNo(5, { walletNoBaseUnits: 2n * UNIT + UNIT / 2n })
    assert.equal(u64Arg(call(only(buildCloseOutPosition(ctx).transactions), 'merge_pair'), 0), 2n)
  })

  it('cancels a resting bid too, and skips the merge when no pair can form', () => {
    const ctx = restingBuyNo(5, {
      walletNoBaseUnits: 0n,
      restingOrders: [ask(7n, 5), bid(8n, 4)],
    })
    const tx = only(buildCloseOutPosition(ctx).transactions)
    assert.deepEqual(methods(tx), ['cancel_order', 'cancel_order', 'settle_funds'])
    const cancelled = meridianCalls(tx)
      .filter((ix) => methodOf(ix) === 'cancel_order')
      .map((ix) => u64Arg(ix, 0))
    assert.deepEqual(cancelled, [7n, 8n])
  })

  it('merges pairs already in the wallet when nothing rests and the seat is empty', () => {
    const ctx = restingBuyNo(5, {
      walletYesBaseUnits: 5n * UNIT,
      restingOrders: [],
      seat: null,
    })
    const tx = only(buildCloseOutPosition(ctx).transactions)
    assert.deepEqual(methods(tx), ['merge_pair'], 'no seat, so no settle_funds')
    assert.equal(u64Arg(call(tx, 'merge_pair'), 0), 5n)
  })

  it('never mints, places an order or redeems', () => {
    const tx = only(buildCloseOutPosition(restingBuyNo()).transactions)
    methods(tx).forEach((m) =>
      assert.ok(['cancel_order', 'settle_funds', 'merge_pair'].includes(m), `unexpected ${m}`),
    )
  })

  it('splits deterministically when a full book side of orders does not fit one transaction', () => {
    const orders = Array.from({ length: BOOK_SIDE_CAPACITY }, (_, i) => ask(BigInt(100 + i), 1))
    const ctx = restingBuyNo(BOOK_SIDE_CAPACITY, { restingOrders: orders })
    const plan = buildCloseOutPosition(ctx)
    assert.equal(plan.split, true)
    assert.ok(plan.transactions.length > 1)
    plan.transactions.forEach((tx) => assertOneSignatureV0(tx, ctx.owner))

    const all = plan.transactions.flatMap((tx) => meridianCalls(tx))
    const cancelled = all.filter((ix) => methodOf(ix) === 'cancel_order').map((ix) => u64Arg(ix, 0))
    assert.deepEqual(
      cancelled,
      orders.map((o) => o.orderId),
      'every order cancelled once, in order',
    )
    const last = plan.transactions.at(-1)
    assert.ok(last)
    const lastMethods = methods(last)
    assert.deepEqual(lastMethods.slice(-2), ['settle_funds', 'merge_pair'])
    assert.equal(u64Arg(call(last, 'merge_pair'), 0), BigInt(BOOK_SIDE_CAPACITY))
    plan.transactions.slice(0, -1).forEach((tx) =>
      assert.ok(
        methods(tx).every((m) => m === 'cancel_order'),
        'earlier parts only cancel',
      ),
    )

    const again = buildCloseOutPosition(ctx)
    assert.deepEqual(
      again.transactions.map((tx) => Buffer.from(tx.message.serialize()).toString('hex')),
      plan.transactions.map((tx) => Buffer.from(tx.message.serialize()).toString('hex')),
      'the same context builds the same split',
    )
  })

  it('throws UnwindError MARKET_SETTLED on a settled market, where close-out redeems instead', () => {
    assert.throws(
      () => buildCloseOutPosition(restingBuyNo(5, { outcome: 'No' })),
      (error: unknown) => error instanceof UnwindError && error.code === 'MARKET_SETTLED',
    )
  })

  it('throws UnwindError NOTHING_TO_CLOSE_OUT with no orders, no seat funds and no pairs', () => {
    const nothing = restingBuyNo(5, { walletNoBaseUnits: 0n, restingOrders: [], seat: null })
    assert.throws(
      () => buildCloseOutPosition(nothing),
      (error: unknown) => error instanceof UnwindError && error.code === 'NOTHING_TO_CLOSE_OUT',
    )
    const onlyNo = restingBuyNo(5, { restingOrders: [], seat: EMPTY_SEAT })
    assert.throws(
      () => buildCloseOutPosition(onlyNo),
      (error: unknown) => error instanceof UnwindError && error.code === 'NOTHING_TO_CLOSE_OUT',
      'only No and an empty seat: nothing to cancel, settle or merge',
    )
  })
})

describe('R28 [G] buildCancelOrder: cancel one resting order and settle funds', () => {
  it('is one wallet-signed v0 transaction within 1232 bytes', () => {
    const ctx = restingBuyNo()
    assertOneSignatureV0(buildCancelOrder(ctx, 7n), ctx.owner)
  })

  it('cancels only the chosen order, then settles funds, and merges nothing', () => {
    const ctx = restingBuyNo(5, { restingOrders: [ask(7n, 5), bid(8n, 2)] })
    const tx = buildCancelOrder(ctx, 8n)
    assert.deepEqual(methods(tx), ['cancel_order', 'settle_funds'])
    assert.equal(u64Arg(call(tx, 'cancel_order'), 0), 8n)
  })

  it('creates the wallet USDC and Yes accounts before settling', () => {
    const ctx = restingBuyNo()
    const tx = buildCancelOrder(ctx, 7n)
    const created = createdAccounts(tx)
    ;[ctx.market.usdcMint, ctx.market.yesMint].forEach((mint) =>
      assert.ok(created.some((a) => a.equals(ata(ctx.owner, mint)))),
    )
    const lastCreate = lastCreateIndex(tx)
    assert.ok(lastCreate < indexOf(tx, isMethod('settle_funds')))
  })

  it('still cancels after settlement (R18: cancel always works)', () => {
    const ctx = restingBuyNo(5, { outcome: 'Yes' })
    assert.deepEqual(methods(buildCancelOrder(ctx, 7n)), ['cancel_order', 'settle_funds'])
  })

  it('throws UnwindError ORDER_NOT_FOUND for an order the wallet does not have', () => {
    assert.throws(
      () => buildCancelOrder(restingBuyNo(), 99n),
      (error: unknown) => error instanceof UnwindError && error.code === 'ORDER_NOT_FOUND',
    )
  })
})
