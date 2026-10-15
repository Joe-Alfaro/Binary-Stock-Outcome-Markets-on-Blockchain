import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findEnvReads, findShellEnvReads, looksSecret, parseEnvFile } from './env-scan.js'
import { REPO_ROOT } from './test-support.js'

/**
 * Set by the platform or the shell, never by the user's .env. PORT is not one of them: the
 * worker's health server reads it, so .env.example must document it (R62).
 */
const PLATFORM_VARS = new Set(['NODE_ENV', 'CI', 'HOME', 'PATH'])

const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/
/** Shell scripts, including the extensionless Husky hooks. */
const SHELL_FILE = /(\.sh$|^\.husky\/[^_/][^/]*$)/
const SKIPPED = /(\.test\.tsx?$|test-support\.ts$|(^|\/)fixtures\/)/

function trackedFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  }).split('\n')
}

function trackedSourceFiles() {
  return trackedFiles().filter((path) => SOURCE_FILE.test(path) && !SKIPPED.test(path))
}

function trackedShellScripts() {
  return trackedFiles().filter((path) => SHELL_FILE.test(path) && !SKIPPED.test(path))
}

describe('findEnvReads (R62)', () => {
  it('finds process.env reads in dot and bracket form', () => {
    const source = `
      const a = process.env.SOLANA_RPC_URL
      const b = process.env['USDC_MINT']
      const c = process.env["DEMO_MODE"]
    `
    assert.deepEqual(findEnvReads(source).sort(), ['DEMO_MODE', 'SOLANA_RPC_URL', 'USDC_MINT'])
  })

  it('finds reads through an injected env object and destructuring', () => {
    const source = `
      function load(env: NodeJS.ProcessEnv = process.env) {
        return env.SOLANA_CLUSTER ?? env['RELAY_1_SOURCE']
      }
      const { ALERT_WEBHOOK_URL, PYTH_ACCESS_TOKEN: token } = process.env
    `
    assert.deepEqual(findEnvReads(source).sort(), [
      'ALERT_WEBHOOK_URL',
      'PYTH_ACCESS_TOKEN',
      'RELAY_1_SOURCE',
      'SOLANA_CLUSTER',
    ])
  })

  it('finds PORT in every read form, including destructuring an injected env', () => {
    const forms = [
      'const port = process.env.PORT',
      'const port = env.PORT',
      'const port = env?.PORT',
      "const port = process.env['PORT']",
      'const port = env?.["PORT"]',
      'const { PORT } = process.env',
      'const { PORT } = env',
      "const { PORT: port = '8080' } = env",
      'function listen({ PORT }: NodeJS.ProcessEnv = process.env) {}',
    ]
    const missed = forms.filter((source) => !findEnvReads(source).includes('PORT'))
    assert.deepEqual(missed, [])
  })

  it('ignores lowercase properties and unrelated objects', () => {
    assert.deepEqual(findEnvReads('const x = env.cluster; const y = config.SOLANA_CLUSTER'), [])
  })
})

describe('findShellEnvReads (R62)', () => {
  it('finds $NAME, ${NAME} and ${NAME:-default} reads', () => {
    const source = `
      echo "$SOLANA_CLUSTER"
      url=\${SOLANA_RPC_URL}
      rpc=\${VALIDATOR_RPC_PORT:-$(free_block RPC 8920 8961 3)}
      poll=\${VALIDATOR_PORT_POLL_SECONDS:-30}
      if [ -n "\${CI:-}" ]; then echo ci; fi
    `
    assert.deepEqual(findShellEnvReads(source).sort(), [
      'CI',
      'SOLANA_CLUSTER',
      'SOLANA_RPC_URL',
      'VALIDATOR_PORT_POLL_SECONDS',
      'VALIDATOR_RPC_PORT',
    ])
  })

  it("finds a read nested in another read's default", () => {
    const source = 'faucet=${VALIDATOR_FAUCET_PORT:-${E2E_FAUCET_PORT:-8977}}'
    assert.deepEqual(findShellEnvReads(source).sort(), ['E2E_FAUCET_PORT', 'VALIDATOR_FAUCET_PORT'])
  })

  it("ignores the script's own variables", () => {
    const source = `
      LIMIT_BYTES=$((1024 * 1024))
      echo "$LIMIT_BYTES"
      export BUILD_DIR=target
      echo "\${BUILD_DIR}"
      local WHAT=$1
      echo "$WHAT"
      for TICKER in AAPL MSFT; do echo "$TICKER"; done
      read -r ANSWER
      echo "\${ANSWER:-no}"
    `
    assert.deepEqual(findShellEnvReads(source), [])
  })

  it('ignores positional and special parameters and lowercase variables', () => {
    const source = `
      echo "$1 \${2} $@ $* $# $? $$ $! $0 \${10}"
      awk '{ print $1 " pid " $2 }'
      echo "\${range%-*} $rpc \${faucet:-1}"
    `
    assert.deepEqual(findShellEnvReads(source), [])
  })
})

