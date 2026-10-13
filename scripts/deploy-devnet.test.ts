import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  deployDevnet,
  parseAnchorKeysList,
  updateEnvFile,
  type CommandRunner,
  type ProgramIds,
} from './deploy-devnet.js'
import {
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  fakeBootstrapClient,
  roleKeyEnv,
} from './lib/test-support.js'

const MERIDIAN_ID = 'Mer1d1anProgram111111111111111111111111111'
const ORACLE_ID = 'Mer1d1anOrac1e1111111111111111111111111111'
const KEYS_LIST = `meridian: ${MERIDIAN_ID}\nmeridian_oracle: ${ORACLE_ID}\n`
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

function fakeRunner() {
  const commands: string[] = []
  const runner: CommandRunner = {
    async run(command, args) {
      const line = [command, ...args].join(' ')
      commands.push(line)
      return { stdout: line === 'anchor keys list' ? KEYS_LIST : '' }
    },
  }
  return { runner, commands }
}

describe('parseAnchorKeysList (R59)', () => {
  it('reads both program IDs', () => {
    assert.deepEqual(parseAnchorKeysList(KEYS_LIST), {
      meridian: MERIDIAN_ID,
      meridianOracle: ORACLE_ID,
    })
  })

  it('fails when a program is missing', () => {
    assert.throws(() => parseAnchorKeysList(`meridian: ${MERIDIAN_ID}\n`), /meridian_oracle/)
  })
})

describe('updateEnvFile (R59)', () => {
  it('replaces existing values, appends missing ones and keeps everything else', () => {
    const before = '# Chain\nSOLANA_CLUSTER=devnet\nMERIDIAN_PROGRAM_ID=old\n'
    const after = updateEnvFile(before, {
      MERIDIAN_PROGRAM_ID: MERIDIAN_ID,
      MERIDIAN_ORACLE_PROGRAM_ID: ORACLE_ID,
    })
    assert.equal(
      after,
      `# Chain\nSOLANA_CLUSTER=devnet\nMERIDIAN_PROGRAM_ID=${MERIDIAN_ID}\nMERIDIAN_ORACLE_PROGRAM_ID=${ORACLE_ID}\n`,
    )
  })
})

// R59: build, deploy, record program IDs, then bootstrap config and register relay signers.
describe('deployDevnet (R59, R43, R45)', () => {
  it('builds, deploys to devnet, records the IDs and bootstraps in that order', async () => {
    const { env, publicKeys } = roleKeyEnv()
    const { runner, commands } = fakeRunner()
    const fake = fakeBootstrapClient()
    const recorded: ProgramIds[] = []
    const result = await deployDevnet({
      env: { ...env, SOLANA_CLUSTER: 'devnet', USDC_MINT },
      runner,
      client: fake.client,
      recordProgramIds: async (ids) => {
        recorded.push(ids)
      },
    })

    const build = commands.indexOf('anchor build')
    const deploy = commands.findIndex(
      (line) => line.startsWith('anchor deploy') && /devnet/.test(line),
    )
    assert.ok(build >= 0, `anchor build not run: ${commands.join(' | ')}`)
    assert.ok(
      deploy > build,
      `anchor deploy to devnet not run after build: ${commands.join(' | ')}`,
    )
    assert.deepEqual(recorded, [{ meridian: MERIDIAN_ID, meridianOracle: ORACLE_ID }])
    assert.deepEqual(result.programIds, { meridian: MERIDIAN_ID, meridianOracle: ORACLE_ID })
    assert.equal(fake.configs[0]?.usdcMint, USDC_MINT)
    assert.deepEqual(fake.signers, [publicKeys.relay1, publicKeys.relay2])
  })

  it('creates a mock mint when asked', async () => {
    const { env } = roleKeyEnv()
    const fake = fakeBootstrapClient()
    const result = await deployDevnet({
      env: { ...env, SOLANA_CLUSTER: 'devnet' },
      runner: fakeRunner().runner,
      client: fake.client,
      recordProgramIds: async () => {},
      mockUsdc: true,
    })
    assert.deepEqual(fake.mintDecimals, [6])
    assert.equal(result.usdcMint, fake.configs[0]?.usdcMint)
  })

  it('fails on shared role keys before building anything', async () => {
    const { env } = roleKeyEnv()
    const { runner, commands } = fakeRunner()
    await assert.rejects(
      deployDevnet({
        env: {
          ...env,
          SOLANA_CLUSTER: 'devnet',
          USDC_MINT,
          RELAY_SIGNER_1_KEYPAIR: env.ADMIN_KEYPAIR,
        },
        runner,
        client: fakeBootstrapClient().client,
        recordProgramIds: async () => {},
      }),
      /distinct/i,
    )
    assert.deepEqual(commands, [])
  })

  const mainnetTargets: [string, NodeJS.ProcessEnv, string][] = [
    ['cluster name', { SOLANA_CLUSTER: 'mainnet-beta' }, DEVNET_GENESIS_HASH],
    ['RPC URL', { SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' }, DEVNET_GENESIS_HASH],
    ['genesis hash', { SOLANA_RPC_URL: 'https://rpc.example.com' }, MAINNET_GENESIS_HASH],
  ]
  mainnetTargets.forEach(([label, target, genesis]) => {
    it(`refuses mainnet-beta by ${label} before building or deploying`, async () => {
      const { env } = roleKeyEnv()
      const { runner, commands } = fakeRunner()
      const fake = fakeBootstrapClient(genesis)
      await assert.rejects(
        deployDevnet({
          env: { ...env, USDC_MINT, ...target },
          runner,
          client: fake.client,
          recordProgramIds: async () => {},
        }),
        /mainnet/i,
      )
      assert.deepEqual(commands, [])
      assert.equal(fake.configs.length, 0)
    })
  })
})
