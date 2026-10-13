/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import type { GenesisRpc } from './guard.js'
import { isEntryPoint, runMain } from './lib/cli.js'

export type TradePath = 'buy-yes' | 'sell-yes' | 'buy-no' | 'sell-no'

export const TRADE_PATHS: readonly TradePath[] = ['buy-yes', 'sell-yes', 'buy-no', 'sell-no']

export type Commitment = 'processed' | 'confirmed' | 'finalized'

/** Chain calls the demo makes. Each send returns its signature; `confirm` waits for it. */
export interface DemoClient extends GenesisRpc {
  createDemoMarket(params: {
    ticker: string
    closeTs: number
  }): Promise<{ market: string; signature: string }>
  mintPair(market: string, quantity: number): Promise<string>
  trade(market: string, path: TradePath, quantity: number): Promise<string>
  /** Publishes the replayed recorded close through the relay signer. */
  publishRelayClose(market: string): Promise<string>
  settle(market: string): Promise<string>
  redeem(market: string): Promise<string>
  confirm(signature: string, commitment: Commitment): Promise<void>
}

export interface DemoOptions {
  env: NodeJS.ProcessEnv
  client: DemoClient
  /** Wall clock in milliseconds. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
}

export interface DemoTransaction {
  step: string
  signature: string
  explorerUrl: string
  confirmMs: number
}

export interface DemoResult {
  market: string
  closeTs: number
  transactions: DemoTransaction[]
  /** Seconds from close_ts until the settle transaction was confirmed. */
  settlementDelaySecs: number
}

/** A client that sends nothing and returns made-up signatures, for `--dry-run`. */
export function createDryRunClient(): DemoClient {
  throw new Error('not implemented')
}

/** Runs create → mint → all 4 trade paths → settle via the relay → redeem, in demo mode. */
export async function runDemo(_options: DemoOptions): Promise<DemoResult> {
  throw new Error('not implemented')
}

async function main() {
  throw new Error('not implemented')
}

if (isEntryPoint(import.meta.url)) runMain(main)
