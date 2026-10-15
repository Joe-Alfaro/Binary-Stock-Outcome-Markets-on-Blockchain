import { Keypair } from '@solana/web3.js'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseDevArgs, planDev, runDev, type DevStep, type DevStepId } from './dev.js'
import type { CommandRunner } from './deploy-devnet.js'
import { base58Secret } from './lib/test-support.js'
import { ensureProgramKeypairs } from './program-keys.js'

const REQUIRED_ORDER: DevStepId[] = [
  'validator',
  'deploy',
  'bootstrap',
  'sample-markets',
  'worker',
  'web',
]

function step(steps: DevStep[], id: string) {
  const found = steps.find((candidate) => candidate.id === id)
  assert.ok(found, `missing step ${id}`)
  return found
}

function argAfter(args: string[], flag: string) {
  const index = args.indexOf(flag)
  assert.ok(index >= 0, `missing ${flag} in ${args.join(' ')}`)
  return Number(args[index + 1])
}

function recordingRunner() {
  const commands: string[] = []
  const runner: CommandRunner = {
    async run(command, args) {
      commands.push([command, ...args].join(' '))
      return { stdout: '' }
    },
  }
  return { runner, commands }
}

// R60: make dev starts a validator, deploys, bootstraps a mock mint, creates sample markets, and
// starts the worker and web app.
describe('planDev (R60)', () => {
  it('runs every step in order', () => {
    const ids = planDev({}).steps.map((candidate) => candidate.id)
    const positions = REQUIRED_ORDER.map((id) => ids.indexOf(id))
    assert.ok(
      positions.every((position) => position >= 0),
      `steps: ${ids.join(', ')}`,
    )
    assert.deepEqual(
      [...positions].sort((a, b) => a - b),
      positions,
    )
  })

  it('starts the validator outside the default ports 8899, 8900 and 9900', () => {
    const validator = step(planDev({}).steps, 'validator')
    assert.equal(validator.command, 'solana-test-validator')
    assert.equal(validator.background, true)
    const rpcPort = argAfter(validator.args, '--rpc-port')
    const faucetPort = argAfter(validator.args, '--faucet-port')
    assert.ok(Number.isInteger(rpcPort) && Number.isInteger(faucetPort))
    assert.ok(![8899, 8900, 9900].includes(rpcPort), `rpc port ${rpcPort}`)
    // The websocket listens on rpc port + 1.
    assert.ok(![8899, 8900, 9900].includes(rpcPort + 1), `ws port ${rpcPort + 1}`)
    assert.ok(![8899, 8900, 9900].includes(faucetPort), `faucet port ${faucetPort}`)
  })

  it('takes the RPC port from LOCAL_VALIDATOR_RPC_PORT and points every step at it', () => {
    const plan = planDev({ LOCAL_VALIDATOR_RPC_PORT: '8973' })
    assert.equal(argAfter(step(plan.steps, 'validator').args, '--rpc-port'), 8973)
    assert.equal(plan.rpcUrl, 'http://127.0.0.1:8973')
    assert.match(step(plan.steps, 'deploy').args.join(' '), /127\.0\.0\.1:8973/)
  })

  it('bootstraps with a mock USDC mint on localnet', () => {
    const plan = planDev({})
    const bootstrap = step(plan.steps, 'bootstrap')
    assert.ok(bootstrap.args.includes('--mock-usdc'), bootstrap.args.join(' '))
    assert.equal(bootstrap.env?.SOLANA_CLUSTER, 'localnet')
    assert.equal(bootstrap.env?.SOLANA_RPC_URL, plan.rpcUrl)
  })

  // R44: the local stack runs in demo mode, so bootstrap turns it on and sample markets can use
  // custom times.
  it('bootstraps with DEMO_MODE=true', () => {
    const bootstrap = step(planDev({}).steps, 'bootstrap')
    assert.equal(bootstrap.env?.DEMO_MODE, 'true')
  })

  it('starts the worker with the mock relay source and the web app against the local RPC', () => {
    const plan = planDev({})
    const worker = step(plan.steps, 'worker')
    const web = step(plan.steps, 'web')
    assert.equal(worker.background, true)
    assert.equal(worker.env?.SOLANA_CLUSTER, 'localnet')
    assert.equal(worker.env?.SOLANA_RPC_URL, plan.rpcUrl)
    assert.equal(worker.env?.RELAY_1_SOURCE, 'mock')
    assert.equal(web.background, true)
    assert.equal(web.env?.NEXT_PUBLIC_SOLANA_RPC_URL, plan.rpcUrl)
  })
})

