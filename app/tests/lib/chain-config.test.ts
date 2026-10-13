import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createSolanaChainClient } from '../../src/lib/chain'
import { createWalletAdapters } from '../../src/lib/wallet/adapters'

describe('R55 finality', () => {
  it('the Solana chain client confirms at confirmed, not finalized', () => {
    const client = createSolanaChainClient({
      rpcUrl: 'http://127.0.0.1:8999',
      programId: '11111111111111111111111111111111',
      oracleProgramId: '11111111111111111111111111111111',
      relaySigner: '11111111111111111111111111111111',
    })
    assert.equal(client.commitment, 'confirmed')
  })
})

describe('R48 wallet adapters', () => {
  it('offers Phantom and Solflare', () => {
    const names = createWalletAdapters().map((adapter) => adapter.name)
    assert.ok(names.includes('Phantom'), `got ${names.join(', ')}`)
    assert.ok(names.includes('Solflare'), `got ${names.join(', ')}`)
  })
})
