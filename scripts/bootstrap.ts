/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import type { GenesisRpc } from './guard.js'
import { isEntryPoint, runMain } from './lib/cli.js'
import type { ReadFile } from './lib/keys.js'

export const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'] as const

export type OracleSlotParams = { kind: 'MeridianRelay'; signer: string } | { kind: 'Disabled' }

/** Arguments to `initialize_config`. Public keys are base58 strings. */
export interface ConfigParams {
  admin: string
  automationAuthority: string
  usdcMint: string
  tickers: string[]
  oracleSlots: [OracleSlotParams, OracleSlotParams]
  maxStalenessSecs: number
  maxConfBps: number
  adminProposeDelaySecs: number
  adminFinalizeDelaySecs: number
}

/** Chain calls the bootstrap makes. Each send returns a confirmed transaction signature. */
export interface BootstrapClient extends GenesisRpc {
  createMockUsdcMint(decimals: number): Promise<{ mint: string; signature: string }>
  initializeConfig(params: ConfigParams): Promise<string>
  registerRelaySigner(signer: string): Promise<string>
}

export interface ConfigKeys {
  admin: string
  automation: string
  relaySigner1: string
  usdcMint: string
}

export interface BootstrapOptions {
  env: NodeJS.ProcessEnv
  client: BootstrapClient
  readFile?: ReadFile
  /** Create a mock 6-decimal USDC mint instead of using USDC_MINT. */
  mockUsdc?: boolean
  log?: (line: string) => void
}

export interface BootstrapResult {
  usdcMint: string
  signatures: string[]
}

/** Config for a fresh deploy: slot 1 MeridianRelay with the relay signer, slot 2 Disabled. */
export function buildConfigParams(_keys: ConfigKeys): ConfigParams {
  throw new Error('not implemented')
}

/** Guards the cluster, loads the role keys, initializes config and registers the relay signers. */
export async function bootstrap(_options: BootstrapOptions): Promise<BootstrapResult> {
  throw new Error('not implemented')
}

async function main() {
  throw new Error('not implemented')
}

if (isEntryPoint(import.meta.url)) runMain(main)