describe('runDev (R60, R45)', () => {
  it('prints the plan without running anything in dry-run mode', async () => {
    const { runner, commands } = recordingRunner()
    const lines: string[] = []
    const plan = await runDev({ env: {}, runner, dryRun: true, log: (line) => lines.push(line) })
    assert.deepEqual(commands, [])
    plan.steps.forEach((planned) => {
      assert.ok(
        lines.some((line) => line.includes(planned.command)),
        `dry run did not print ${planned.id}`,
      )
    })
  })

  it('refuses when the environment points at mainnet-beta', async () => {
    const { runner, commands } = recordingRunner()
    await assert.rejects(
      runDev({ env: { SOLANA_CLUSTER: 'mainnet-beta' }, runner, dryRun: true, log: () => {} }),
      /mainnet/i,
    )
    assert.deepEqual(commands, [])
  })
})

/** The ports CI's validator holds (Anchor.toml [test.validator]) and the default RPC block. */
const CI_RESERVED = (port: number) =>
  port === 8899 || port === 8900 || port === 9900 || (port >= 9600 && port <= 9650)

function portRange(args: string[], flag: string) {
  const index = args.indexOf(flag)
  assert.ok(index >= 0, `missing ${flag} in ${args.join(' ')}`)
  const match = /^(\d+)-(\d+)$/.exec(args[index + 1] ?? '')
  assert.ok(match, `${flag} takes <low>-<high>, got ${args[index + 1]}`)
  return { low: Number(match[1]), high: Number(match[2]) }
}

// R60 (validation round 1): without --gossip-port and --dynamic-port-range the validator binds
// gossip 8000 and a dynamic range up to 10000, overlapping CI's reserved 9600-9650.
describe('planDev validator ports (R60)', () => {
  it('pins the gossip port outside every reserved port', () => {
    const validator = step(planDev({}).steps, 'validator')
    const gossip = argAfter(validator.args, '--gossip-port')
    assert.ok(Number.isInteger(gossip), `gossip port ${gossip}`)
    assert.ok(!CI_RESERVED(gossip), `gossip port ${gossip} is reserved`)
    assert.notEqual(gossip, 8000, 'gossip must not take the shared default 8000')
  })

  it('pins a dynamic port range that stays clear of the reserved block', () => {
    const validator = step(planDev({}).steps, 'validator')
    const { low, high } = portRange(validator.args, '--dynamic-port-range')
    assert.ok(low < high, `range ${low}-${high}`)
    // Agave needs room for its TPU, TVU and repair sockets.
    assert.ok(high - low + 1 >= 25, `range ${low}-${high} is too narrow`)
    const overlapsReserved = Array.from({ length: high - low + 1 }, (_, i) => low + i).some(
      CI_RESERVED,
    )
    assert.ok(!overlapsReserved, `range ${low}-${high} overlaps a reserved port`)
  })

  it('keeps gossip and the dynamic range off the RPC, WebSocket and faucet ports', () => {
    const validator = step(planDev({ LOCAL_VALIDATOR_RPC_PORT: '8973' }).steps, 'validator')
    const rpc = argAfter(validator.args, '--rpc-port')
    const faucet = argAfter(validator.args, '--faucet-port')
    const gossip = argAfter(validator.args, '--gossip-port')
    const { low, high } = portRange(validator.args, '--dynamic-port-range')
    const taken = [rpc, rpc + 1, faucet]
    assert.ok(!taken.includes(gossip), `gossip ${gossip} clashes with ${taken.join(', ')}`)
    taken.forEach((port) =>
      assert.ok(port < low || port > high, `range ${low}-${high} includes port ${port}`),
    )
  })
})

/** A runner that records every command with the env it was given. */
function envRecordingRunner() {
  const runs: { command: string; args: string[]; env: Record<string, string> }[] = []
  const runner: CommandRunner = {
    async run(command, args, options) {
      runs.push({ command, args, env: { ...(options?.env ?? {}) } })
      return { stdout: '' }
    },
  }
  return { runner, runs }
}

