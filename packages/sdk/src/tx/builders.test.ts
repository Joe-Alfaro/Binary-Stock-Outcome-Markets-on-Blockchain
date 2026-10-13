import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import {
  AddressLookupTableAccount,
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import { PositionConstraintError } from '../trading/index.js'
import {
  buildBuyNoTransaction,
  buildBuyYesTransaction,
  buildSellNoTransaction,
  buildSellYesTransaction,
} from './index.js'
import type { MarketAccounts, TradeContext } from './index.js'

const MAX_TX_BYTES = 1232
const MAX_TX_COMPUTE_UNITS = 1_400_000
const UNIT = 1_000_000n
const PROGRAM_ID = new PublicKey('9o9a9HpN6Aq4UBeozWshAKBugjtToxWdsVzSMPkVHEMX')
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const BLOCKHASH = Keypair.generate().publicKey.toBase58()

// Borsh enum tags of `Side` and `OrderKind`.
const BID = 0
const ASK = 1
const LIMIT = 0
const MARKET = 1

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

/** A fresh wallet: no Yes or No, and nothing in the book. */
function freshContext(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    owner: Keypair.generate().publicKey,
    market: newMarket(),
    holdings: { yes: 0, no: 0 },
    walletYesBaseUnits: 0n,
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

const METHODS = ['mint_pair', 'merge_pair_up_to', 'place_order', 'settle_funds'] as const
type Method = (typeof METHODS)[number]

/** Decompiles the transaction (static keys only; lookups are tested separately). */
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

function placeOrderArgs(ix: TransactionInstruction) {
  const d = ix.data
  assert.equal(d.length, 8 + 1 + 1 + 1 + 8)
  return { side: d[8], kind: d[9], price: d[10], qty: d.readBigUInt64LE(11) }
}

function u64Arg(ix: TransactionInstruction, index: number): bigint {
  return ix.data.readBigUInt64LE(8 + 8 * index)
}

function key(ix: TransactionInstruction, index: number): PublicKey {
  const meta = ix.keys[index]
  assert.ok(meta, `account ${index}`)
  return meta.pubkey
}

/** Mints for which the transaction creates the owner's associated token account idempotently. */
function createdAtaMints(tx: VersionedTransaction, owner: PublicKey): PublicKey[] {
  return instructions(tx)
    .filter((ix) => ix.programId.equals(ATA_PROGRAM))
    .map((ix) => {
      assert.deepEqual([...ix.data], [1], 'CreateIdempotent, never Create')
      const mint = key(ix, 3)
      assert.ok(key(ix, 0).equals(owner), 'the wallet pays')
      assert.ok(key(ix, 1).equals(ata(owner, mint)))
      assert.ok(key(ix, 2).equals(owner))
      return mint
    })
}

function includesKey(list: PublicKey[], wanted: PublicKey): boolean {
  return list.some((k) => k.equals(wanted))
}

/** R27: one v0 transaction, signed only by the wallet, within 1232 bytes and the compute cap. */
function assertSingleApprovalTransaction(tx: VersionedTransaction, ctx: TradeContext): void {
  assert.ok(tx instanceof VersionedTransaction)
  assert.equal(tx.version, 0)
  assert.equal(tx.message.header.numRequiredSignatures, 1, 'one signature')
  assert.equal(tx.signatures.length, 1)
  const payer = tx.message.staticAccountKeys[0]
  assert.ok(payer?.equals(ctx.owner), 'the wallet is the fee payer and only signer')
  assert.equal(tx.message.recentBlockhash, ctx.recentBlockhash)
  const bytes = tx.serialize().length
  assert.ok(bytes <= MAX_TX_BYTES, `transaction is ${bytes} bytes`)

  const budget = instructions(tx).filter((ix) =>
    ix.programId.equals(ComputeBudgetProgram.programId),
  )
  const limits = budget.filter(
    (ix) => ComputeBudgetInstruction.decodeInstructionType(ix) === 'SetComputeUnitLimit',
  )
  assert.equal(limits.length, 1, 'sets a compute unit limit for a full fill-cap sweep')
  const limit = limits[0]
  assert.ok(limit)
  const { units } = ComputeBudgetInstruction.decodeSetComputeUnitLimit(limit)
  assert.ok(units > 200_000 && units <= MAX_TX_COMPUTE_UNITS, `${units} compute units`)
}

/** Account creation comes first, then the Meridian calls in exactly this order. */
function assertSteps(tx: VersionedTransaction, steps: Method[]): void {
  assert.deepEqual(meridianCalls(tx).map(methodOf), steps)
  const all = instructions(tx)
  const lastAta = all.map((ix) => ix.programId.equals(ATA_PROGRAM)).lastIndexOf(true)
  const firstMeridian = all.findIndex((ix) => ix.programId.equals(PROGRAM_ID))
  assert.ok(lastAta < firstMeridian, 'token accounts exist before the program uses them')
}

/** `place_order` accounts: owner, config, market, book, yes_escrow, usdc_escrow, user_usdc, user_yes, token program, event authority, program. */
function assertPlaceOrderAccounts(ix: TransactionInstruction, ctx: TradeContext): void {
  const m = ctx.market
  const eventAuthority = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    PROGRAM_ID,
  )[0]
  const expected = [
    ctx.owner,
    m.config,
    m.market,
    m.book,
    m.yesEscrow,
    m.usdcEscrow,
    ata(ctx.owner, m.usdcMint),
    ata(ctx.owner, m.yesMint),
    TOKEN_PROGRAM,
    eventAuthority,
    PROGRAM_ID,
  ]
  assert.deepEqual(
    ix.keys.map((k) => k.pubkey.toBase58()),
    expected.map((k) => k.toBase58()),
  )
  assert.ok(ix.keys[0]?.isSigner)
}

/** `mint_pair` and `merge_pair_up_to` accounts: user, config, market, mints, vault, user USDC/Yes/No, token program. */
function assertCollateralAccounts(ix: TransactionInstruction, ctx: TradeContext): void {
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
}

/** `settle_funds` accounts: owner, market, book, yes_escrow, usdc_escrow, user_yes, user_usdc, token program. */
function assertSettleFundsAccounts(ix: TransactionInstruction, ctx: TradeContext): void {
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

describe('R23 Buy Yes builder', () => {
  it('builds one wallet-signed transaction: create Yes account, place a bid, settle', () => {
    const ctx = freshContext()
    const tx = buildBuyYesTransaction(ctx, { kind: 'Market', priceCents: 65, qty: 3 })

    assertSingleApprovalTransaction(tx, ctx)
    assertSteps(tx, ['place_order', 'settle_funds'])
    assert.ok(includesKey(createdAtaMints(tx, ctx.owner), ctx.market.yesMint))
    assert.deepEqual(placeOrderArgs(call(tx, 'place_order')), {
      side: BID,
      kind: MARKET,
      price: 65,
      qty: 3n,
    })
    assertPlaceOrderAccounts(call(tx, 'place_order'), ctx)
    assertSettleFundsAccounts(call(tx, 'settle_funds'), ctx)
  })

  it('places a limit bid for a limit order', () => {
    const ctx = freshContext()
    const tx = buildBuyYesTransaction(ctx, { kind: 'Limit', priceCents: 62, qty: 5 })

    assertSingleApprovalTransaction(tx, ctx)
    assert.deepEqual(placeOrderArgs(call(tx, 'place_order')), {
      side: BID,
      kind: LIMIT,
      price: 62,
      qty: 5n,
    })
  })
})

describe('R24 Sell Yes builder', () => {
  it('sells at market (worst price) or rests a limit ask, creating the USDC account', () => {
    const ctx = freshContext({ holdings: { yes: 3, no: 0 }, walletYesBaseUnits: 3n * UNIT })
    const market = buildSellYesTransaction(ctx, { kind: 'Market', priceCents: 50, qty: 3 })
    const limit = buildSellYesTransaction(ctx, { kind: 'Limit', priceCents: 70, qty: 3 })

    for (const tx of [market, limit]) {
      assertSingleApprovalTransaction(tx, ctx)
      assertSteps(tx, ['place_order', 'settle_funds'])
      assert.ok(includesKey(createdAtaMints(tx, ctx.owner), ctx.market.usdcMint))
      assertPlaceOrderAccounts(call(tx, 'place_order'), ctx)
    }
    assert.deepEqual(placeOrderArgs(call(market, 'place_order')), {
      side: ASK,
      kind: MARKET,
      price: 50,
      qty: 3n,
    })
    assert.deepEqual(placeOrderArgs(call(limit, 'place_order')), {
      side: ASK,
      kind: LIMIT,
      price: 70,
      qty: 3n,
    })
  })
})

describe('R25 Buy No builder', () => {
  it('market: mints, sells Yes at 100 − No price as a worst price, settles and merges the rest', () => {
    const ctx = freshContext()
    const tx = buildBuyNoTransaction(ctx, { kind: 'Market', noPriceCents: 60, qty: 5 })

    assertSingleApprovalTransaction(tx, ctx)
    assertSteps(tx, ['mint_pair', 'place_order', 'settle_funds', 'merge_pair_up_to'])
    const mints = createdAtaMints(tx, ctx.owner)
    assert.ok(includesKey(mints, ctx.market.yesMint))
    assert.ok(includesKey(mints, ctx.market.noMint))

    const mint = call(tx, 'mint_pair')
    assert.equal(u64Arg(mint, 0), 5n)
    assertCollateralAccounts(mint, ctx)
    assert.deepEqual(placeOrderArgs(call(tx, 'place_order')), {
      side: ASK,
      kind: MARKET,
      price: 40,
      qty: 5n,
    })
    assertPlaceOrderAccounts(call(tx, 'place_order'), ctx)
    assertSettleFundsAccounts(call(tx, 'settle_funds'), ctx)

    // The unfilled amount is unknown when building, so the program merges up to qty.
    const merge = call(tx, 'merge_pair_up_to')
    assert.equal(u64Arg(merge, 0), 5n, 'max_n')
    assert.equal(u64Arg(merge, 1), 0n, 'keep_yes')
    assertCollateralAccounts(merge, ctx)
  })

  it('limit: mints, rests the Yes ask at 100 − No price and settles, without merging', () => {
    const ctx = freshContext()
    const tx = buildBuyNoTransaction(ctx, { kind: 'Limit', noPriceCents: 60, qty: 3 })

    assertSingleApprovalTransaction(tx, ctx)
    assertSteps(tx, ['mint_pair', 'place_order', 'settle_funds'])
    assert.deepEqual(placeOrderArgs(call(tx, 'place_order')), {
      side: ASK,
      kind: LIMIT,
      price: 40,
      qty: 3n,
    })
  })

  it('passes the wallet Yes balance from before the transaction as keep_yes', () => {
    // Holdings are 0 (R28 allows Buy No); a dust Yes balance below one token still must be kept.
    const ctx = freshContext({ walletYesBaseUnits: 250_000n })
    const tx = buildBuyNoTransaction(ctx, { kind: 'Market', noPriceCents: 55, qty: 2 })

    assert.equal(u64Arg(call(tx, 'merge_pair_up_to'), 1), 250_000n)
  })
})

describe('R26 Sell No builder', () => {
  it('buys Yes at market with worst price 100 − No price, settles and merges on-chain', () => {
    const ctx = freshContext({ holdings: { yes: 0, no: 4 } })
    const tx = buildSellNoTransaction(ctx, { noPriceCents: 65, qty: 4 })

    assertSingleApprovalTransaction(tx, ctx)
    assertSteps(tx, ['place_order', 'settle_funds', 'merge_pair_up_to'])
    assert.ok(includesKey(createdAtaMints(tx, ctx.owner), ctx.market.yesMint))
    assert.deepEqual(placeOrderArgs(call(tx, 'place_order')), {
      side: BID,
      kind: MARKET,
      price: 35,
      qty: 4n,
    })
    const merge = call(tx, 'merge_pair_up_to')
    assert.equal(u64Arg(merge, 0), 4n, 'max_n')
    assert.equal(u64Arg(merge, 1), 0n, 'keep_yes')
    assertCollateralAccounts(merge, ctx)
  })

  it('keeps Yes the wallet already held, so only the Yes bought here is merged', () => {
    const ctx = freshContext({ holdings: { yes: 2, no: 5 }, walletYesBaseUnits: 2n * UNIT })
    const tx = buildSellNoTransaction(ctx, { noPriceCents: 65, qty: 3 })

    assert.equal(u64Arg(call(tx, 'merge_pair_up_to'), 1), 2n * UNIT)
  })
})

describe('R27 single-approval transactions fit', () => {
  const paths: [string, (ctx: TradeContext) => VersionedTransaction][] = [
    [
      'Buy Yes',
      (ctx) => buildBuyYesTransaction(ctx, { kind: 'Market', priceCents: 99, qty: 1_000_000 }),
    ],
    [
      'Sell Yes',
      (ctx) => buildSellYesTransaction(ctx, { kind: 'Market', priceCents: 1, qty: 1_000_000 }),
    ],
    [
      'Buy No',
      (ctx) => buildBuyNoTransaction(ctx, { kind: 'Market', noPriceCents: 99, qty: 1_000_000 }),
    ],
    ['Sell No', (ctx) => buildSellNoTransaction(ctx, { noPriceCents: 1, qty: 1_000_000 })],
  ]

  for (const [name, build] of paths) {
    it(`${name} from a fresh wallet is one signature within ${MAX_TX_BYTES} bytes`, () => {
      const ctx = freshContext({
        holdings: name.startsWith('Sell') ? { yes: 1_000_000, no: 1_000_000 } : { yes: 0, no: 0 },
      })
      assertSingleApprovalTransaction(build(ctx), ctx)
    })
  }

  it('compiles the given lookup tables into the message and gets smaller', () => {
    const ctx = freshContext()
    const m = ctx.market
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: {
        deactivationSlot: BigInt('18446744073709551615'),
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [
          m.config,
          m.market,
          m.yesMint,
          m.noMint,
          m.vault,
          m.book,
          m.yesEscrow,
          m.usdcEscrow,
          m.usdcMint,
          TOKEN_PROGRAM,
          ATA_PROGRAM,
        ],
      },
    })
    const order = { kind: 'Market', noPriceCents: 60, qty: 5 } as const
    const plain = buildBuyNoTransaction(ctx, order)
    const withTable = buildBuyNoTransaction({ ...ctx, lookupTables: [table] }, order)

    assert.equal(withTable.message.addressTableLookups.length, 1)
    assert.ok(withTable.serialize().length < plain.serialize().length)
    assert.equal(withTable.message.header.numRequiredSignatures, 1)
  })
})

