import * as anchor from '@anchor-lang/core'
import type { Program } from '@anchor-lang/core'
import { expect } from 'chai'
import type { MeridianOracle } from '../target/types/meridian_oracle.js'

describe('meridian_oracle', () => {
  anchor.setProvider(anchor.AnchorProvider.env())
  const program = anchor.workspace.meridianOracle as Program<MeridianOracle>

  it('responds to ping', async () => {
    const signature = await program.methods.ping().rpc()
    expect(signature).to.be.a('string').with.length.greaterThan(0)
  })
})
