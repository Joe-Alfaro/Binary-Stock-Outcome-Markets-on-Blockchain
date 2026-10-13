import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Keypair } from '@solana/web3.js'
import { MERIDIAN_ORACLE_PROGRAM_ID, loadOracleProgramId, oracleIdlPath } from './anchor.js'

describe('loadOracleProgramId', () => {
  it('takes the program ID from the built oracle IDL, which follows `anchor keys sync`', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-idl-'))
    const synced = Keypair.generate().publicKey
    writeFileSync(join(dir, 'meridian_oracle.json'), JSON.stringify({ address: synced.toBase58() }))
    assert.equal(
      loadOracleProgramId(oracleIdlPath(join(dir, 'meridian.json'))).toBase58(),
      synced.toBase58(),
    )
  })

  it('falls back to the declared ID when there is no build output', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'oracle-idl-')), 'meridian_oracle.json')
    assert.equal(loadOracleProgramId(missing).toBase58(), MERIDIAN_ORACLE_PROGRAM_ID.toBase58())
  })
})