describe('R28 builders enforce the position constraint', () => {
  it('Buy Yes throws while the wallet holds No, offering Sell No', () => {
    const ctx = freshContext({ holdings: { yes: 0, no: 2 } })
    assert.throws(
      () => buildBuyYesTransaction(ctx, { kind: 'Market', priceCents: 60, qty: 1 }),
      (e: unknown) =>
        e instanceof PositionConstraintError && e.code === 'HOLDS_NO' && e.exitAction === 'SellNo',
    )
  })

  it('Buy No throws while the wallet holds Yes, offering Sell Yes', () => {
    const ctx = freshContext({ holdings: { yes: 1, no: 0 }, walletYesBaseUnits: UNIT })
    for (const kind of ['Market', 'Limit'] as const) {
      assert.throws(
        () => buildBuyNoTransaction(ctx, { kind, noPriceCents: 60, qty: 1 }),
        (e: unknown) =>
          e instanceof PositionConstraintError &&
          e.code === 'HOLDS_YES' &&
          e.exitAction === 'SellYes',
      )
    }
  })

  it('Sell Yes and Sell No still build while the wallet holds both (resting Buy No limit)', () => {
    const ctx = freshContext({ holdings: { yes: 3, no: 3 }, walletYesBaseUnits: 0n })
    assertSingleApprovalTransaction(
      buildSellYesTransaction(ctx, { kind: 'Limit', priceCents: 40, qty: 3 }),
      ctx,
    )
    assertSingleApprovalTransaction(buildSellNoTransaction(ctx, { noPriceCents: 60, qty: 3 }), ctx)
  })
})