// R60 (validation round 1): the web step passed only the RPC URL, so the app fell back to built
// or literal program IDs and had no relay signer for live prices.
describe('runDev web step configuration (R60)', () => {
  function devFixture() {
    const root = mkdtempSync(join(tmpdir(), 'meridian-dev-'))
    const dirs = { keysDir: join(root, 'keys'), deployDir: join(root, 'deploy') }
    const ids = ensureProgramKeypairs(dirs)
    const relay = Keypair.generate()
    const relaySecret = base58Secret(relay)
    return { dirs, ids, relay, relaySecret }
  }

  async function webRun() {
    const fixture = devFixture()
    const { runner, runs } = envRecordingRunner()
    await runDev({
      env: { RELAY_SIGNER_1_KEYPAIR: fixture.relaySecret },
      runner,
      programKeyDirs: fixture.dirs,
      log: () => {},
    })
    const web = runs.find((run) => run.args.join(' ') === 'run dev -w app')
    assert.ok(web, `web step never ran: ${runs.map((run) => run.command).join(', ')}`)
    return { ...fixture, web }
  }

  it('passes the program IDs the run just deployed to the web app', async () => {
    const { ids, web } = await webRun()
    assert.equal(web.env.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID, ids.meridian.toString())
    assert.equal(web.env.NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID, ids.meridianOracle.toString())
  })

  it("passes relay signer 1's public key, never its secret, to the web app", async () => {
    const { relay, relaySecret, web } = await webRun()
    assert.equal(web.env.NEXT_PUBLIC_RELAY_SIGNER_1, relay.publicKey.toBase58())
    Object.entries(web.env).forEach(([name, value]) =>
      assert.ok(!value.includes(relaySecret), `${name} leaks the relay signer secret`),
    )
  })

  it('keeps the local RPC URL for the web app', async () => {
    const { web } = await webRun()
    assert.equal(web.env.NEXT_PUBLIC_SOLANA_RPC_URL, planDev({}).rpcUrl)
  })
})

/** Test credentials; real ones never appear in tests. */
const ALPACA_KEYS = {
  ALPACA_API_KEY: 'test-key-id-PK0000',
  ALPACA_API_SECRET: 'test-secret-0000000000',
}

function assertNoAlpacaKeys(lines: string[]) {
  lines.forEach((line) =>
    Object.entries(ALPACA_KEYS).forEach(([name, value]) =>
      assert.ok(!line.includes(value), `printed ${name}: ${line}`),
    ),
  )
}

