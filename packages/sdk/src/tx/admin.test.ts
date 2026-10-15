import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { Keypair, PublicKey } from '@solana/web3.js'
import type { VersionedTransaction } from '@solana/web3.js'
import {
  buildFinalizeAdminSettle,
  buildProposeAdminPrice,
  buildSetPaused,
  tradingDayNumber,
} from './index.js'
import type { AdminContext } from './index.js'

const PROGRAM_ID = new PublicKey('9o9a9HpN6Aq4UBeozWshAKBugjtToxWdsVzSMPkVHEMX')
const BLOCKHASH = Keypair.generate().publicKey.toBase58()
const DAY = { ticker: 'AAPL', tradingDay: '2026-10-12' }

function context(): AdminContext {
  return { programId: PROGRAM_ID, owner: Keypair.generate().publicKey, recentBlockhash: BLOCKHASH }
}

function discriminator(method: string): Buffer {
  return createHash('sha256').update(`global:${method}`).digest().subarray(0, 8)
}

function pda(...seeds: Uint8Array[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0]
}

const CONFIG = pda(Buffer.from('config'))
const TICKER = Buffer.from([65, 65, 80, 76, 0, 0, 0, 0])
const DAY_LE = Buffer.alloc(4)
DAY_LE.writeUInt32LE(20_261_012)
const TICKER_DAY = pda(Buffer.from('day'), TICKER, DAY_LE)

/** The only instruction of `tx`, with its account metas resolved to keys. */
function onlyInstruction(tx: VersionedTransaction) {
  const { message } = tx
  assert.equal(message.compiledInstructions.length, 1, 'one instruction')
  const ix = message.compiledInstructions[0]!
  const keys = message.staticAccountKeys
  return {
    programId: keys[ix.programIdIndex]!,
    accounts: ix.accountKeyIndexes.map((i) => ({
      key: keys[i]!.toBase58(),
      signer: message.isAccountSigner(i),
      writable: message.isAccountWritable(i),
    })),
    data: Buffer.from(ix.data),
  }
}

function assertAdminSigned(tx: VersionedTransaction, ctx: AdminContext) {
  assert.equal(tx.message.header.numRequiredSignatures, 1, 'one signature: the admin')
  assert.ok(tx.message.staticAccountKeys[0]?.equals(ctx.owner), 'the admin pays')
  assert.equal(tx.message.recentBlockhash, BLOCKHASH)
}

describe('admin builders (R36, R41, R70)', () => {
  it('tradingDayNumber turns YYYY-MM-DD into YYYYMMDD', () => {
    assert.equal(tradingDayNumber('2026-10-12'), 20_261_012)
    assert.throws(() => tradingDayNumber('2026-10-1'), RangeError)
  })

  it('propose_admin_price: admin, config, ticker-day; ticker, day and price in cents', () => {
    const ctx = context()
    const tx = buildProposeAdminPrice(ctx, { ...DAY, priceCents: 23_107 })
    assertAdminSigned(tx, ctx)
    const ix = onlyInstruction(tx)
    assert.ok(ix.programId.equals(PROGRAM_ID))
    assert.deepEqual(ix.accounts, [
      { key: ctx.owner.toBase58(), signer: true, writable: true },
      { key: CONFIG.toBase58(), signer: false, writable: false },
      { key: TICKER_DAY.toBase58(), signer: false, writable: true },
    ])
    const price = Buffer.alloc(8)
    price.writeBigInt64LE(23_107n)
    assert.deepEqual(
      ix.data,
      Buffer.concat([discriminator('propose_admin_price'), TICKER, DAY_LE, price]),
    )
  })

  it('propose_admin_price refuses a price that is not a positive whole number of cents', () => {
    for (const priceCents of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => buildProposeAdminPrice(context(), { ...DAY, priceCents }), RangeError)
    }
  })

  it('finalize_admin_settle: the admin signs as the caller', () => {
    const ctx = context()
    const tx = buildFinalizeAdminSettle(ctx, DAY)
    assertAdminSigned(tx, ctx)
    const ix = onlyInstruction(tx)
    assert.deepEqual(ix.accounts, [
      { key: ctx.owner.toBase58(), signer: true, writable: true },
      { key: CONFIG.toBase58(), signer: false, writable: false },
      { key: TICKER_DAY.toBase58(), signer: false, writable: true },
    ])
    assert.deepEqual(
      ix.data,
      Buffer.concat([discriminator('finalize_admin_settle'), TICKER, DAY_LE]),
    )
  })

  it('pause and unpause write the config', () => {
    for (const [paused, method] of [
      [true, 'pause'],
      [false, 'unpause'],
    ] as const) {
      const ctx = context()
      const tx = buildSetPaused(ctx, paused)
      assertAdminSigned(tx, ctx)
      const ix = onlyInstruction(tx)
      assert.deepEqual(ix.accounts, [
        { key: ctx.owner.toBase58(), signer: true, writable: true },
        { key: CONFIG.toBase58(), signer: false, writable: true },
      ])
      assert.deepEqual(ix.data, discriminator(method))
    }
  })
})
