import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Keypair } from '@solana/web3.js'
import { REPO_ROOT } from './lib/test-support.js'

// R65: the automation service as Railway builds it. A deploy is a clean checkout (no `target/`,
// which `anchor build` writes and git ignores) plus the service's build command, then its start
// command. The worker must find both program IDLs there.

const SERVICE = 'services/automation'
const BUILD_TIMEOUT_MS = 5 * 60_000
const START_TIMEOUT_MS = 45_000
/** How long the worker must stay up after its health check first answers. */
const STAY_UP_MS = 8_000

interface RailwayConfig {
  build?: { buildCommand?: string }
  deploy?: { startCommand?: string; healthcheckPath?: string }
}

interface IdlShape {
  address: string
  instructions: unknown[]
  accounts?: unknown[]
  types?: unknown[]
}

/** Tracked files plus new, not ignored ones: what a clean checkout of this tree holds. */
function cleanCheckout(): string {
  const dir = mkdtempSync(join(tmpdir(), 'automation-deploy-'))
  const files = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
    .split('\0')
    .filter((file) => file !== '' && existsSync(join(REPO_ROOT, file)))
  files.forEach((file) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    cpSync(join(REPO_ROOT, file), join(dir, file))
  })
  return dir
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/** The environment a deploy sets, with nothing pointing at a local build. */
function deployEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra }
  for (const name of [
    'MERIDIAN_IDL_PATH',
    'MERIDIAN_PROGRAM_ID',
    'MERIDIAN_ORACLE_PROGRAM_ID',
    'ANCHOR_PROVIDER_URL',
    'ANCHOR_WALLET',
  ]) {
    delete env[name]
  }
  return env
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('automation deploy from a clean checkout (R65)', { timeout: BUILD_TIMEOUT_MS * 2 }, () => {
  let dir: string
  let config: RailwayConfig

  before(() => {
    dir = cleanCheckout()
    config = JSON.parse(readFileSync(join(dir, SERVICE, 'railway.json'), 'utf8')) as RailwayConfig
    assert.equal(existsSync(join(dir, 'target')), false, 'the clean checkout has no target/')
    const build = config.build?.buildCommand
    assert.ok(build, 'the automation service has a build command')
    execFileSync('sh', ['-c', build], {
      cwd: dir,
      // The npm cache only speeds up the install; the build command itself is unchanged.
      env: { ...deployEnv({}), npm_config_prefer_offline: 'true' },
      stdio: 'ignore',
      timeout: BUILD_TIMEOUT_MS,
    })
  })

  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('starts the worker and keeps it up, with its health check answering', async () => {
    const start = config.deploy?.startCommand
    assert.ok(start, 'the automation service has a start command')
    const key = () => JSON.stringify([...Keypair.generate().secretKey])
    const port = await freePort()
    const child: ChildProcess = spawn('sh', ['-c', start], {
      cwd: dir,
      detached: true,
      env: deployEnv({
        PORT: String(port),
        AUTOMATION_KEYPAIR: key(),
        RELAY_SIGNER_1_KEYPAIR: key(),
        RELAY_1_SOURCE: 'mock',
        // Nothing listens here: the worker retries its RPC calls but must not crash on start.
        SOLANA_RPC_URL: 'http://127.0.0.1:1',
        SOLANA_CLUSTER: 'localnet',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()))
    let exitCode: number | null | undefined
    child.on('exit', (code) => (exitCode = code ?? -1))

    try {
      const deadline = Date.now() + START_TIMEOUT_MS
      let healthy = false
      while (!healthy && exitCode === undefined && Date.now() < deadline) {
        healthy = await fetch(`http://127.0.0.1:${port}${config.deploy?.healthcheckPath}`)
          .then((response) => response.ok)
          .catch(() => false)
        if (!healthy) await sleep(500)
      }
      assert.ok(healthy, `no health check answer; worker output:\n${output.slice(-2000)}`)
      await sleep(STAY_UP_MS)
      assert.equal(
        exitCode,
        undefined,
        `the worker exited after starting; output:\n${output.slice(-2000)}`,
      )
      assert.doesNotMatch(output, /ENOENT|no meridian_oracle IDL|anchor build/)
    } finally {
      if (child.pid && exitCode === undefined) process.kill(-child.pid, 'SIGKILL')
    }
  })

  it('ships both IDLs where the worker loads them by default, matching the programs', () => {
    // Run inside the built checkout, from the service directory as its start command does.
    const script = `
      import { loadMeridianIdl } from './src/chain/index.js'
      import { loadOracleIdl } from './src/relay/oracle-client.js'
      console.log(JSON.stringify({ meridian: loadMeridianIdl(), oracle: loadOracleIdl() }))
    `
    const out = execFileSync('node', ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: join(dir, SERVICE),
      env: deployEnv({}),
      encoding: 'utf8',
    })
    const shipped = JSON.parse(out) as Record<'meridian' | 'oracle', IdlShape>
    for (const [name, idl] of Object.entries(shipped)) {
      assert.match(idl.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, `${name} IDL address`)
      assert.ok(idl.instructions.length > 0, `${name} IDL instructions`)
    }
    const names = (idl: IdlShape) =>
      idl.instructions.map((instruction) => (instruction as { name: string }).name)
    assert.ok(names(shipped.meridian).includes('settle_market'))
    assert.ok(names(shipped.oracle).includes('publish_close'))
    assert.ok(names(shipped.oracle).includes('publish_latest'))

    // When this checkout has a fresh `anchor build`, the shipped IDLs must not have drifted from
    // it. Addresses differ per machine (`anchor keys sync`), so only the interface is compared.
    const built = (file: string) => join(REPO_ROOT, 'target/idl', file)
    const pairs = [
      ['meridian', built('meridian.json')],
      ['oracle', built('meridian_oracle.json')],
    ] as const
    for (const [name, path] of pairs) {
      if (!existsSync(path)) continue
      const local = JSON.parse(readFileSync(path, 'utf8')) as IdlShape
      const ship = shipped[name]
      assert.deepEqual(ship.instructions, local.instructions, `${name} instructions drifted`)
      assert.deepEqual(ship.accounts, local.accounts, `${name} accounts drifted`)
      assert.deepEqual(ship.types, local.types, `${name} types drifted`)
    }
  })
})
