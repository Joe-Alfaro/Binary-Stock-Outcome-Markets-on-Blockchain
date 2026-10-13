import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import * as sdk from '@meridian/sdk'
import { appChainConfig } from '../../src/lib/app-services'
import { builtProgramIds } from '../../src/lib/program-ids'

const MERIDIAN = 'NEXT_PUBLIC_MERIDIAN_PROGRAM_ID'
const ORACLE = 'NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID'
const MERIDIAN_ID = 'GU3LWr4VTMc2DGug5tznwBHj1Wr83JAsGVEKs5TZuPxK'
const ORACLE_ID = 'As7akRBcqkjx4SsKQSvNsYAAxLncRBJ9v46bCxYxn1yJ'

describe('app services', () => {
  const saved = { [MERIDIAN]: process.env[MERIDIAN], [ORACLE]: process.env[ORACLE] }
  before(() => {
    process.env[MERIDIAN] = MERIDIAN_ID
    process.env[ORACLE] = ORACLE_ID
  })
  after(() => {
    Object.entries(saved).forEach(([name, value]) => {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  })

  it('take the program IDs from the environment', () => {
    const config = appChainConfig()
    assert.equal(config.programId, MERIDIAN_ID)
    assert.equal(config.oracleProgramId, ORACLE_ID)
  })

  it('refuse to start without a program ID instead of guessing one', () => {
    delete process.env[ORACLE]
    try {
      assert.throws(() => appChainConfig(), /NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID is not set/)
    } finally {
      process.env[ORACLE] = ORACLE_ID
    }
  })

  it('give the chain client the SDK trade builders', () => {
    const builders = appChainConfig().builders
    assert.ok(builders, 'no builders configured')
    assert.equal(builders.buildBuyYesTransaction, sdk.buildBuyYesTransaction)
    assert.equal(builders.buildSellYesTransaction, sdk.buildSellYesTransaction)
    assert.equal(builders.buildBuyNoTransaction, sdk.buildBuyNoTransaction)
    assert.equal(builders.buildSellNoTransaction, sdk.buildSellNoTransaction)
  })

  it('give the chain client the SDK redeem and close-out builders', () => {
    const builders = appChainConfig().builders
    assert.ok(builders, 'no builders configured')
    assert.equal(builders.buildRedeem, sdk.buildRedeem)
    assert.equal(builders.buildCloseOutAndRedeem, sdk.buildCloseOutAndRedeem)
  })

  it('give the chain client the SDK cancel and pre-settlement close-out builders (R28 [G])', () => {
    const builders = appChainConfig().builders
    assert.ok(builders, 'no builders configured')
    assert.equal(builders.buildCancelOrder, sdk.buildCancelOrder)
    assert.equal(builders.buildCloseOutPosition, sdk.buildCloseOutPosition)
  })
})

describe('built program IDs', () => {
  it('come from the address field of the IDLs anchor build writes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idl-'))
    writeFileSync(join(dir, 'meridian.json'), JSON.stringify({ address: MERIDIAN_ID }))
    writeFileSync(join(dir, 'meridian_oracle.json'), JSON.stringify({ address: ORACLE_ID }))
    assert.deepEqual(builtProgramIds(dir), { meridian: MERIDIAN_ID, meridianOracle: ORACLE_ID })
  })

  it('are absent when nothing is built', () => {
    assert.deepEqual(builtProgramIds(mkdtempSync(join(tmpdir(), 'idl-'))), {})
  })
})
