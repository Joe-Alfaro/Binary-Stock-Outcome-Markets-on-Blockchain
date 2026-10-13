import { assertSafeTarget, guardCluster, type GenesisRpc } from './guard.js'
import { isEntryPoint, loadDotEnv, runMain } from './lib/cli.js'
import { explorerTxUrl } from './lib/explorer.js'
import { loadRoleKeys, type ReadFile } from './lib/keys.js'

export const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'] as const

/** Circle's devnet USDC mint, used on devnet when USDC_MINT is unset. */
export const DEVNET_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'

const USDC_DECIMALS = 6
const MAX_STALENESS_SECS = 300
/** Confidence interval at most 1% of the price. */
const MAX_CONF_BPS = 100
const ADMIN_PROPOSE_DELAY_SECS = 900
const ADMIN_FINALIZE_DELAY_SECS = 3600

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
  /** `set_demo_mode` as the admin. */
  setDemoMode(enabled: boolean): Promise<string>
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
export function buildConfigParams(keys: ConfigKeys): ConfigParams {
  return {
    admin: keys.admin,
    automationAuthority: keys.automation,
    usdcMint: keys.usdcMint,
    tickers: [...TICKERS],
    oracleSlots: [{ kind: 'MeridianRelay', signer: keys.relaySigner1 }, { kind: 'Disabled' }],
    maxStalenessSecs: MAX_STALENESS_SECS,
    maxConfBps: MAX_CONF_BPS,
    adminProposeDelaySecs: ADMIN_PROPOSE_DELAY_SECS,
    adminFinalizeDelaySecs: ADMIN_FINALIZE_DELAY_SECS,
  }
}

/** Guards the cluster, loads the role keys, initializes config and registers the relay signers. */
export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const { env, client, readFile, mockUsdc = false, log = console.log } = options
  const target = await assertSafeTarget(env, client)
  const keys = loadRoleKeys(env, readFile)
  const [relaySigner1] = keys.relaySigners
  if (!relaySigner1) throw new Error('RELAY_SIGNER_1_KEYPAIR is not set')

  const signatures: string[] = []
  const sent = (step: string, signature: string) => {
    signatures.push(signature)
    log(`${step}: ${signature} ${explorerTxUrl(signature, target)}`)
  }

  let usdcMint = env.USDC_MINT || (target.cluster === 'devnet' ? DEVNET_USDC_MINT : '')
  if (mockUsdc) {
    const created = await client.createMockUsdcMint(USDC_DECIMALS)
    usdcMint = created.mint
    sent(`mock USDC mint ${usdcMint}`, created.signature)
  }
  if (!usdcMint) throw new Error('USDC_MINT is not set; pass --mock-usdc to create a mock mint')

  const params = buildConfigParams({
    admin: keys.admin.publicKey,
    automation: keys.automation.publicKey,
    relaySigner1: relaySigner1.publicKey,
    usdcMint,
  })
  sent('initialize_config', await client.initializeConfig(params))
  for (const signer of keys.relaySigners) {
    sent(
      `register relay signer ${signer.publicKey}`,
      await client.registerRelaySigner(signer.publicKey),
    )
  }
  return { usdcMint, signatures }
}

async function main() {
  loadDotEnv()
  guardCluster(process.env)
  const { createBootstrapClient } = await import('./lib/chain.js')
  const result = await bootstrap({
    env: process.env,
    client: createBootstrapClient(process.env),
    mockUsdc: process.argv.includes('--mock-usdc'),
  })
  console.log(`USDC mint: ${result.usdcMint}`)
}

if (isEntryPoint(import.meta.url)) runMain(main)
