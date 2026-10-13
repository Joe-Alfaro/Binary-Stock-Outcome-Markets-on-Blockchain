import type { CommandRunner } from './deploy-devnet.js'

/**
 * `make e2e` (R22, R56): a private validator, deploy, bootstrap with a mock USDC mint, one demo
 * market, the web app with the test wallet enabled, then the Playwright specs in `app/e2e`.
 *
 * The harness writes the stack file (`E2eStack` in `app/e2e/stack.ts`) before the `playwright`
 * step and stops every background process afterwards, whether the specs pass or not.
 */
export type E2eStepId = 'validator' | 'deploy' | 'bootstrap' | 'market' | 'web' | 'playwright'

export interface E2eStep {
  id: E2eStepId | string
  command: string
  args: string[]
  env?: Record<string, string>
  /** Long-running process started in the background (validator, web). */
  background?: boolean
}

export interface E2ePlan {
  rpcUrl: string
  baseUrl: string
  /** Where the harness writes the `E2eStack` JSON the specs read. */
  stackFile: string
  steps: E2eStep[]
}

export interface E2eOptions {
  env: NodeJS.ProcessEnv
  runner: CommandRunner & { stopAll(): void }
  /** Resolves once the validator answers. Skipped when not given. */
  waitForRpc?: (rpcUrl: string) => Promise<void>
  /** Resolves once the web app answers. Skipped when not given. */
  waitForWeb?: (baseUrl: string) => Promise<void>
  log?: (line: string) => void
}

// Stub: the e2e implementation package fills these in.
export function planE2e(env: NodeJS.ProcessEnv): E2ePlan {
  void env
  throw new Error('planE2e is not implemented')
}

export async function runE2e(options: E2eOptions): Promise<E2ePlan> {
  void options
  throw new Error('runE2e is not implemented')
}
