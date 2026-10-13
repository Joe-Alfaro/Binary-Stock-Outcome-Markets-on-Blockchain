import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import anchor from '@anchor-lang/core'
import { Keypair } from '@solana/web3.js'
import { FakeChainClient } from './chain/fake.js'
import { createHealthState } from './health.js'
import { FakeClock } from './jobs/fake-clock.js'
import {
  createJobLogger,
  loadChainSettings,
  parseKeypair,
  startWorker,
  withScanHealth,
} from './worker.js'

const KEY = 'AUTOMATION_KEYPAIR'

describe('loadChainSettings', () => {
  it('defaults to the devnet RPC and the default meridian IDL', () => {
    const settings = loadChainSettings({ [KEY]: '/keys/automation.json' })
    assert.equal(settings.rpcUrl, 'https://api.devnet.solana.com')
    assert.equal(settings.automationKeypair, '/keys/automation.json')
    // R65: a deploy has no target/, so the default may be an IDL the service ships.
    assert.match(settings.idlPath, /meridian\.json$/)
    assert.equal(settings.programId, undefined)
  })

  it('uses the local validator port on localnet and an explicit RPC URL first', () => {
    const local = loadChainSettings({
      [KEY]: 'k',
      SOLANA_CLUSTER: 'localnet',
      LOCAL_VALIDATOR_RPC_PORT: '8913',
    })
    assert.equal(local.rpcUrl, 'http://127.0.0.1:8913')
    const explicit = loadChainSettings({
      [KEY]: 'k',
      SOLANA_RPC_URL: 'https://rpc.example',
      MERIDIAN_PROGRAM_ID: 'P',
      MERIDIAN_ORACLE_PROGRAM_ID: 'O',
    })
    assert.equal(explicit.rpcUrl, 'https://rpc.example')
    assert.equal(explicit.programId, 'P')
    assert.equal(explicit.oracleProgramId, 'O')
  })

  it('refuses mainnet and a missing automation key', () => {
    assert.throws(
      () =>
        loadChainSettings({ [KEY]: 'k', SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' }),
      /mainnet/,
    )
    assert.throws(() => loadChainSettings({}), /AUTOMATION_KEYPAIR is not set/)
  })
})

describe('parseKeypair', () => {
  const keypair = Keypair.generate()
  const json = JSON.stringify([...keypair.secretKey])

  it('reads a JSON byte array, a base58 secret or a keypair file', () => {
    assert.ok(parseKeypair(json).publicKey.equals(keypair.publicKey))
    const base58 = anchor.utils.bytes.bs58.encode(keypair.secretKey)
    assert.ok(parseKeypair(base58).publicKey.equals(keypair.publicKey))
    const fromFile = parseKeypair('/keys/automation.json', (path) => {
      assert.equal(path, '/keys/automation.json')
      return json
    })
    assert.ok(fromFile.publicKey.equals(keypair.publicKey))
  })

  it('rejects a file that is not a keypair', () => {
    assert.throws(() => parseKeypair('/keys/x.json', () => '{}'), /not a keypair file/)
  })
})

describe('worker plumbing', () => {
  it('logs JSON lines with bigints as strings', () => {
    const lines: string[] = []
    const log = createJobLogger((line) => lines.push(line), new FakeClock(0))
    log.info('market settled', { strike: 245n })
    assert.deepEqual(JSON.parse(lines[0] ?? ''), {
      level: 'info',
      at: '1970-01-01T00:00:00.000Z',
      message: 'market settled',
      strike: '245',
    })
  })

  it('records a health scan after each successful open-market listing', async () => {
    const clock = new FakeClock(1_000)
    const health = createHealthState()
    const chain = withScanHealth(new FakeChainClient(clock), health, clock)
    assert.equal(health.snapshot().lastScanAt, null)
    await chain.listOpenMarkets()
    assert.equal(health.snapshot().lastScanAt, '1970-01-01T00:00:01.000Z')
  })
})

// R40, R47: the worker runs the relay publisher, which signs with its own relay key. The end-to-end
// check that it publishes closes and live prices is `tests/worker.test.ts` on a local validator.
describe('startWorker relay configuration', () => {
  const key = (keypair = Keypair.generate()) => JSON.stringify([...keypair.secretKey])
  const env = {
    [KEY]: key(),
    // Nothing listens here; the worker must fail on configuration before it sends anything.
    SOLANA_RPC_URL: 'http://127.0.0.1:1',
    RELAY_1_SOURCE: 'mock',
  }

  /** Starts the worker expecting a configuration error; stops it if it starts anyway. */
  async function expectStartFailure(workerEnv: NodeJS.ProcessEnv, message: RegExp) {
    let worker: ReturnType<typeof startWorker> | undefined
    try {
      worker = startWorker(createHealthState(), workerEnv, { log: () => {}, alertSinks: [] })
    } catch (error) {
      assert.match(String(error), message)
      return
    }
    worker.stop()
    await worker.done
    assert.fail(`the worker started; expected an error matching ${message}`)
  }

  it('refuses to start without RELAY_SIGNER_1_KEYPAIR', async () => {
    await expectStartFailure(env, /RELAY_SIGNER_1_KEYPAIR is not set/)
  })

  it('rejects a relay key that is not a keypair', async () => {
    await expectStartFailure({ ...env, RELAY_SIGNER_1_KEYPAIR: '[1,2,3]' }, /keypair/)
  })
})
