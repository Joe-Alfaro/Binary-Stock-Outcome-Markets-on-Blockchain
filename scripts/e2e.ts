import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import type { CommandRunner } from './deploy-devnet.js'
import { guardCluster } from './guard.js'
import { isEntryPoint, runMain, spawnRunner } from './lib/cli.js'

/**
 * `make e2e` (R22, R56): a private validator, deploy, bootstrap with a mock USDC mint, one demo
 * market, the web app with the test wallet enabled, then the Playwright specs in `app/e2e`.
 *
 * The harness writes the stack file (`E2eStack` in `app/e2e/stack.ts`) before the `playwright`
 * step and stops every background process afterwards, whether the specs pass or not.
 */
export type E2eStepId =
  'build' | 'validator' | 'deploy' | 'bootstrap' | 'market' | 'web' | 'playwright'

export interface E2eStep {
  id: E2eStepId | string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Long-running process started in the background (validator, web). */
  background?: boolean
  /** Working directory, when not the repo root. */
  cwd?: string
}

export interface E2ePlan {
  rpcUrl: string
  baseUrl: string
  /** Where the harness writes the `E2eStack` JSON the specs read. */
  stackFile: string
  steps: E2eStep[]
}

export interface E2eOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner & { stopAll(): void }
  /** Resolves once the validator answers. Skipped when not given. */
  waitForRpc?: (rpcUrl: string) => Promise<void>
  /** Resolves once the web app answers. Skipped when not given. */
  waitForWeb?: (baseUrl: string) => Promise<void>
  log?: (line: string) => void
}

/**
 * Ports clear of CI's validator (8899-8900, faucet 9900, gossip 9600, dynamic 9601-9650), Agave's
 * default gossip port 8000, `make dev` (8913) and `next dev` (3000). The RPC WebSocket takes the
 * RPC port + 1, so the faucet sits one further on.
 */
const DEFAULT_PORTS = {
  E2E_RPC_PORT: '8975',
  E2E_FAUCET_PORT: '8977',
  E2E_GOSSIP_PORT: '9350',
  E2E_DYNAMIC_PORT_RANGE: '9351-9390',
  E2E_WEB_PORT: '3105',
}
const LEDGER_DIR = 'test-ledger/e2e'
const STACK_FILE = `${LEDGER_DIR}/stack.json`

function isReserved(port: number) {
  return [3000, 8000, 8899, 8900, 9900].includes(port) || (port >= 9600 && port <= 9650)
}

function port(env: NodeJS.ProcessEnv, name: keyof typeof DEFAULT_PORTS) {
  const value = Number(env[name] || DEFAULT_PORTS[name])
  if (!Number.isInteger(value) || value < 1024 || value > 65_000 || isReserved(value)) {
    throw new Error(`${name} must be a free, unreserved port number, got ${env[name]}`)
  }
  return value
}

function e2ePorts(env: NodeJS.ProcessEnv) {
  const range = env.E2E_DYNAMIC_PORT_RANGE || DEFAULT_PORTS.E2E_DYNAMIC_PORT_RANGE
  const [low = NaN, high = NaN] = range.split('-').map(Number)
  if (!(low <= high) || (low <= 9650 && high >= 9600) || (low <= 8000 && high >= 8000)) {
    throw new Error(`E2E_DYNAMIC_PORT_RANGE ${range} overlaps a reserved port`)
  }
  const ports = {
    rpc: port(env, 'E2E_RPC_PORT'),
    faucet: port(env, 'E2E_FAUCET_PORT'),
    gossip: port(env, 'E2E_GOSSIP_PORT'),
    web: port(env, 'E2E_WEB_PORT'),
    range,
  }
  if (isReserved(ports.rpc + 1) || ports.faucet === ports.rpc + 1) {
    throw new Error(`The RPC WebSocket port ${ports.rpc + 1} is reserved or taken by the faucet`)
  }
  return ports
}

