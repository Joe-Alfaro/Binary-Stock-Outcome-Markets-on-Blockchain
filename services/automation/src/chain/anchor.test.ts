import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Connection, Keypair } from '@solana/web3.js'
import {
  DEFAULT_IDL_PATH,
  createAnchorChainClient,
  loadMeridianIdl,
  loadOracleProgramId,
  oracleIdlPath,
} from './anchor.js'

describe('oracle program ID', () => {
  it('defaults to the address in the built oracle IDL, which follows `anchor keys sync`', () => {
    const built = JSON.parse(readFileSync(oracleIdlPath(DEFAULT_IDL_PATH), 'utf8')) as {
      address: string
    }
    const chain = createAnchorChainClient({
      connection: new Connection('http://127.0.0.1:1'),
      authority: Keypair.generate(),
      idl: loadMeridianIdl(),
    })
    assert.equal(chain.oracleProgramId.toBase58(), built.address)
  })

  it('reads the oracle IDL beside the meridian IDL it is given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oracle-idl-'))
    const synced = Keypair.generate().publicKey
    writeFileSync(join(dir, 'meridian_oracle.json'), JSON.stringify({ address: synced.toBase58() }))
    assert.equal(
      loadOracleProgramId(oracleIdlPath(join(dir, 'meridian.json'))).toBase58(),
      synced.toBase58(),
    )
  })

  it('names the fix when there is no built oracle IDL', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'oracle-idl-')), 'meridian_oracle.json')
    assert.throws(
      () => loadOracleProgramId(missing),
      /anchor build or set MERIDIAN_ORACLE_PROGRAM_ID/,
    )
  })
})
