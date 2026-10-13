import { Keypair } from '@solana/web3.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { deployDevnet, type CommandRunner } from './deploy-devnet.js'
import { fakeBootstrapClient, roleKeyEnv } from './lib/test-support.js'
import { PROGRAMS, ensureProgramKeypairs } from './program-keys.js'

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'meridian-program-keys-'))
  return { keysDir: join(root, 'keys'), deployDir: join(root, 'target', 'deploy') }
}

function publicKeyOf(path: string) {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[])
  return Keypair.fromSecretKey(bytes).publicKey.toBase58()
}

// R59: program IDs stay the same across builds and machines that share the keys/ keypairs.
describe('ensureProgramKeypairs (R59)', () => {
  it('generates one keypair per program and copies it to the deploy directory', () => {
    const { keysDir, deployDir } = dirs()
    const ids = ensureProgramKeypairs({ keysDir, deployDir })
    PROGRAMS.forEach((program) => {
      const stored = join(keysDir, `${program.name}-keypair.json`)
      assert.equal(publicKeyOf(stored), ids[program.id])
      assert.equal(publicKeyOf(join(deployDir, `${program.name}-keypair.json`)), ids[program.id])
      assert.equal(statSync(stored).mode & 0o077, 0, 'keypair must be private to the owner')
    })
    assert.notEqual(ids.meridian, ids.meridianOracle)
  })

  it('keeps existing keypairs, so the IDs are stable across runs', () => {
    const { keysDir, deployDir } = dirs()
    const first = ensureProgramKeypairs({ keysDir, deployDir })
    const second = ensureProgramKeypairs({ keysDir, deployDir })
    assert.deepEqual(second, first)
  })

  it('overwrites a different keypair in the deploy directory with the stored one', () => {
    const { keysDir, deployDir } = dirs()
    const ids = ensureProgramKeypairs({ keysDir, deployDir })
    const stray = join(deployDir, 'meridian-keypair.json')
    writeFileSync(stray, JSON.stringify(Array.from(Keypair.generate().secretKey)))
    ensureProgramKeypairs({ keysDir, deployDir })
    assert.equal(publicKeyOf(stray), ids.meridian)
  })

  it('rejects a malformed stored keypair instead of replacing it', () => {
    const { keysDir, deployDir } = dirs()
    mkdirSync(keysDir, { recursive: true })
    writeFileSync(join(keysDir, 'meridian-keypair.json'), '[1,2,3]')
    assert.throws(() => ensureProgramKeypairs({ keysDir, deployDir }), /meridian-keypair\.json/)
  })
})

const MERIDIAN_ID = 'Mer1d1anProgram111111111111111111111111111'
const ORACLE_ID = 'Mer1d1anOrac1e1111111111111111111111111111'

function recordingRunner() {
  const commands: string[] = []
  const runner: CommandRunner = {
    async run(command, args) {
      const line = [command, ...args].join(' ')
      commands.push(line)
      const stdout =
        line === 'anchor keys list'
          ? `meridian: ${MERIDIAN_ID}\nmeridian_oracle: ${ORACLE_ID}\n`
          : ''
      return { stdout }
    },
  }
  return { runner, commands }
}

// R59: deploys use the stored program keypairs, synced into the source before the build.
describe('deployDevnet with stable program IDs (R59)', () => {
  it('prepares the keypairs and syncs them before building', async () => {
    const { env } = roleKeyEnv()
    const { runner, commands } = recordingRunner()
    let prepared = false
    await deployDevnet({
      env: { ...env, SOLANA_CLUSTER: 'devnet' },
      runner,
      client: fakeBootstrapClient().client,
      recordProgramIds: async () => {},
      prepareProgramKeypairs: () => {
        assert.deepEqual(commands, [])
        prepared = true
        return { meridian: MERIDIAN_ID, meridianOracle: ORACLE_ID }
      },
      log: () => {},
    })
    assert.ok(prepared)
    assert.ok(commands.indexOf('anchor keys sync') >= 0)
    assert.ok(commands.indexOf('anchor keys sync') < commands.indexOf('anchor build'))
  })

  it('fails without recording when the deployed IDs differ from the stored keypairs', async () => {
    const { env } = roleKeyEnv()
    const recorded: unknown[] = []
    await assert.rejects(
      deployDevnet({
        env: { ...env, SOLANA_CLUSTER: 'devnet' },
        runner: recordingRunner().runner,
        client: fakeBootstrapClient().client,
        recordProgramIds: async (ids) => {
          recorded.push(ids)
        },
        prepareProgramKeypairs: () => ({ meridian: ORACLE_ID, meridianOracle: MERIDIAN_ID }),
        log: () => {},
      }),
      /differ/,
    )
    assert.deepEqual(recorded, [])
  })
})
