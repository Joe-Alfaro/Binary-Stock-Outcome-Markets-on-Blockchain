import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { bootstrap, buildConfigParams } from './bootstrap.js'
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  MOCK_MINT,
  TESTNET_GENESIS_HASH,
  fakeBootstrapClient,
  roleKeyEnv,
} from './lib/test-support.js'

const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

// R59: config bootstrap with slot 1 MeridianRelay, slot 2 Disabled and the thresholds.
describe('buildConfigParams (R59)', () => {
  const keys = { admin: 'A', automation: 'B', relaySigner1: 'C', usdcMint: USDC_MINT }

  it('sets the roles, mint and the 7 tickers', () => {
    const params = buildConfigParams(keys)
    assert.equal(params.admin, 'A')
    assert.equal(params.automationAuthority, 'B')
    assert.equal(params.usdcMint, USDC_MINT)
    assert.deepEqual(params.tickers, ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'])
  })

  it('uses slot 1 MeridianRelay with the relay signer and slot 2 Disabled', () => {
    assert.deepEqual(buildConfigParams(keys).oracleSlots, [
      { kind: 'MeridianRelay', signer: 'C' },
      { kind: 'Disabled' },
    ])
  })

  it('sets the thresholds and delays', () => {
    const params = buildConfigParams(keys)
    assert.equal(params.maxStalenessSecs, 300)
    assert.equal(params.adminProposeDelaySecs, 900)
    assert.equal(params.adminFinalizeDelaySecs, 3600)
    assert.ok(Number.isInteger(params.maxConfBps) && params.maxConfBps > 0)
  })
})

describe('bootstrap (R59, R43, R45)', () => {
  it('initializes config with USDC_MINT and then registers both relay signers', async () => {
    const { env, publicKeys } = roleKeyEnv()
    const fake = fakeBootstrapClient()
    const result = await bootstrap({
      env: { ...env, SOLANA_CLUSTER: 'devnet', USDC_MINT },
      client: fake.client,
    })
    assert.equal(fake.configs.length, 1)
    const config = fake.configs[0]
    assert.equal(config?.usdcMint, USDC_MINT)
    assert.equal(config?.admin, publicKeys.admin)
    assert.equal(config?.automationAuthority, publicKeys.automation)
    assert.deepEqual(config?.oracleSlots[0], { kind: 'MeridianRelay', signer: publicKeys.relay1 })
    assert.equal(config?.adminProposeDelaySecs, 900)
    assert.deepEqual(fake.signers, [publicKeys.relay1, publicKeys.relay2])
    assert.ok(fake.log.indexOf('initializeConfig') < fake.log.indexOf('registerRelaySigner'))
    assert.equal(fake.mintDecimals.length, 0)
    assert.equal(result.usdcMint, USDC_MINT)
    assert.ok(result.signatures.includes('sig-config'))
  })

  it('creates a mock 6-decimal mint when asked and uses it in config', async () => {
    const { env } = roleKeyEnv()
    const fake = fakeBootstrapClient()
    const result = await bootstrap({
      env: { ...env, SOLANA_CLUSTER: 'devnet', USDC_MINT },
      client: fake.client,
      mockUsdc: true,
    })
    assert.deepEqual(fake.mintDecimals, [6])
    assert.equal(fake.configs[0]?.usdcMint, MOCK_MINT)
    assert.equal(result.usdcMint, MOCK_MINT)
    assert.ok(fake.log.indexOf('createMockUsdcMint') < fake.log.indexOf('initializeConfig'))
  })

  it('fails before any transaction when two role keys are the same', async () => {
    const { env } = roleKeyEnv()
    const fake = fakeBootstrapClient()
    await assert.rejects(
      bootstrap({
        env: { ...env, SOLANA_CLUSTER: 'devnet', USDC_MINT, AUTOMATION_KEYPAIR: env.ADMIN_KEYPAIR },
        client: fake.client,
      }),
      /distinct/i,
    )
    assert.equal(fake.configs.length + fake.signers.length + fake.mintDecimals.length, 0)
  })

  const mainnetTargets: [string, NodeJS.ProcessEnv, string][] = [
    ['cluster name', { SOLANA_CLUSTER: 'mainnet-beta' }, DEVNET_GENESIS_HASH],
    ['RPC URL', { SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' }, DEVNET_GENESIS_HASH],
    ['genesis hash', { SOLANA_RPC_URL: 'https://rpc.example.com' }, MAINNET_GENESIS_HASH],
  ]
  mainnetTargets.forEach(([label, target, genesis]) => {
    it(`refuses mainnet-beta by ${label} before sending anything`, async () => {
      const { env } = roleKeyEnv()
      const fake = fakeBootstrapClient(genesis)
      await assert.rejects(
        bootstrap({ env: { ...env, USDC_MINT, ...target }, client: fake.client, mockUsdc: true }),
        /mainnet/i,
      )
      assert.equal(fake.configs.length + fake.signers.length + fake.mintDecimals.length, 0)
    })
  })
})

// R44: DEMO_MODE=true turns demo mode on after initialize_config, and only on localnet or devnet.
describe('bootstrap demo mode (R44)', () => {
  const demoClusters = ['devnet', 'localnet']
  demoClusters.forEach((cluster) => {
    it(`turns demo mode on after initialize_config on ${cluster} when DEMO_MODE=true`, async () => {
      const { env } = roleKeyEnv()
      const fake = fakeBootstrapClient()
      const result = await bootstrap({
        env: { ...env, SOLANA_CLUSTER: cluster, USDC_MINT, DEMO_MODE: 'true' },
        client: fake.client,
      })
      assert.deepEqual(fake.demoModes, [true])
      assert.ok(fake.log.indexOf('initializeConfig') < fake.log.indexOf('setDemoMode'))
      assert.ok(result.signatures.includes('sig-demo-mode'))
    })
  })

  it('refuses DEMO_MODE=true on testnet before sending anything', async () => {
    const { env } = roleKeyEnv()
    const fake = fakeBootstrapClient(TESTNET_GENESIS_HASH)
    await assert.rejects(
      bootstrap({
        env: { ...env, SOLANA_CLUSTER: 'testnet', USDC_MINT, DEMO_MODE: 'true' },
        client: fake.client,
        mockUsdc: true,
      }),
      /demo/i,
    )
    assert.equal(
      fake.configs.length + fake.signers.length + fake.mintDecimals.length + fake.demoModes.length,
      0,
    )
  })

  const offValues: [string, NodeJS.ProcessEnv][] = [
    ['unset', {}],
    ['false', { DEMO_MODE: 'false' }],
  ]
  offValues.forEach(([label, demoEnv]) => {
    it(`leaves demo mode off when DEMO_MODE is ${label}`, async () => {
      const { env } = roleKeyEnv()
      const fake = fakeBootstrapClient()
      await bootstrap({
        env: { ...env, SOLANA_CLUSTER: 'devnet', USDC_MINT, ...demoEnv },
        client: fake.client,
      })
      assert.equal(fake.configs.length, 1)
      assert.deepEqual(fake.demoModes, [])
    })
  })

  it('leaves demo mode off on testnet when DEMO_MODE is unset', async () => {
    const { env } = roleKeyEnv()
    const fake = fakeBootstrapClient(TESTNET_GENESIS_HASH)
    await bootstrap({
      env: { ...env, SOLANA_CLUSTER: 'testnet', USDC_MINT },
      client: fake.client,
    })
    assert.equal(fake.configs.length, 1)
    assert.deepEqual(fake.demoModes, [])
  })
})
