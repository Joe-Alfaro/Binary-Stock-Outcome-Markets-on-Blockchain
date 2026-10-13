import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  it('defaults to devnet with demo mode off', () => {
    assert.deepEqual(loadConfig({}), { cluster: 'devnet', demoMode: false })
  })

  it('reads cluster and demo mode from the environment', () => {
    assert.deepEqual(loadConfig({ SOLANA_CLUSTER: 'localnet', DEMO_MODE: 'true' }), {
      cluster: 'localnet',
      demoMode: true,
    })
  })
})
