import { assertDemoCluster, assertSafeTarget, guardCluster, type GenesisRpc } from './guard.js'
import { isEntryPoint, loadDotEnv, runMain } from './lib/cli.js'
import { explorerTxUrl } from './lib/explorer.js'

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

/** The ticker the demo trades; the mock relay source has a recorded close for it. */
export const DEMO_TICKER = 'AAPL'
/** Seconds from market creation to its demo close_ts, enough for the mint and four trades. */
const DEMO_CLOSE_LEAD_SECS = 90
/** Sample markets for `make dev` close later, so there is time to trade in the web app. */
const SAMPLE_CLOSE_LEAD_SECS = 30 * 60
const SAMPLE_TICKERS = ['AAPL', 'MSFT']
const PAIRS = 10
const TRADE_QUANTITY = 1
/** Solana finality is sub-second at `confirmed`; the demo doesn't wait for `finalized`. */
const COMMITMENT: Commitment = 'confirmed'

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A client that sends nothing and returns made-up signatures, for `--dry-run`. */
export function createDryRunClient(): DemoClient {
  let counter = 0
  const signature = (step: string) => {
    counter += 1
    return `dryrun${counter}${step.replace(/[^a-z]/gi, '')}`
  }
  return {
    async getGenesisHash() {
      // Devnet's, so the guard passes without a network call.
      return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    },
    async createDemoMarket({ ticker }) {
      return { market: `DryRun${ticker}Market`, signature: signature('create') }
    },
    async mintPair() {
      return signature('mint')
    },
    async trade(_market, path) {
      return signature(path)
    },
    async publishRelayClose() {
      return signature('publish')
    },
    async settle() {
      return signature('settle')
    },
    async redeem() {
      return signature('redeem')
    },
    async confirm() {},
  }
}

/** Runs create → mint → all 4 trade paths → settle via the relay → redeem, in demo mode. */
export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  const { env, client, now = Date.now, sleep = realSleep, log = console.log } = options
  const target = await assertSafeTarget(env, client)
  assertDemoCluster(target.cluster)

  const transactions: DemoTransaction[] = []
  /** Confirms a sent transaction, prints it and returns the time it was confirmed. */
  const confirm = async (step: string, signature: string) => {
    const sentAt = now()
    await client.confirm(signature, COMMITMENT)
    const confirmedAt = now()
    const tx = {
      step,
      signature,
      explorerUrl: explorerTxUrl(signature, target),
      confirmMs: confirmedAt - sentAt,
    }
    transactions.push(tx)
    log(`${step.padEnd(8)} ${signature} confirmed in ${tx.confirmMs} ms  ${tx.explorerUrl}`)
    return confirmedAt
  }

  const closeTs = Math.ceil(now() / 1000) + DEMO_CLOSE_LEAD_SECS
  log(
    `Demo market ${DEMO_TICKER} on ${target.cluster}, close_ts ${new Date(closeTs * 1000).toISOString()}`,
  )
  const created = await client.createDemoMarket({ ticker: DEMO_TICKER, closeTs })
  await confirm('create', created.signature)
  const { market } = created

  await confirm('mint', await client.mintPair(market, PAIRS))
  for (const path of TRADE_PATHS) {
    await confirm(path, await client.trade(market, path, TRADE_QUANTITY))
  }

  const waitMs = closeTs * 1000 - now()
  if (waitMs > 0) {
    log(`Waiting ${Math.ceil(waitMs / 1000)} s for close_ts`)
    await sleep(waitMs)
  }
  await confirm('publish', await client.publishRelayClose(market))
  const settledAt = await confirm('settle', await client.settle(market))
  const settlementDelaySecs = (settledAt - closeTs * 1000) / 1000
  log(`Settlement delay from close_ts: ${settlementDelaySecs.toFixed(2)} s`)
  await confirm('redeem', await client.redeem(market))

  return { market, closeTs, transactions, settlementDelaySecs }
}

/** Creates a demo market per sample ticker for `make dev`, closing in 30 minutes. */
export async function createSampleMarkets(options: DemoOptions): Promise<string[]> {
  const { env, client, now = Date.now, log = console.log } = options
  const target = await assertSafeTarget(env, client)
  assertDemoCluster(target.cluster)
  const closeTs = Math.ceil(now() / 1000) + SAMPLE_CLOSE_LEAD_SECS
  const markets: string[] = []
  for (const ticker of SAMPLE_TICKERS) {
    const { market, signature } = await client.createDemoMarket({ ticker, closeTs })
    await client.confirm(signature, COMMITMENT)
    log(`Sample market ${ticker} ${market}: ${explorerTxUrl(signature, target)}`)
    markets.push(market)
  }
  return markets
}

/** A clock that only moves when the dry run sleeps, so it never waits for close_ts. */
function virtualClock() {
  let current = Date.now()
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms
    },
  }
}

async function main() {
  loadDotEnv()
  guardCluster(process.env)
  if (process.argv.includes('--dry-run')) {
    await runDemo({ env: process.env, client: createDryRunClient(), ...virtualClock() })
    return
  }
  const { createDemoClient } = await import('./lib/chain.js')
  const client = createDemoClient(process.env)
  if (process.argv.includes('--sample-markets')) {
    await createSampleMarkets({ env: process.env, client })
    return
  }
  await runDemo({ env: process.env, client })
}

if (isEntryPoint(import.meta.url)) runMain(main)
