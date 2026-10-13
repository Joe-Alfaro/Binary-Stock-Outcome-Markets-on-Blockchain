import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { planDev, runDev, type DevStep, type DevStepId } from './dev.js'
import type { CommandRunner } from './deploy-devnet.js'

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
