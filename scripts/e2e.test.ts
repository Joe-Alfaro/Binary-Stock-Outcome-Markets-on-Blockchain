import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import type { CommandRunner } from './deploy-devnet.js'
import { planE2e, runE2e, type E2eStep } from './e2e.js'

const REQUIRED_ORDER = ['validator', 'deploy', 'bootstrap', 'market', 'web', 'playwright']

/** CI's validator block and Agave's default gossip port, which other validators on this Mac use. */
function reserved(port: number) {
  return [8000, 8899, 8900, 9900].includes(port) || (port >= 9600 && port <= 9650) || port === 3000
}

const PORTS = {
  E2E_RPC_PORT: '8975',
  E2E_FAUCET_PORT: '8977',
  E2E_GOSSIP_PORT: '9350',
  E2E_DYNAMIC_PORT_RANGE: '9351-9390',
  E2E_WEB_PORT: '3105',
}

function step(steps: E2eStep[], id: string) {
  const found = steps.find((candidate) => candidate.id === id)
  assert.ok(found, `missing step ${id}`)
  return found
}

function argAfter(args: string[], flag: string) {
  const index = args.indexOf(flag)
  assert.ok(index >= 0, `missing ${flag} in ${args.join(' ')}`)
  return args[index + 1] ?? ''
}

function validatorPorts(args: string[]) {
  const [low, high] = argAfter(args, '--dynamic-port-range').split('-').map(Number)
  return {
    rpc: Number(argAfter(args, '--rpc-port')),
    faucet: Number(argAfter(args, '--faucet-port')),
    gossip: Number(argAfter(args, '--gossip-port')),
    low: low ?? NaN,
    high: high ?? NaN,
  }
}

function recordingRunner(failOn?: string) {
  const commands: string[] = []
  let stops = 0
  const runner: CommandRunner & { stopAll(): void } = {
    async run(command, args) {
      const line = [command, ...args].join(' ')
      commands.push(line)
      if (failOn && line.includes(failOn)) throw new Error(`${failOn} failed`)
      return { stdout: '' }
    },
    stopAll() {
      stops += 1
    },
  }
  return { runner, commands, stops: () => stops }
}

// R22, R56: the e2e harness brings up a private local stack for the Playwright specs.
describe('planE2e (R22, R56)', () => {
  it('starts a validator, deploys, bootstraps, creates a market and starts the web app, in order, before Playwright', () => {
    const ids = planE2e(PORTS).steps.map((candidate) => String(candidate.id))
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

  it('runs its validator on the given ports, with explicit gossip and dynamic ports', () => {
    const validator = step(planE2e(PORTS).steps, 'validator')
    assert.equal(validator.command, 'solana-test-validator')
    assert.equal(validator.background, true)
    assert.deepEqual(validatorPorts(validator.args), {
      rpc: 8975,
      faucet: 8977,
      gossip: 9350,
      low: 9351,
      high: 9390,
    })
    assert.ok(validator.args.includes('--reset'), validator.args.join(' '))
  })

  it('by default keeps every validator port clear of the reserved blocks', () => {
    const plan = planE2e({})
    const ports = validatorPorts(step(plan.steps, 'validator').args)
    // The websocket listens on rpc port + 1, so the faucet can't take it.
    assert.notEqual(ports.faucet, ports.rpc + 1)
    const all = [ports.rpc, ports.rpc + 1, ports.faucet, ports.gossip]
    all.forEach((port) => assert.ok(!reserved(port), `port ${port} is reserved`))
    assert.ok(ports.low <= ports.high, `range ${ports.low}-${ports.high}`)
    assert.ok(
      ports.high < 9600 || ports.low > 9650,
      `dynamic range ${ports.low}-${ports.high} overlaps 9600-9650`,
    )
    assert.ok(ports.low > 8000 || ports.high < 8000, 'dynamic range covers 8000')
  })

  it('points deploy, bootstrap and the market step at its own validator, with a mock USDC mint', () => {
    const plan = planE2e(PORTS)
    assert.equal(plan.rpcUrl, 'http://127.0.0.1:8975')
    assert.match(step(plan.steps, 'deploy').args.join(' '), /127\.0\.0\.1:8975/)
    const bootstrap = step(plan.steps, 'bootstrap')
    assert.ok(bootstrap.args.includes('--mock-usdc'), bootstrap.args.join(' '))
    assert.equal(bootstrap.env?.SOLANA_CLUSTER, 'localnet')
    assert.equal(bootstrap.env?.SOLANA_RPC_URL, plan.rpcUrl)
    assert.equal(step(plan.steps, 'market').env?.SOLANA_RPC_URL, plan.rpcUrl)
  })

  it('starts the web app in development mode on the e2e port with the test wallet enabled', () => {
    const plan = planE2e(PORTS)
    const web = step(plan.steps, 'web')
    assert.equal(web.background, true)
    assert.equal(plan.baseUrl, 'http://127.0.0.1:3105')
    assert.match([web.command, ...web.args].join(' '), /\bdev\b/)
    assert.doesNotMatch([web.command, ...web.args].join(' '), /\b(build|start)\b/)
    assert.match([...web.args, ...Object.values(web.env ?? {})].join(' '), /\b3105\b/)
    assert.equal(web.env?.NEXT_PUBLIC_SOLANA_RPC_URL, plan.rpcUrl)
    assert.equal(web.env?.NEXT_PUBLIC_E2E_TEST_WALLET, 'true')
    // The ID the deploy step used, so the app never falls back to a stale or built-in one.
    assert.ok(web.env?.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID, 'no program ID passed to the web app')
    assert.ok(web.env?.NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID, 'no oracle program ID passed')
  })

  it('runs the Playwright specs against the web app and the stack file', () => {
    const plan = planE2e(PORTS)
    const playwright = step(plan.steps, 'playwright')
    assert.match([playwright.command, ...playwright.args].join(' '), /playwright test|test:e2e/)
    assert.equal(playwright.env?.E2E_BASE_URL, plan.baseUrl)
    assert.equal(playwright.env?.E2E_STACK_FILE, plan.stackFile)
    assert.match(plan.stackFile, /test-ledger\//)
  })
})

describe('runE2e (R22, R56)', () => {
  it('refuses when the environment points at mainnet-beta', async () => {
    const { runner, commands } = recordingRunner()
    await assert.rejects(
      runE2e({ env: { ...PORTS, SOLANA_CLUSTER: 'mainnet-beta' }, runner, log: () => {} }),
      /mainnet/i,
    )
    assert.deepEqual(commands, [])
  })

  it('stops the validator and the web app after the specs, even when they fail', async () => {
    const { runner, commands, stops } = recordingRunner('playwright')
    await assert.rejects(runE2e({ env: PORTS, runner, log: () => {} }), /playwright failed/)
    assert.ok(commands.some((line) => line.startsWith('solana-test-validator')))
    assert.ok(stops() >= 1, 'background processes left running')
  })
})

describe('make e2e (R22, R56)', () => {
  it('has a Makefile target that runs the harness', () => {
    const makefile = readFileSync(new URL('../Makefile', import.meta.url), 'utf8')
    assert.match(makefile, /^\.PHONY:.*\be2e\b/m)
    assert.match(makefile, /^e2e:\s*\n(\t.*\n)*\t.*scripts\/e2e\.ts/m)
  })
})
