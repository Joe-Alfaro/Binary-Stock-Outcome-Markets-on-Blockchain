import * as anchor from '@anchor-lang/core'
import type { Program } from '@anchor-lang/core'
import { expect } from 'chai'
import type { Meridian } from '../target/types/meridian.js'

describe('meridian', () => {
  anchor.setProvider(anchor.AnchorProvider.env())
  const program = anchor.workspace.meridian as Program<Meridian>

  it('responds to ping', async () => {
    const signature = await program.methods.ping().rpc()
    expect(signature).to.be.a('string').with.length.greaterThan(0)
  })
})