/** The program ID `anchor build` compiled in: the built IDL's, else the source's `declare_id!`. */
function programId(name: 'meridian' | 'meridian_oracle') {
  const idl = `target/idl/${name}.json`
  if (existsSync(idl)) return (JSON.parse(readFileSync(idl, 'utf8')) as { address: string }).address
  const source = readFileSync(`programs/${name}/src/lib.rs`, 'utf8')
  const declared = /declare_id!\("([1-9A-HJ-NP-Za-km-z]{32,44})"\)/.exec(source)?.[1]
  if (!declared) throw new Error(`programs/${name}/src/lib.rs has no declare_id!`)
  return declared
}

/** Fresh role keys for this run only, as base58 secrets (`loadKeypair` reads them). */
function roleKeys() {
  const [admin, automation, relay] = [Keypair.generate(), Keypair.generate(), Keypair.generate()]
  const secret = (key: Keypair) => bs58.encode(key.secretKey)
  return {
    adminPublicKey: admin.publicKey.toBase58(),
    relayPublicKey: relay.publicKey.toBase58(),
    env: {
      ADMIN_KEYPAIR: secret(admin),
      // The validator loads the programs with the admin as upgrade authority (initialize_config
      // checks it), so the admin also signs as the deployer.
      ANCHOR_WALLET: secret(admin),
      AUTOMATION_KEYPAIR: secret(automation),
      RELAY_SIGNER_1_KEYPAIR: secret(relay),
      RELAY_SIGNER_2_KEYPAIR: '',
    },
  }
}

/** The ordered steps of `make e2e`. Set E2E_SKIP_BUILD=true to reuse the last `anchor build`. */
export function planE2e(env: NodeJS.ProcessEnv): E2ePlan {
  const ports = e2ePorts(env)
  const rpcUrl = `http://127.0.0.1:${ports.rpc}`
  const baseUrl = `http://127.0.0.1:${ports.web}`
  const stackFile = resolve(STACK_FILE)
  const ids = { meridian: programId('meridian'), oracle: programId('meridian_oracle') }
  const keys = roleKeys()
  const chainEnv = {
    SOLANA_CLUSTER: 'localnet',
    SOLANA_RPC_URL: rpcUrl,
    DEMO_MODE: 'true',
    MERIDIAN_PROGRAM_ID: ids.meridian,
    MERIDIAN_ORACLE_PROGRAM_ID: ids.oracle,
    ...keys.env,
  }
  const build: E2eStep[] =
    env.E2E_SKIP_BUILD === 'true'
      ? []
      : // The committed program IDs, whatever keypairs target/deploy holds; see the validator.
        [{ id: 'build', command: 'anchor', args: ['build', '--ignore-keys'] }]
  return {
    rpcUrl,
    baseUrl,
    stackFile,
    steps: [
      ...build,
      // Builds the app for production with the test wallet flag on and fails if it is bundled.
      { id: 'prod-bundle', command: 'bash', args: ['scripts/check-e2e-wallet-excluded.sh'] },
      {
        id: 'validator',
        command: 'solana-test-validator',
        args: [
          '--rpc-port',
          String(ports.rpc),
          '--faucet-port',
          String(ports.faucet),
          '--gossip-port',
          String(ports.gossip),
          '--dynamic-port-range',
          ports.range,
          '--bind-address',
          '127.0.0.1',
          '--ledger',
          LEDGER_DIR,
          '--reset',
          '--quiet',
          // Both programs at genesis under their declared IDs, so no program keypair is needed.
          '--upgradeable-program',
          ids.meridian,
          'target/deploy/meridian.so',
          keys.adminPublicKey,
          '--upgradeable-program',
          ids.oracle,
          'target/deploy/meridian_oracle.so',
          keys.adminPublicKey,
        ],
        background: true,
      },
      {
        id: 'deploy',
        command: 'npx',
        args: ['tsx', 'scripts/e2e-stack.ts', 'deploy', '--url', rpcUrl],
        env: chainEnv,
      },
      {
        id: 'bootstrap',
        command: 'npx',
        args: ['tsx', 'scripts/bootstrap.ts', '--mock-usdc'],
        env: chainEnv,
      },
      {
        id: 'market',
        command: 'npx',
        args: ['tsx', 'scripts/e2e-stack.ts', 'market'],
        env: { ...chainEnv, E2E_STACK_FILE: stackFile },
      },
      {
        id: 'web',
        // `next` itself rather than npm or npx, so stopping it stops the server.
        command: resolve('node_modules/.bin/next'),
        args: ['dev', '--webpack', '--port', String(ports.web), '--hostname', '127.0.0.1'],
        cwd: 'app',
        env: {
          NEXT_PUBLIC_SOLANA_RPC_URL: rpcUrl,
          NEXT_PUBLIC_SOLANA_WS_URL: `ws://127.0.0.1:${ports.rpc + 1}`,
          NEXT_PUBLIC_MERIDIAN_PROGRAM_ID: ids.meridian,
          NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID: ids.oracle,
          NEXT_PUBLIC_RELAY_SIGNER_1: keys.relayPublicKey,
          NEXT_PUBLIC_E2E_TEST_WALLET: 'true',
        },
        background: true,
      },
      {
        id: 'playwright',
        command: 'npx',
        args: ['playwright', 'test', '--config', 'app/playwright.config.ts'],
        env: { E2E_BASE_URL: baseUrl, E2E_STACK_FILE: stackFile },
      },
    ],
  }
}

