import type { CommandRunner } from './deploy-devnet.js'
import { DEFAULT_LOCAL_RPC_PORT, guardCluster } from './guard.js'
import { isEntryPoint, loadDotEnv, runMain, spawnRunner } from './lib/cli.js'
import { loadKeypair } from './lib/keys.js'
import { readProgramIds, type ProgramKeyDirs } from './program-keys.js'

export type DevStepId =
  | 'validator'
  | 'program-keys'
  | 'keys-sync'
  | 'build'
  | 'deploy'
  | 'bootstrap'
  | 'sample-markets'
  | 'worker'
  | 'web'

export interface DevStep {
  id: DevStepId
  command: string
  args: string[]
  env?: Record<string, string>
  /** Long-running process started in the background (validator, worker, web). */
  background?: boolean
}

export interface DevPlan {
  rpcUrl: string
  steps: DevStep[]
}

/** What `make dev ARGS='...'` can choose. */
export interface DevArgs {
  dryRun: boolean
  /** `--source <name>`: the worker's relay source; wins over `RELAY_1_SOURCE`. */
  source?: string
}

export interface DevPlanOptions {
  /** The worker's relay source; falls back to `RELAY_1_SOURCE`, then `mock`. */
  source?: string
}

export interface DevOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner
  dryRun?: boolean
  /** The worker's relay source, as `DevPlanOptions.source`. */
  source?: string
  /** Resolves once the validator answers on the RPC URL. Skipped when not given. */
  waitForRpc?: (rpcUrl: string) => Promise<void>
  log?: (line: string) => void
  /** Where the program keypairs live; the web app gets the IDs deployed from them. */
  programKeyDirs?: ProgramKeyDirs
}

/** The default validator ports, which CI and other checkouts on this machine use. */
const RESERVED_PORTS = [8899, 8900, 9900]
/** CI's validator pins gossip 9600 and the dynamic range 9601-9650 (Anchor.toml). */
const CI_GOSSIP_BLOCK = { low: 9600, high: 9650 }
/** Gossip sits this far above the RPC port, so each RPC port gets its own block. */
const GOSSIP_OFFSET = 400
/** Agave needs room for its TPU, TVU and repair sockets. */
const DYNAMIC_PORT_COUNT = 40
const LEDGER_DIR = 'test-ledger/dev'

function isReserved(port: number) {
  return (
    RESERVED_PORTS.includes(port) || (port >= CI_GOSSIP_BLOCK.low && port <= CI_GOSSIP_BLOCK.high)
  )
}

function validatorPorts(env: NodeJS.ProcessEnv) {
  const rpcPort = Number(env.LOCAL_VALIDATOR_RPC_PORT || DEFAULT_LOCAL_RPC_PORT)
  if (!Number.isInteger(rpcPort) || rpcPort < 1024 || rpcPort > 65_000) {
    throw new Error(`LOCAL_VALIDATOR_RPC_PORT must be a port number, got ${rpcPort}`)
  }
  // The validator's WebSocket listens on rpc port + 1; the faucet takes the port after that.
  // Without explicit gossip and dynamic ports Agave binds gossip 8000 and a range up to 10000,
  // which other validators on this machine and CI's reserved block use.
  const gossipPort = rpcPort + GOSSIP_OFFSET
  const dynamicPorts = { low: gossipPort + 1, high: gossipPort + DYNAMIC_PORT_COUNT }
  const ports = { rpcPort, wsPort: rpcPort + 1, faucetPort: rpcPort + 2, gossipPort }
  const used = [
    ...Object.values(ports),
    ...Array.from({ length: DYNAMIC_PORT_COUNT }, (_, i) => dynamicPorts.low + i),
  ]
  const clash = used.find(isReserved)
  if (clash !== undefined) {
    throw new Error(`LOCAL_VALIDATOR_RPC_PORT ${rpcPort} would use reserved port ${clash}`)
  }
  return { ...ports, dynamicPortRange: `${dynamicPorts.low}-${dynamicPorts.high}` }
}

