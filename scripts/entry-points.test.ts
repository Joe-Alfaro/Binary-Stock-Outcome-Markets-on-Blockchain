import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { REPO_ROOT } from './lib/test-support.js'

const TSX = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

/** Runs a script with a scrubbed environment so a developer's .env can't leak in. */
function runScript(script: string, args: string[], env: Record<string, string>) {
  return spawnSync(TSX, [join(REPO_ROOT, 'scripts', script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    timeout: 60_000,
  })
}

/** The recipe lines of a Makefile target. */
function recipe(makefile: string, target: string) {
  const lines = makefile.split('\n')
  const start = lines.findIndex((line) => line.startsWith(`${target}:`))
  assert.ok(start >= 0, `no ${target} target`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => !line.startsWith('\t'))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

// R45: every deploy, bootstrap and demo entry point refuses mainnet-beta when run as a command.
describe('script entry points refuse mainnet-beta (R45)', () => {
  const entryPoints: [string, string[]][] = [
    ['deploy-devnet.ts', []],
    ['bootstrap.ts', []],
    ['demo.ts', ['--dry-run']],
    ['dev.ts', ['--dry-run']],
  ]
  entryPoints.forEach(([script, args]) => {
    it(`${script} exits non-zero for SOLANA_CLUSTER=mainnet-beta`, () => {
      const result = runScript(script, args, { SOLANA_CLUSTER: 'mainnet-beta' })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /mainnet/i)
    })

    it(`${script} exits non-zero for a mainnet RPC URL`, () => {
      const result = runScript(script, args, {
        SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
      })
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /mainnet/i)
    })
  })
})

describe('dry-run entry points (R60, R61)', () => {
  it('make dev dry run prints the plan and exits cleanly', () => {
    const result = runScript('dev.ts', ['--dry-run'], {})
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /solana-test-validator/)
  })

  it('make dev dry run takes the worker port from --worker-port and points the web app at it', () => {
    const result = runScript('dev.ts', ['--dry-run', '--worker-port', '8096'], {})
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /\[worker\].*\bPORT=8096\b/)
    assert.match(result.stdout, /\[web\].*NEXT_PUBLIC_PRICE_API_URL=http:\/\/127\.0\.0\.1:8096\b/)
  })

  it('make dev dry run takes the worker port from DEV_WORKER_PORT', () => {
    const result = runScript('dev.ts', ['--dry-run'], { DEV_WORKER_PORT: '8095' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /\[worker\].*\bPORT=8095\b/)
    assert.match(result.stdout, /\[web\].*NEXT_PUBLIC_PRICE_API_URL=http:\/\/127\.0\.0\.1:8095\b/)
  })

  it('make demo dry run prints the lifecycle with explorer links and exits cleanly', () => {
    const result = runScript('demo.ts', ['--dry-run'], { SOLANA_CLUSTER: 'devnet' })
    assert.equal(result.status, 0, result.stderr)
    const links = result.stdout.match(/https:\/\/explorer\.solana\.com\/tx\/\S+/g) ?? []
    assert.ok(links.length >= 9, `expected at least 9 explorer links, got ${links.length}`)
    assert.match(result.stdout, /settlement delay/i)
  })
})

describe('Makefile targets (R59, R60, R61)', () => {
  const makefile = readFileSync(join(REPO_ROOT, 'Makefile'), 'utf8')

  const targets: [string, string][] = [
    ['dev', 'scripts/dev.ts'],
    ['deploy-devnet', 'scripts/deploy-devnet.ts'],
    ['demo', 'scripts/demo.ts'],
  ]
  targets.forEach(([target, script]) => {
    it(`make ${target} runs ${script}`, () => {
      const body = recipe(makefile, target)
      assert.ok(body.includes(script), body)
      assert.ok(!body.includes('scripts/todo.ts'), body)
      assert.ok(existsSync(join(REPO_ROOT, script)))
    })
  })
})