describe('parseEnvFile (R62)', () => {
  it('reads names and values, skipping comments and blank lines', () => {
    const parsed = parseEnvFile('# comment\n\nSOLANA_CLUSTER=devnet\nUSDC_MINT=\nA=b=c\n')
    assert.deepEqual(
      [...parsed.entries()],
      [
        ['SOLANA_CLUSTER', 'devnet'],
        ['USDC_MINT', ''],
        ['A', 'b=c'],
      ],
    )
  })
})

describe('looksSecret (R62)', () => {
  it('flags any value on a secret-named variable', () => {
    assert.equal(looksSecret('CHAINLINK_HMAC_SECRET', 'abc'), true)
    assert.equal(looksSecret('PYTH_ACCESS_TOKEN', 'x'), true)
    assert.equal(looksSecret('ADMIN_KEYPAIR', '[1,2,3]'), true)
    assert.equal(looksSecret('CHAINLINK_HMAC_SECRET', ''), false)
  })

  it('flags secret-shaped values on any variable', () => {
    const base58SecretKey = '4'.repeat(88)
    assert.equal(looksSecret('SOMETHING', base58SecretKey), true)
    assert.equal(
      looksSecret('SOMETHING', JSON.stringify(Array.from({ length: 64 }, () => 7))),
      true,
    )
    assert.equal(looksSecret('SOMETHING', '-----BEGIN PRIVATE KEY-----'), true)
    assert.equal(looksSecret('ALERT_WEBHOOK_URL', 'https://user:pass@hooks.example.com/x'), true)
    assert.equal(looksSecret('SOLANA_RPC_URL', 'https://rpc.example.com/?api-key=abc123'), true)
  })

  it('allows plain settings, public keys and public URLs', () => {
    assert.equal(looksSecret('SOLANA_CLUSTER', 'devnet'), false)
    assert.equal(looksSecret('USDC_MINT', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'), false)
    assert.equal(looksSecret('SOLANA_RPC_URL', 'https://api.devnet.solana.com'), false)
    assert.equal(looksSecret('DEMO_MODE', 'false'), false)
  })
})

// R62: .env.example lists every variable the code reads and contains no secrets.
describe('.env.example (R62)', () => {
  const readExample = () => parseEnvFile(readFileSync(join(REPO_ROOT, '.env.example'), 'utf8'))

  it('lists every environment variable the source reads', () => {
    const example = readExample()
    const missing = trackedSourceFiles().flatMap((path) =>
      findEnvReads(readFileSync(join(REPO_ROOT, path), 'utf8'))
        .filter((name) => !PLATFORM_VARS.has(name) && !example.has(name))
        .map((name) => `${name} (${path})`),
    )
    assert.deepEqual(missing, [])
  })

  it('lists every environment variable the shell scripts read', () => {
    const example = readExample()
    const scripts = trackedShellScripts()
    assert.ok(scripts.includes('scripts/anchor-test.sh'), 'the scan covers scripts/anchor-test.sh')
    const missing = scripts.flatMap((path) =>
      findShellEnvReads(readFileSync(join(REPO_ROOT, path), 'utf8'))
        .filter((name) => !PLATFORM_VARS.has(name) && !example.has(name))
        .map((name) => `${name} (${path})`),
    )
    assert.deepEqual(missing, [])
  })

  it('lists the VALIDATOR_* ports and waits the Anchor test scripts read', () => {
    const reads = [
      ...findShellEnvReads(readFileSync(join(REPO_ROOT, 'scripts/anchor-test.sh'), 'utf8')),
      ...findShellEnvReads(
        readFileSync(join(REPO_ROOT, 'scripts/check-validator-ports.sh'), 'utf8'),
      ),
    ]
    const expected = [
      'VALIDATOR_DYNAMIC_PORT_RANGE',
      'VALIDATOR_FAUCET_PORT',
      'VALIDATOR_GOSSIP_PORT',
      'VALIDATOR_PORT_POLL_SECONDS',
      'VALIDATOR_PORT_WAIT_SECONDS',
      'VALIDATOR_RPC_PORT',
    ]
    assert.deepEqual(
      expected.filter((name) => !reads.includes(name)),
      [],
      'the scan finds each read in the scripts',
    )
    const example = readExample()
    assert.deepEqual(
      expected.filter((name) => !example.has(name)),
      [],
      '.env.example lists each one',
    )
  })

  it('lists PORT, which the worker health server reads', () => {
    const health = readFileSync(join(REPO_ROOT, 'services/automation/src/health.ts'), 'utf8')
    assert.ok(findEnvReads(health).includes('PORT'), 'the scan finds the PORT read in health.ts')
    assert.ok(readExample().has('PORT'), '.env.example lists PORT')
  })

  it('contains no secret-looking values', () => {
    const secrets = [...readExample().entries()]
      .filter(([name, value]) => looksSecret(name, value))
      .map(([name]) => name)
    assert.deepEqual(secrets, [])
  })
})
