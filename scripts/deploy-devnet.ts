import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { bootstrap, type BootstrapClient, type BootstrapResult } from './bootstrap.js'
import { assertSafeTarget, guardCluster } from './guard.js'
import { isEntryPoint, loadDotEnv, runMain, spawnRunner } from './lib/cli.js'
import { loadRoleKeys, type ReadFile } from './lib/keys.js'
import { ensureProgramKeypairs } from './program-keys.js'

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; background?: boolean; cwd?: string },
  ): Promise<{ stdout: string }>
}

export interface ProgramIds {
  meridian: string
  meridianOracle: string
}

export interface DeployOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner
  client: BootstrapClient
  /** Persists the program IDs (Anchor.toml and .env in the real script). */
  recordProgramIds: (ids: ProgramIds) => Promise<void>
  /**
   * Puts the long-lived program keypairs in place and returns their IDs (the real script uses
   * `ensureProgramKeypairs`). The deployed IDs must match them.
   */
  prepareProgramKeypairs?: () => ProgramIds | Promise<ProgramIds>
  readFile?: ReadFile
  mockUsdc?: boolean
  log?: (line: string) => void
}

export interface DeployResult extends BootstrapResult {
  programIds: ProgramIds
}

/** Parses the output of `anchor keys list`. */
export function parseAnchorKeysList(stdout: string): ProgramIds {
  const ids = new Map<string, string>()
  stdout.split('\n').forEach((line) => {
    const match = /^\s*([a-z_]+)\s*:\s*([0-9A-Za-z]{32,44})\s*$/.exec(line)
    if (match) ids.set(match[1] as string, match[2] as string)
  })
  const id = (name: string) => {
    const value = ids.get(name)
    if (!value) throw new Error(`anchor keys list has no ${name} program ID`)
    return value
  }
  return { meridian: id('meridian'), meridianOracle: id('meridian_oracle') }
}

/** Sets variables in .env content, replacing existing lines and appending missing ones. */
export function updateEnvFile(content: string, values: Record<string, string>): string {
  const pending = new Map(Object.entries(values))
  const lines = content.split('\n').map((line) => {
    const name = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1]
    if (name === undefined || !pending.has(name)) return line
    const value = pending.get(name) as string
    pending.delete(name)
    return `${name}=${value}`
  })
  if (lines.at(-1) === '') lines.pop()
  pending.forEach((value, name) => lines.push(`${name}=${value}`))
  return `${lines.join('\n')}\n`
}

/** Sets the program IDs in Anchor.toml's `[programs.devnet]` section. */
export function updateAnchorToml(content: string, ids: ProgramIds): string {
  const section = /(\[programs\.devnet\][^[]*)/.exec(content)?.[1]
  if (section === undefined) throw new Error('Anchor.toml has no [programs.devnet] section')
  const updated = section
    .replace(/^meridian = ".*"$/m, `meridian = "${ids.meridian}"`)
    .replace(/^meridian_oracle = ".*"$/m, `meridian_oracle = "${ids.meridianOracle}"`)
  return content.replace(section, updated)
}

/** Guards the cluster, builds and deploys both programs, records their IDs and bootstraps config. */
export async function deployDevnet(options: DeployOptions): Promise<DeployResult> {
  const { env, runner, client, recordProgramIds, prepareProgramKeypairs, readFile, mockUsdc } =
    options
  const log = options.log ?? console.log
  const target = await assertSafeTarget(env, client)
  if (target.cluster !== 'devnet') {
    throw new Error(`deploy-devnet deploys only to devnet, not ${target.cluster}`)
  }
  // Fails on missing or shared role keys before anything is built or sent.
  loadRoleKeys(env, readFile)

  const expected = await prepareProgramKeypairs?.()
  // Points declare_id! and Anchor.toml at the program keypairs before building.
  await runner.run('anchor', ['keys', 'sync'])
  log('Building both programs')
  await runner.run('anchor', ['build'])
  log(`Deploying both programs to ${target.rpcUrl}`)
  await runner.run('anchor', ['deploy', '--provider.cluster', target.rpcUrl])
  const programIds = parseAnchorKeysList((await runner.run('anchor', ['keys', 'list'])).stdout)
  if (
    expected &&
    (expected.meridian !== programIds.meridian ||
      expected.meridianOracle !== programIds.meridianOracle)
  ) {
    throw new Error(
      `Deployed program IDs ${JSON.stringify(programIds)} differ from the keypairs in keys/ ${JSON.stringify(expected)}`,
    )
  }
  await recordProgramIds(programIds)
  log('Program IDs (recorded in .env and Anchor.toml; copy into the README):')
  log(`  meridian         ${programIds.meridian}`)
  log(`  meridian_oracle  ${programIds.meridianOracle}`)

  const result = await bootstrap({
    env: {
      ...env,
      MERIDIAN_PROGRAM_ID: programIds.meridian,
      MERIDIAN_ORACLE_PROGRAM_ID: programIds.meridianOracle,
    },
    client,
    readFile,
    mockUsdc,
    log,
  })
  return { ...result, programIds }
}

/** Writes the program IDs to Anchor.toml and .env. */
async function recordToFiles(ids: ProgramIds) {
  writeFileSync('Anchor.toml', updateAnchorToml(readFileSync('Anchor.toml', 'utf8'), ids))
  const env = existsSync('.env') ? readFileSync('.env', 'utf8') : ''
  writeFileSync(
    '.env',
    updateEnvFile(env, {
      MERIDIAN_PROGRAM_ID: ids.meridian,
      MERIDIAN_ORACLE_PROGRAM_ID: ids.meridianOracle,
      NEXT_PUBLIC_MERIDIAN_PROGRAM_ID: ids.meridian,
      NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID: ids.meridianOracle,
    }),
  )
}

async function main() {
  loadDotEnv()
  guardCluster(process.env)
  const { createBootstrapClient } = await import('./lib/chain.js')
  await deployDevnet({
    env: process.env,
    runner: spawnRunner(),
    client: createBootstrapClient(process.env),
    recordProgramIds: recordToFiles,
    prepareProgramKeypairs: () => ensureProgramKeypairs(),
    mockUsdc: process.argv.includes('--mock-usdc'),
  })
}

if (isEntryPoint(import.meta.url)) runMain(main)
