import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

/** Every account of one demo market (the SDK's `MarketAccounts`), base58. */
export type StackMarket = Record<
  | 'programId'
  | 'config'
  | 'market'
  | 'usdcMint'
  | 'yesMint'
  | 'noMint'
  | 'vault'
  | 'book'
  | 'yesEscrow'
  | 'usdcEscrow',
  string
>

/**
 * What `make e2e` (`scripts/e2e.ts`) writes to `E2E_STACK_FILE` before it runs these specs: a
 * private validator with both programs deployed and bootstrapped with a mock USDC mint, one demo
 * market open for trading, one settled demo market, and two funded keypairs. Secret keys stay in
 * `test-ledger/`.
 */
export interface E2eStack {
  rpcUrl: string
  /** The open demo market's ticker; it is the only market listed for that ticker. */
  ticker: string
  market: StackMarket
  /**
   * A demo market on another ticker that settled No before the specs start. The trader holds 7
   * winning No and rests a 3 Yes ask at 60¢ in it (`scripts/e2e-stack.ts`).
   */
  settled: { ticker: string; market: StackMarket }
  /** A second wallet, with SOL and mock USDC, which trades through the SDK. */
  maker: number[]
  /** The wallet the app's test adapter connects, with SOL and mock USDC. */
  trader: number[]
}

export function loadStack(): E2eStack {
  const path = process.env.E2E_STACK_FILE
  if (!path) throw new Error('E2E_STACK_FILE is not set: run the specs with `make e2e`')
  return JSON.parse(readFileSync(path, 'utf8')) as E2eStack
}

const run = promisify(execFile)
const APP_DIR = fileURLToPath(new URL('..', import.meta.url))

async function chainOp(...args: string[]) {
  const { stdout } = await run('npx', ['tsx', 'e2e/chain-ops.ts', ...args], {
    cwd: APP_DIR,
    env: process.env,
  })
  return stdout.trim()
}

function makerOp(op: 'bid-yes' | 'ask-yes', priceCents: number, qty: number) {
  return chainOp(op, String(priceCents), String(qty))
}

/** The trader's balances in the settled market, in base units, and its resting order count. */
export interface SettledState {
  usdc: number
  yes: number
  no: number
  restingOrders: number
}

/** Reads the trader's wallet and book seat in the settled market straight from the chain. */
export async function traderSettledState(): Promise<SettledState> {
  return JSON.parse(await chainOp('trader-settled')) as SettledState
}

/** The maker rests a Yes bid through the SDK; resolves once it is confirmed. */
export function makerBidsYes(priceCents: number, qty: number) {
  return makerOp('bid-yes', priceCents, qty)
}

/** The maker mints pairs and rests their Yes as an ask at `yesAskCents` (a Buy No limit). */
export function makerAsksYes(yesAskCents: number, qty: number) {
  return makerOp('ask-yes', yesAskCents, qty)
}