// R60, R67, D94: make dev runs the worker on a chosen relay source, so a developer can see real
// prices locally. Mock stays the default; alpaca needs its keys and they are never printed.
describe('make dev relay source (R60, R67, D94)', () => {
  it("reads --source and --dry-run from make dev's ARGS", () => {
    assert.deepEqual(parseDevArgs(['--source', 'alpaca']), { dryRun: false, source: 'alpaca' })
    assert.deepEqual(parseDevArgs(['--dry-run', '--source', 'mock']), {
      dryRun: true,
      source: 'mock',
    })
    assert.deepEqual(parseDevArgs([]), { dryRun: false })
  })

  it('refuses --source without a name', () => {
    assert.throws(() => parseDevArgs(['--source']), /--source/)
  })

  it('keeps the mock source by default, with or without the Alpaca keys', () => {
    assert.equal(step(planDev({}).steps, 'worker').env?.RELAY_1_SOURCE, 'mock')
    assert.equal(step(planDev({ ...ALPACA_KEYS }).steps, 'worker').env?.RELAY_1_SOURCE, 'mock')
  })

  it('starts the worker on alpaca, still in demo mode, when --source alpaca is given', () => {
    const worker = step(planDev({ ...ALPACA_KEYS }, { source: 'alpaca' }).steps, 'worker')
    assert.equal(worker.env?.RELAY_1_SOURCE, 'alpaca')
    assert.equal(worker.env?.DEMO_MODE, 'true')
  })

  it('starts the worker on alpaca when RELAY_1_SOURCE=alpaca is set', () => {
    const worker = step(planDev({ ...ALPACA_KEYS, RELAY_1_SOURCE: 'alpaca' }).steps, 'worker')
    assert.equal(worker.env?.RELAY_1_SOURCE, 'alpaca')
  })

  it('lets --source win over RELAY_1_SOURCE', () => {
    const worker = step(
      planDev({ ...ALPACA_KEYS, RELAY_1_SOURCE: 'alpaca' }, { source: 'mock' }).steps,
      'worker',
    )
    assert.equal(worker.env?.RELAY_1_SOURCE, 'mock')
  })

  it('refuses an unknown source, naming the valid ones', () => {
    assert.throws(() => planDev({}, { source: 'bogus' }), /bogus.*mock.*alpaca|bogus.*alpaca.*mock/)
  })

  it('refuses alpaca without its keys, naming both missing variables, before running anything', async () => {
    const { runner, commands } = recordingRunner()
    await assert.rejects(
      runDev({ env: {}, runner, source: 'alpaca', dryRun: true, log: () => {} }),
      (error: Error) =>
        /ALPACA_API_KEY/.test(error.message) && /ALPACA_API_SECRET/.test(error.message),
    )
    await assert.rejects(
      runDev({ env: { RELAY_1_SOURCE: 'alpaca' }, runner, log: () => {} }),
      /ALPACA_API_KEY/,
    )
    assert.deepEqual(commands, [])
  })

  it('names only the missing key when one of the two is set', () => {
    assert.throws(
      () => planDev({ ALPACA_API_KEY: ALPACA_KEYS.ALPACA_API_KEY }, { source: 'alpaca' }),
      (error: Error) =>
        /ALPACA_API_SECRET/.test(error.message) &&
        !/ALPACA_API_KEY\b/.test(error.message) &&
        !error.message.includes(ALPACA_KEYS.ALPACA_API_KEY),
    )
  })

  it('prints RELAY_1_SOURCE=alpaca in the dry run but never the keys', async () => {
    const { runner, commands } = recordingRunner()
    const lines: string[] = []
    await runDev({
      env: { ...ALPACA_KEYS },
      runner,
      source: 'alpaca',
      dryRun: true,
      log: (line) => lines.push(line),
    })
    assert.deepEqual(commands, [])
    const worker = lines.find((line) => line.startsWith('[worker]'))
    assert.ok(worker, `no worker line in ${lines.join('\n')}`)
    assert.match(worker, /RELAY_1_SOURCE=alpaca/)
    assertNoAlpacaKeys(lines)
  })

  it('hands the worker RELAY_1_SOURCE=alpaca and the keys from env, without printing them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'meridian-dev-'))
    const dirs = { keysDir: join(root, 'keys'), deployDir: join(root, 'deploy') }
    ensureProgramKeypairs(dirs)
    const { runner, runs } = envRecordingRunner()
    const lines: string[] = []
    await runDev({
      env: { ...ALPACA_KEYS, RELAY_1_SOURCE: 'alpaca' },
      runner,
      programKeyDirs: dirs,
      log: (line) => lines.push(line),
    })
    const worker = runs.find((run) => run.args.join(' ') === 'run start -w services/automation')
    assert.ok(worker, 'worker step never ran')
    assert.equal(worker.env.RELAY_1_SOURCE, 'alpaca')
    assert.equal(worker.env.DEMO_MODE, 'true')
    assert.equal(worker.env.ALPACA_API_KEY, ALPACA_KEYS.ALPACA_API_KEY)
    assert.equal(worker.env.ALPACA_API_SECRET, ALPACA_KEYS.ALPACA_API_SECRET)
    assertNoAlpacaKeys(lines)
    // Only the worker needs the keys.
    runs
      .filter((run) => run !== worker)
      .forEach((run) =>
        Object.values(ALPACA_KEYS).forEach((value) =>
          assert.ok(
            !Object.values(run.env).includes(value),
            `${run.command} ${run.args.join(' ')} got an Alpaca key`,
          ),
        ),
      )
  })

  // The Markets charts read the worker's /prices/intraday route; without its URL every card shows
  // "Chart unavailable", whichever source the worker runs.
  it("points the web app's charts at the local worker's price route", () => {
    const web = step(planDev({}).steps, 'web')
    assert.equal(web.env?.NEXT_PUBLIC_PRICE_API_URL, 'http://127.0.0.1:8080')
  })
})
