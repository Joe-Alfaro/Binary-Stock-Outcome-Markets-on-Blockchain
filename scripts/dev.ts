import type { CommandRunner } from './deploy-devnet.js'
import { DEFAULT_LOCAL_RPC_PORT, guardCluster } from './guard.js'
import { isEntryPoint, loadDotEnv, runMain, spawnRunner } from './lib/cli.js'

export type DevStepId =
  'validator' | 'build' | 'deploy' | 'bootstrap' | 'sample-markets' | 'worker' | 'web'

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

export interface DevOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner
  dryRun?: boolean
  /** Resolves once the validator answers on the RPC URL. Skipped when not given. */
  waitForRpc?: (rpcUrl: string) => Promise<void>
  log?: (line: string) => void
}

/** The default validator ports, which CI and other checkouts on this machine use. */
const RESERVED_PORTS = [8899, 8900, 9900]
const LEDGER_DIR = 'test-ledger/dev'

function validatorPorts(env: NodeJS.ProcessEnv) {
  const rpcPort = Number(env.LOCAL_VALIDATOR_RPC_PORT || DEFAULT_LOCAL_RPC_PORT)
  if (!Number.isInteger(rpcPort) || rpcPort < 1024 || rpcPort > 65_000) {
    throw new Error(`LOCAL_VALIDATOR_RPC_PORT must be a port number, got ${rpcPort}`)
  }
  // The validator's WebSocket listens on rpc port + 1; the faucet takes the port after that.
  const ports = { rpcPort, wsPort: rpcPort + 1, faucetPort: rpcPort + 2 }
  const clash = Object.values(ports).find((port) => RESERVED_PORTS.includes(port))
  if (clash !== undefined) {
    throw new Error(`LOCAL_VALIDATOR_RPC_PORT ${rpcPort} would use reserved port ${clash}`)
  }
  return ports
}

/** The ordered steps of `make dev` on a local validator outside the default port block. */
export function planDev(env: NodeJS.ProcessEnv): DevPlan {
  const { rpcPort, faucetPort } = validatorPorts(env)
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
          '--ledger',
          LEDGER_DIR,
          '--reset',
          '--quiet',
        ],
        background: true,
      },
      { id: 'build', command: 'anchor', args: ['build'] },
      { id: 'deploy', command: 'anchor', args: ['deploy', '--provider.cluster', rpcUrl] },
      {
        id: 'bootstrap',
        command: 'npx',
        args: ['tsx', 'scripts/bootstrap.ts', '--mock-usdc'],
        env: local,
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

function describeStep(step: DevStep) {
  const env = Object.entries(step.env ?? {}).map(([name, value]) => `${name}=${value}`)
  const suffix = step.background ? ' &' : ''
  return `[${step.id}] ${[...env, step.command, ...step.args].join(' ')}${suffix}`
}

/** Runs the plan, or only prints it when `dryRun` is set. */
export async function runDev(options: DevOptions): Promise<DevPlan> {
  const { env, runner, dryRun = false, waitForRpc, log = console.log } = options
  guardCluster(env)
  const plan = planDev(env)
  for (const step of plan.steps) {
    log(describeStep(step))
    if (dryRun) continue
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
