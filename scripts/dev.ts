/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import type { CommandRunner } from './deploy-devnet.js'
import { isEntryPoint, runMain } from './lib/cli.js'

export type DevStepId =
  'validator' | 'build' | 'deploy' | 'bootstrap' | 'sample-markets' | 'worker' | 'web'

export interface DevStep {
  id: DevStepId
  command: string
  args: string[]
  env?: Record<string, string>
  /** Long-running process started in the background (validator, worker, web). */
  background?: boolean
}

export interface DevPlan {
  rpcUrl: string
  steps: DevStep[]
}

export interface DevOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner
  dryRun?: boolean
  log?: (line: string) => void
}

/** The ordered steps of `make dev` on a local validator outside the default port block. */
export function planDev(_env: NodeJS.ProcessEnv): DevPlan {
  throw new Error('not implemented')
}

/** Runs the plan, or only prints it when `dryRun` is set. */
export async function runDev(_options: DevOptions): Promise<DevPlan> {
  throw new Error('not implemented')
}

async function main() {
  throw new Error('not implemented')
}

if (isEntryPoint(import.meta.url)) runMain(main)