describe('builders reject invalid orders', () => {
  const ctx = freshContext()

  for (const priceCents of [0, 100, 50.5, -1, Number.NaN]) {
    it(`rejects price ${priceCents}`, () => {
      assert.throws(
        () => buildBuyYesTransaction(ctx, { kind: 'Limit', priceCents, qty: 1 }),
        RangeError,
      )
      assert.throws(
        () => buildSellYesTransaction(ctx, { kind: 'Limit', priceCents, qty: 1 }),
        RangeError,
      )
      assert.throws(
        () => buildBuyNoTransaction(ctx, { kind: 'Limit', noPriceCents: priceCents, qty: 1 }),
        RangeError,
      )
      assert.throws(
        () => buildSellNoTransaction(ctx, { noPriceCents: priceCents, qty: 1 }),
        RangeError,
      )
    })
  }

  for (const qty of [0, -1, 1.5]) {
    it(`rejects quantity ${qty}`, () => {
      assert.throws(
        () => buildBuyYesTransaction(ctx, { kind: 'Market', priceCents: 50, qty }),
        RangeError,
      )
      assert.throws(
        () => buildBuyNoTransaction(ctx, { kind: 'Market', noPriceCents: 50, qty }),
        RangeError,
      )
      assert.throws(() => buildSellNoTransaction(ctx, { noPriceCents: 50, qty }), RangeError)
    })
  }
})
