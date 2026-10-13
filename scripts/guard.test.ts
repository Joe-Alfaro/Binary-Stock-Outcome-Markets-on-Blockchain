import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { assertDemoCluster, assertSafeTarget, resolveCluster, type GenesisRpc } from './guard.js'
import { DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from './lib/test-support.js'

function fakeRpc(hash: string) {
  const rpc = {
    calls: 0,
    async getGenesisHash() {
      rpc.calls += 1
      return hash
    },
  }
  return rpc satisfies GenesisRpc & { calls: number }
}

describe('resolveCluster', () => {
  it('defaults to devnet and its public RPC URL', () => {
    assert.deepEqual(resolveCluster({}), {
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
    })
  })

  it('uses localnet on 127.0.0.1 and keeps an explicit RPC URL', () => {
    assert.equal(resolveCluster({ SOLANA_CLUSTER: 'localnet' }).cluster, 'localnet')
    assert.equal(
      resolveCluster({ SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'https://rpc.example.com' })
        .rpcUrl,
      'https://rpc.example.com',
    )
  })
})

// R45: every entry point refuses mainnet-beta by name, by known URL and by genesis hash.
describe('assertSafeTarget (R45)', () => {
  it('refuses the mainnet-beta cluster name without calling the RPC', async () => {
    const rpc = fakeRpc(DEVNET_GENESIS_HASH)
    await assert.rejects(assertSafeTarget({ SOLANA_CLUSTER: 'mainnet-beta' }, rpc), /mainnet/i)
    assert.equal(rpc.calls, 0)
  })

  it('refuses a known mainnet RPC URL even when the cluster says devnet', async () => {
    const rpc = fakeRpc(DEVNET_GENESIS_HASH)
    await assert.rejects(
      assertSafeTarget(
        { SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' },
        rpc,
      ),
      /mainnet/i,
    )
    assert.equal(rpc.calls, 0)
  })

  it('refuses a custom RPC URL whose genesis hash is mainnet-beta', async () => {
    const rpc = fakeRpc(MAINNET_GENESIS_HASH)
    await assert.rejects(
      assertSafeTarget(
        { SOLANA_CLUSTER: 'devnet', SOLANA_RPC_URL: 'https://rpc.example.com' },
        rpc,
      ),
      /mainnet/i,
    )
    assert.equal(rpc.calls, 1)
  })

  it('allows devnet after checking the genesis hash', async () => {
    const rpc = fakeRpc(DEVNET_GENESIS_HASH)
    const target = await assertSafeTarget({ SOLANA_CLUSTER: 'devnet' }, rpc)
    assert.equal(target.cluster, 'devnet')
    assert.equal(rpc.calls, 1)
  })
})

// R44: demo mode is refused unless the cluster is localnet or devnet.
describe('assertDemoCluster (R44)', () => {
  it('allows localnet and devnet', () => {
    assert.doesNotThrow(() => assertDemoCluster('localnet'))
    assert.doesNotThrow(() => assertDemoCluster('devnet'))
  })

  it('refuses testnet, mainnet-beta and unknown clusters', () => {
    assert.throws(() => assertDemoCluster('testnet'), /demo/i)
    assert.throws(() => assertDemoCluster('mainnet-beta'), /demo/i)
    assert.throws(() => assertDemoCluster('custom'), /demo/i)
  })
})
