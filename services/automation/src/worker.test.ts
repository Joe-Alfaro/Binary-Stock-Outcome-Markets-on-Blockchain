import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import anchor from '@anchor-lang/core'
import { PriceSourceError, createMockSource } from '@meridian/price-providers'
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

// R37, R43, D93: finalize_admin_settle is admin-only, and the worker holds no admin key.
describe('the worker holds no admin key', () => {
  const sourceOf = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('reads no admin key from the environment', () => {
    const settings = loadChainSettings({
      [KEY]: '/keys/automation.json',
      ADMIN_KEYPAIR: '/keys/admin.json',
    })
    assert.equal(JSON.stringify(settings).includes('/keys/admin.json'), false)
    ;['./worker.ts', './main.ts', './jobs/settlement.ts'].forEach((path) => {
      assert.doesNotMatch(sourceOf(path), /ADMIN_KEYPAIR/, `${path} never loads the admin key`)
    })
  })

  it('gives the jobs a chain client with no finalize_admin_settle', () => {
    const clock = new FakeClock(1_000)
    const chain = withScanHealth(new FakeChainClient(clock), createHealthState(), clock)
    assert.equal('finalizeAdminSettle' in chain, false)
    assert.doesNotMatch(sourceOf('./jobs/settlement.ts'), /finalizeAdminSettle/)
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

// R32: the worker reads ORACLE_SLOT_1 and ORACLE_SLOT_2, so a slot switches by env vars alone.
describe('startWorker oracle slot configuration (R32)', () => {
  const key = (keypair = Keypair.generate()) => JSON.stringify([...keypair.secretKey])
  const env = {
    [KEY]: key(),
    RELAY_SIGNER_1_KEYPAIR: key(),
    // Nothing listens here; the worker must fail on configuration before it sends anything.
    SOLANA_RPC_URL: 'http://127.0.0.1:1',
    RELAY_1_SOURCE: 'mock',
  }

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

  it('refuses an unknown ORACLE_SLOT_1 kind', async () => {
    await expectStartFailure({ ...env, ORACLE_SLOT_1: 'switchboard' }, /ORACLE_SLOT_1/)
  })

  it('refuses ORACLE_SLOT_1=pyth without the Pyth settings, naming them', async () => {
    await expectStartFailure({ ...env, ORACLE_SLOT_1: 'pyth' }, /PYTH_/)
  })

  it('refuses ORACLE_SLOT_2=chainlink without the Data Streams settings, naming them', async () => {
    await expectStartFailure({ ...env, ORACLE_SLOT_2: 'chainlink' }, /CHAINLINK_/)
  })
})

// The worker's stop() must reach the morning job. Started between 6:00 and 8:00 AM ET on a trading
// day, the job runs at once, and its retries (here: no reachable RPC, and a source whose previous
// close fails for every ticker but AAPL) must end on stop() instead of at the 8:00 deadline.
describe('startWorker stop during the morning window', () => {
  const key = (keypair = Keypair.generate()) => JSON.stringify([...keypair.secretKey])
  const env = {
    [KEY]: key(),
    RELAY_SIGNER_1_KEYPAIR: key(),
    // Nothing listens here: every create fails and backs off.
    SOLANA_RPC_URL: 'http://127.0.0.1:1',
    RELAY_1_SOURCE: 'mock',
  }
  // 6:03 AM EDT on Tuesday 2026-10-13, a trading day.
  const SIX_OH_THREE = Date.UTC(2026, 9, 13, 10, 3)
  const MORNING_JOB_LINES = /previous close fetch failed|create_strike_market/
  const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  /** The mock source, except that previous closes fail for every ticker but AAPL. */
  function sourceFailingPreviousCloses(now: () => number) {
    const mock = createMockSource({ now })
    return {
      name: mock.name,
      prepareClose: mock.prepareClose.bind(mock),
      latest: mock.latest.bind(mock),
      previousClose: (ticker: string, previousTradingDay: string) =>
        ticker === 'AAPL'
          ? mock.previousClose(ticker, previousTradingDay)
          : Promise.reject(new PriceSourceError('http', `no previous close for ${ticker}`)),
    }
  }

  /**
   * Waits in real time until a line matches `pattern`, then until none is logged for 2.5 s: every
   * real RPC call to the dead port (about 1.5 s each here) has come back, and each loop is parked
   * on the fake clock.
   */
  async function settledAfter(lines: string[], pattern: RegExp) {
    for (let waited = 0; !lines.some((line) => pattern.test(line)) && waited < 10_000;) {
      await realDelay(100)
      waited += 100
    }
    for (let count = -1; lines.length !== count;) {
      count = lines.length
      await realDelay(2_500)
    }
  }

  it(
    'resolves done within 1 s of stop() and the morning job sends nothing after',
    { timeout: 30_000 },
    async () => {
      const clock = new FakeClock(SIX_OH_THREE)
      const lines: string[] = []
      const worker = startWorker(createHealthState(), env, {
        clock,
        log: (line) => lines.push(String(line)),
        alertSinks: [],
        source: sourceFailingPreviousCloses(() => Math.floor(clock.now() / 1000)),
      })
      // Start the morning job, then let its failed creates (real RPC calls) come back: it is now
      // in its create and previous-close backoffs.
      await clock.advanceBy(0)
      await settledAfter(lines, /create_strike_market failed/)
      assert.ok(
        lines.some((line) => /create_strike_market failed/.test(line)),
        'the morning job ran and its creates failed',
      )
      assert.ok(
        lines.some((line) => /previous close fetch failed/.test(line)),
        'the morning job is retrying previous-close fetches',
      )

      worker.stop()
      const linesAtStop = lines.length
      // The fake clock stands still: only the stop can end the job's backoff.
      const stopped = await Promise.race([
        worker.done.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ])
      const late = lines.slice(linesAtStop).filter((line) => MORNING_JOB_LINES.test(line))
      assert.equal(stopped, true, 'worker.done resolves within 1 s of stop()')
      assert.deepEqual(late, [], 'no fetch or create after stop()')
    },
  )
})