/** Prints a step without the secret keys in its environment. */
function describeStep(step: E2eStep) {
  const env = Object.entries(step.env ?? {})
    .filter(([name]) => !name.endsWith('KEYPAIR') && name !== 'ANCHOR_WALLET')
    .map(([name, value]) => `${name}=${value}`)
  const suffix = step.background ? ' &' : ''
  const where = step.cwd ? `(in ${step.cwd}) ` : ''
  return `[${step.id}] ${where}${[...env, step.command, ...step.args].join(' ')}${suffix}`
}

/** Runs the plan and stops the validator and the web app afterwards, even when a step fails. */
export async function runE2e(options: E2eOptions): Promise<E2ePlan> {
  const { env, runner, waitForRpc, waitForWeb, log = console.log } = options
  guardCluster(env)
  const plan = planE2e(env)
  try {
    for (const step of plan.steps) {
      log(describeStep(step))
      const { env: stepEnv, background, cwd } = step
      await runner.run(step.command, step.args, { env: stepEnv, background, cwd })
      if (step.id === 'validator' && waitForRpc) await waitForRpc(plan.rpcUrl)
      if (step.id === 'web' && waitForWeb) await waitForWeb(plan.baseUrl)
    }
  } finally {
    runner.stopAll()
  }
  return plan
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return
    await new Promise((done) => setTimeout(done, 1000))
  }
  throw new Error(`${what} did not answer within ${timeoutMs / 1000} s`)
}

const waitForRpc = (rpcUrl: string) =>
  waitFor(
    `The e2e validator on ${rpcUrl}`,
    async () => {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }),
      })
      return response.ok
    },
    60_000,
  )

/** Waits until the dev server has compiled the Trade page, so the first spec doesn't. */
const waitForWeb = (baseUrl: string) =>
  waitFor(
    `The web app on ${baseUrl}`,
    async () => (await fetch(`${baseUrl}/trade/AAPL`)).ok,
    180_000,
  )

/** Fails fast when another process (another checkout's stack) holds one of the ports. */
async function assertPortsFree(ports: number[]) {
  for (const candidate of ports) {
    await new Promise<void>((done, fail) => {
      const server = createServer()
      server.once('error', () => fail(new Error(`Port ${candidate} is in use; set E2E_*_PORT`)))
      server.listen(candidate, '127.0.0.1', () => server.close(() => done()))
    })
  }
}

async function main() {
  // No .env: the e2e stack never touches devnet keys or settings.
  const ports = e2ePorts(process.env)
  await assertPortsFree([ports.rpc, ports.rpc + 1, ports.faucet, ports.gossip, ports.web])
  // solana-test-validator creates the ledger directory but not its parent.
  mkdirSync(LEDGER_DIR, { recursive: true })
  await runE2e({ env: process.env, runner: spawnRunner(), waitForRpc, waitForWeb })
}

if (isEntryPoint(import.meta.url)) runMain(main)
