/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import type { BootstrapClient, BootstrapResult } from './bootstrap.js'
import { isEntryPoint, runMain } from './lib/cli.js'
import type { ReadFile } from './lib/keys.js'

export interface CommandRunner {
  run(
    command: string,
    args: string[],
    options?: { env?: Record<string, string> },
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
  readFile?: ReadFile
  mockUsdc?: boolean
  log?: (line: string) => void
}

export interface DeployResult extends BootstrapResult {
  programIds: ProgramIds
}

/** Parses the output of `anchor keys list`. */
export function parseAnchorKeysList(_stdout: string): ProgramIds {
  throw new Error('not implemented')
}

/** Sets variables in .env content, replacing existing lines and appending missing ones. */
export function updateEnvFile(_content: string, _values: Record<string, string>): string {
  throw new Error('not implemented')
}

/** Guards the cluster, builds and deploys both programs, records their IDs and bootstraps config. */
export async function deployDevnet(_options: DeployOptions): Promise<DeployResult> {
  throw new Error('not implemented')
}

async function main() {
  throw new Error('not implemented')
}

if (isEntryPoint(import.meta.url)) runMain(main)