/** The ordered steps of `make dev` on a local validator outside the default port block. */
export function planDev(env: NodeJS.ProcessEnv, options: DevPlanOptions = {}): DevPlan {
  void options
  const { rpcPort, faucetPort, gossipPort, dynamicPortRange } = validatorPorts(env)
  const rpcUrl = `http://127.0.0.1:${rpcPort}`
  const local = { SOLANA_CLUSTER: 'localnet', SOLANA_RPC_URL: rpcUrl }
  return {
    rpcUrl,
    steps: [
      {
        id: 'validator',
        command: 'solana-test-validator',
        args: [
          '--rpc-port',
          String(rpcPort),
          '--faucet-port',
          String(faucetPort),
          '--gossip-port',
          String(gossipPort),
          '--dynamic-port-range',
          dynamicPortRange,
          '--ledger',
          LEDGER_DIR,
          '--reset',
          '--quiet',
        ],
        background: true,
      },
      // The same long-lived program keypairs as devnet, so the IDs match everywhere.
      { id: 'program-keys', command: 'npx', args: ['tsx', 'scripts/program-keys.ts'] },
      { id: 'keys-sync', command: 'anchor', args: ['keys', 'sync'] },
      { id: 'build', command: 'anchor', args: ['build'] },
      { id: 'deploy', command: 'anchor', args: ['deploy', '--provider.cluster', rpcUrl] },
      {
        id: 'bootstrap',
        command: 'npx',
        args: ['tsx', 'scripts/bootstrap.ts', '--mock-usdc'],
        env: { ...local, DEMO_MODE: 'true' },
      },
      {
        id: 'sample-markets',
        command: 'npx',
        args: ['tsx', 'scripts/demo.ts', '--sample-markets'],
        env: local,
      },
      {
        id: 'worker',
        command: 'npm',
        args: ['run', 'start', '-w', 'services/automation'],
        env: { ...local, RELAY_1_SOURCE: 'mock', DEMO_MODE: 'true' },
        background: true,
      },
      {
        id: 'web',
        command: 'npm',
        args: ['run', 'dev', '-w', 'app'],
        env: { NEXT_PUBLIC_SOLANA_RPC_URL: rpcUrl },
        background: true,
      },
    ],
  }
}

/** Reads `--dry-run` and `--source <name>` from the command line. */
export function parseDevArgs(argv: readonly string[]): DevArgs {
  void argv
  throw new Error('parseDevArgs is not implemented')
}

function describeStep(step: DevStep) {
  const env = Object.entries(step.env ?? {}).map(([name, value]) => `${name}=${value}`)
  const suffix = step.background ? ' &' : ''
  return `[${step.id}] ${[...env, step.command, ...step.args].join(' ')}${suffix}`
}

/**
 * The env the worker and web app need from this run: the program IDs just deployed (the keypairs
 * exist only after the program-keys step) and relay signer 1's public key. The relay secret
 * never goes into a step's env, which is printed; the worker inherits it from the environment.
 */
function deployedEnv(
  step: DevStep,
  env: NodeJS.ProcessEnv,
  programKeyDirs?: ProgramKeyDirs,
): Record<string, string> | undefined {
  if (step.id !== 'worker' && step.id !== 'web') return step.env
  const ids = readProgramIds(programKeyDirs)
  if (step.id === 'worker') {
    return {
      ...step.env,
      MERIDIAN_PROGRAM_ID: ids.meridian,
      MERIDIAN_ORACLE_PROGRAM_ID: ids.meridianOracle,
    }
  }
  const relaySecret = env.RELAY_SIGNER_1_KEYPAIR?.trim()
  return {
    ...step.env,
    NEXT_PUBLIC_MERIDIAN_PROGRAM_ID: ids.meridian,
    NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID: ids.meridianOracle,
    ...(relaySecret ? { NEXT_PUBLIC_RELAY_SIGNER_1: loadKeypair(relaySecret).publicKey } : {}),
  }
}

/** Runs the plan, or only prints it when `dryRun` is set. */
export async function runDev(options: DevOptions): Promise<DevPlan> {
  const { env, runner, dryRun = false, waitForRpc, log = console.log, programKeyDirs } = options
  guardCluster(env)
  const plan = planDev(env)
  for (const planned of plan.steps) {
    if (dryRun) {
      log(describeStep(planned))
      continue
    }
    const step = { ...planned, env: deployedEnv(planned, env, programKeyDirs) }
    log(describeStep(step))
    await runner.run(step.command, step.args, { env: step.env, background: step.background })
    if (step.id === 'validator' && waitForRpc) await waitForRpc(plan.rpcUrl)
  }
  return plan
}

async function waitForValidator(rpcUrl: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      })
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Local validator did not answer on ${rpcUrl} within ${timeoutMs / 1000} s`)
}

async function main() {
  loadDotEnv()
  const dryRun = process.argv.includes('--dry-run')
  const runner = spawnRunner()
  try {
    await runDev({ env: process.env, runner, dryRun, waitForRpc: waitForValidator })
  } catch (error) {
    runner.stopAll()
    throw error
  }
  if (!dryRun) console.log('Local stack running. Press Ctrl+C to stop.')
}

if (isEntryPoint(import.meta.url)) runMain(main)
