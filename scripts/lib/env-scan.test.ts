import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findEnvReads, looksSecret, parseEnvFile } from './env-scan.js'
import { REPO_ROOT } from './test-support.js'

/** Set by the platform or the shell, never by the user's .env. */
const PLATFORM_VARS = new Set(['NODE_ENV', 'PORT', 'CI', 'HOME', 'PATH'])

const SOURCE_FILE = /\.(ts|tsx|js|mjs|cjs)$/
const SKIPPED = /(\.test\.tsx?$|test-support\.ts$|(^|\/)fixtures\/)/

function trackedSourceFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => SOURCE_FILE.test(path) && !SKIPPED.test(path))
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

  it('ignores lowercase properties and unrelated objects', () => {
    assert.deepEqual(findEnvReads('const x = env.cluster; const y = config.SOLANA_CLUSTER'), [])
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

  it('contains no secret-looking values', () => {
    const secrets = [...readExample().entries()]
      .filter(([name, value]) => looksSecret(name, value))
      .map(([name]) => name)
    assert.deepEqual(secrets, [])
  })
})
