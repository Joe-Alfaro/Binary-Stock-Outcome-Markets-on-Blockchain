import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { Keypair, PublicKey } from '@solana/web3.js'
import { loadOracleIdl, oraclePdas, priceInput, tickerSeed } from './oracle-client.js'
import { price } from './test-support.js'

const repoPath = (path: string) => new URL(`../../../../${path}`, import.meta.url).pathname
const IDL_PATH = repoPath('target/idl/meridian_oracle.json')

/**
 * The program's `declare_id!`, the one source of truth for its ID. Program keypairs aren't
 * committed, so `anchor keys sync` rewrites it per machine and a literal would go stale.
 */
function declaredProgramId(): PublicKey {
  const source = readFileSync(repoPath('programs/meridian_oracle/src/lib.rs'), 'utf8')
  const id = /declare_id!\("([1-9A-HJ-NP-Za-km-z]+)"\)/.exec(source)?.[1]
  if (id === undefined) throw new Error('meridian_oracle has no declare_id!')
  return new PublicKey(id)
}

const PROGRAM_ID = declaredProgramId()

describe('meridian_oracle client encoding', () => {
  it('pads tickers to the [u8; 8] seed and rejects anything else', () => {
    assert.deepEqual([...tickerSeed('AAPL')], [65, 65, 80, 76, 0, 0, 0, 0])
    assert.throws(() => tickerSeed('TOOLONGTICKER'), RangeError)
    assert.throws(() => tickerSeed(''), RangeError)
  })

  it('derives the PDAs from the program seeds, with LE publish time and trading day', () => {
    const signer = Keypair.generate().publicKey
    const pdas = oraclePdas(PROGRAM_ID, signer)
    const ticker = Buffer.from('MSFT\0\0\0\0')
    const derive = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0]
    const time = Buffer.alloc(8)
    time.writeBigInt64LE(1_791_576_000n)
    const day = Buffer.alloc(4)
    day.writeUInt32LE(20_261_012)

    assert.ok(pdas.registry.equals(derive(Buffer.from('signers'))))
    assert.ok(
      pdas
        .priceUpdate('MSFT', 1_791_576_000)
        .equals(derive(Buffer.from('price'), signer.toBuffer(), ticker, time)),
    )
    assert.ok(
      pdas
        .closeRecord('MSFT', 20_261_012)
        .equals(derive(Buffer.from('close'), signer.toBuffer(), ticker, day)),
    )
    assert.ok(
      pdas.latestPrice('MSFT').equals(derive(Buffer.from('latest'), signer.toBuffer(), ticker)),
    )
  })

  it('maps a NormalizedPrice to the PriceInput argument', () => {
    const input = priceInput(
      price('AAPL', 245.27, 1_791_576_000, { conf: 100_000_000n, officialClose: true }),
    )
    assert.equal(input.price.toString(), '2452700000000')
    assert.equal(input.conf.toString(), '100000000')
    assert.equal(input.expo, -10)
    assert.equal(input.publishTime.toNumber(), 1_791_576_000)
    assert.deepEqual(input.session, { regular: {} })
    assert.equal(input.officialClose, true)
  })

  it('passes every account the built IDL expects', { skip: !existsSync(IDL_PATH) }, () => {
    const idl = loadOracleIdl(IDL_PATH)
    assert.equal(idl.address, PROGRAM_ID.toBase58())
    const accounts = Object.fromEntries(
      idl.instructions.map((ix) => [ix.name, ix.accounts.map((account) => account.name)]),
    )
    assert.deepEqual(accounts.publish_price, [
      'signer',
      'registry',
      'price_update',
      'system_program',
    ])
    assert.deepEqual(accounts.publish_close, [
      'signer',
      'registry',
      'close_record',
      'first_update',
      'second_update',
      'system_program',
    ])
    assert.deepEqual(accounts.publish_latest, [
      'signer',
      'registry',
      'latest_price',
      'system_program',
    ])
  })
})
