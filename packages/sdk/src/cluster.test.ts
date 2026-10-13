import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertNotMainnet, isMainnet } from './index.js'

describe('cluster guard', () => {
  it('flags mainnet cluster names and RPC URLs', () => {
    assert.equal(isMainnet('mainnet-beta'), true)
    assert.equal(isMainnet('https://api.mainnet-beta.solana.com'), true)
  })

  it('allows devnet and localnet', () => {
    assert.equal(isMainnet('devnet'), false)
    assert.doesNotThrow(() => assertNotMainnet('http://127.0.0.1:8899'))
  })

  it('throws for mainnet', () => {
    assert.throws(() => assertNotMainnet('mainnet-beta'), /Refusing to run against mainnet/)
  })
})
