import { assertDemoCluster, assertSafeTarget, guardCluster, type GenesisRpc } from './guard.js'
import { isEntryPoint, loadDotEnv, runMain } from './lib/cli.js'
import { explorerTxUrl } from './lib/explorer.js'

export type TradePath = 'buy-yes' | 'sell-yes' | 'buy-no' | 'sell-no'

export const TRADE_PATHS: readonly TradePath[] = ['buy-yes', 'sell-yes', 'buy-no', 'sell-no']

export type Commitment = 'processed' | 'confirmed' | 'finalized'

/**
 * The counterparty's quote for each path, in cents per Yes: an ask for Buy Yes and Sell No to take,
 * a bid for Sell Yes and Buy No to hit. Buy No pays 100 − 40 = 60¢ a No; Sell No gets 40¢.
 */
export const QUOTE_PRICES: Record<TradePath, number> = {
  'buy-yes': 55,
  'sell-yes': 45,
  'buy-no': 40,
  'sell-no': 60,
}

/**
 * Whole tokens per path. The trader buys 2 Yes and sells them, so it holds no Yes when Buy No
 * runs (R28), then buys 2 No and sells 1, keeping one No for the redeem.
 */
export const TRADE_QUANTITIES: Record<TradePath, number> = {
  'buy-yes': 2,
  'sell-yes': 2,
  'buy-no': 2,
  'sell-no': 1,
}

/** A wallet's balances in one market, in base units (6 decimals for USDC, Yes and No). */
export interface WalletBalances {
  usdc: bigint
  yes: bigint
  no: bigint
}

/** The demo's two wallets: the trader runs the four paths, the counterparty quotes them. */
export interface DemoBalances {
  trader: WalletBalances
  counterparty: WalletBalances
}

/** Chain calls the demo makes. Each send returns its signature; `confirm` waits for it. */
export interface DemoClient extends GenesisRpc {
  createDemoMarket(params: {
    ticker: string
    closeTs: number
  }): Promise<{ market: string; signature: string }>
  /** The counterparty mints the pairs it quotes from. */
  mintPair(market: string, quantity: number): Promise<string>
  /** The counterparty rests the order that the trader's `path` fills against. */
  quote(market: string, path: TradePath, quantity: number): Promise<string>
  trade(market: string, path: TradePath, quantity: number): Promise<string>
  /** Both wallets' balances in the market. */
  balances(market: string): Promise<DemoBalances>
  /** Publishes the replayed recorded close through the relay signer. */
  publishRelayClose(market: string): Promise<string>
  settle(market: string): Promise<string>
  redeem(market: string): Promise<string>
  confirm(signature: string, commitment: Commitment): Promise<void>
  /**
   * The validator's clock in Unix seconds (the Clock sysvar's `unix_timestamp`). The program checks
   * `close_ts` against it, and it can run behind the wall clock.
   */
  chainNow(): Promise<number>
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
  /** Both wallets' balances once the step confirmed. */
  balances?: DemoBalances
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
/** Base units per whole token and per dollar (6 decimals). */
const UNIT = 1_000_000n
/** Solana finality is sub-second at `confirmed`; the demo doesn't wait for `finalized`. */
const COMMITMENT: Commitment = 'confirmed'

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const wallet = (usdc: bigint): WalletBalances => ({ usdc, yes: 0n, no: 0n })

function move(target: WalletBalances, delta: Partial<WalletBalances>) {
  target.usdc += delta.usdc ?? 0n
  target.yes += delta.yes ?? 0n
  target.no += delta.no ?? 0n
}

/**
 * A client that sends nothing and returns made-up signatures, for `--dry-run`. It keeps a ledger
 * of both wallets, where each path fills against the counterparty's quote and the market settles
 * No.
 */
export function createDryRunClient(): DemoClient {
  let counter = 0
  const signature = (step: string) => {
    counter += 1
    return `dryrun${counter}${step.replace(/[^a-z]/gi, '')}`
  }
  const ledger: DemoBalances = { trader: wallet(100n * UNIT), counterparty: wallet(100n * UNIT) }
  const fill = (path: TradePath, quantity: number) => {
    const { trader, counterparty } = ledger
    const tokens = BigInt(quantity) * UNIT
    // The Yes price in base units for the whole quantity.
    const yesCost = (BigInt(QUOTE_PRICES[path]) * tokens) / 100n
    const effects: Record<TradePath, [Partial<WalletBalances>, Partial<WalletBalances>]> = {
      'buy-yes': [
        { yes: tokens, usdc: -yesCost },
        { yes: -tokens, usdc: yesCost },
      ],
      'sell-yes': [
        { yes: -tokens, usdc: yesCost },
        { yes: tokens, usdc: -yesCost },
      ],
      // Mint pairs and sell their Yes to the counterparty's bid.
      'buy-no': [
        { no: tokens, usdc: yesCost - tokens },
        { yes: tokens, usdc: -yesCost },
      ],
      // Buy Yes from the counterparty's ask and merge the pairs back into USDC.
      'sell-no': [
        { no: -tokens, usdc: tokens - yesCost },
        { yes: -tokens, usdc: yesCost },
      ],
    }
    const [traderDelta, counterpartyDelta] = effects[path]
    move(trader, traderDelta)
    move(counterparty, counterpartyDelta)
  }
  return {
    async getGenesisHash() {
      // Devnet's, so the guard passes without a network call.
      return 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    },
    async createDemoMarket({ ticker }) {
      return { market: `DryRun${ticker}Market`, signature: signature('create') }
    },
    async mintPair(_market, quantity) {
      const tokens = BigInt(quantity) * UNIT
      move(ledger.counterparty, { yes: tokens, no: tokens, usdc: -tokens })
      return signature('mint')
    },
    async quote(_market, path) {
      return signature(`quote ${path}`)
    },
    async trade(_market, path, quantity) {
      fill(path, quantity)
      return signature(path)
    },
    async balances() {
      return structuredClone(ledger)
    },
    async publishRelayClose() {
      return signature('publish')
    },
    async settle() {
      return signature('settle')
    },
    async redeem() {
      move(ledger.trader, {
        usdc: ledger.trader.no,
        yes: -ledger.trader.yes,
        no: -ledger.trader.no,
      })
      return signature('redeem')
    },
    async confirm() {},
    async chainNow() {
      throw new Error('not implemented')
    },
  }
}

const formatDelta = (delta: WalletBalances) =>
  `yes ${delta.yes}, no ${delta.no}, usdc ${delta.usdc}`

/**
 * Throws unless the trader's balance change is the path's fill: Buy Yes and Sell Yes move Yes
 * against USDC; Buy No mints and sells the Yes, so only No arrives; Sell No buys Yes and merges,
 * so only No leaves. The USDC paid or received per token is strictly between 0 and $1.
 */
function assertPathFilled(path: TradePath, before: WalletBalances, after: WalletBalances) {
  const delta = {
    usdc: after.usdc - before.usdc,
    yes: after.yes - before.yes,
    no: after.no - before.no,
  }
  const moved = {
    'buy-yes': delta.yes,
    'sell-yes': -delta.yes,
    'buy-no': delta.no,
    'sell-no': -delta.no,
  }[path]
  const other = path.endsWith('-yes') ? delta.no : delta.yes
  const usdc = path.startsWith('buy') ? -delta.usdc : delta.usdc
  if (moved <= 0n) throw new Error(`${path} did not fill (${formatDelta(delta)})`)
  if (other !== 0n) {
    throw new Error(`${path} left the other token changed (${formatDelta(delta)})`)
  }
  if (usdc <= 0n || usdc >= moved) {
    throw new Error(`${path} filled at a price outside (0, $1) (${formatDelta(delta)})`)
  }
}

/**
 * Runs create → mint → all 4 trade paths → settle via the relay → redeem, in demo mode. A
 * counterparty mints pairs and quotes each path just before the trader takes it, so every path
 * fills; the demo stops as soon as a path or the redeem doesn't do what it promises.
 */
export async function runDemo(options: DemoOptions): Promise<DemoResult> {
  const { env, client, now = Date.now, sleep = realSleep, log = console.log } = options
  const target = await assertSafeTarget(env, client)
  assertDemoCluster(target.cluster)

  const transactions: DemoTransaction[] = []
  /**
   * Confirms a sent transaction, prints it, records both wallets' balances in `market` when given
   * and returns the time it was confirmed.
   */
  const confirm = async (step: string, signature: string, market?: string) => {
    const sentAt = now()
    await client.confirm(signature, COMMITMENT)
    const confirmedAt = now()
    const tx: DemoTransaction = {
      step,
      signature,
      explorerUrl: explorerTxUrl(signature, target),
      confirmMs: confirmedAt - sentAt,
    }
    if (market !== undefined) tx.balances = await client.balances(market)
    transactions.push(tx)
    log(`${step.padEnd(8)} ${signature} confirmed in ${tx.confirmMs} ms  ${tx.explorerUrl}`)
    return { confirmedAt, balances: tx.balances }
  }

  const closeTs = Math.ceil(now() / 1000) + DEMO_CLOSE_LEAD_SECS
  log(
    `Demo market ${DEMO_TICKER} on ${target.cluster}, close_ts ${new Date(closeTs * 1000).toISOString()}`,
  )
  const created = await client.createDemoMarket({ ticker: DEMO_TICKER, closeTs })
  await confirm('create', created.signature)
  const { market } = created

  await confirm('mint', await client.mintPair(market, PAIRS), market)
  for (const path of TRADE_PATHS) {
    const quantity = TRADE_QUANTITIES[path]
    const quoted = await confirm(
      `quote ${path}`,
      await client.quote(market, path, quantity),
      market,
    )
    const traded = await confirm(path, await client.trade(market, path, quantity), market)
    if (quoted.balances && traded.balances) {
      assertPathFilled(path, quoted.balances.trader, traded.balances.trader)
    }
  }

  const waitMs = closeTs * 1000 - now()
  if (waitMs > 0) {
    log(`Waiting ${Math.ceil(waitMs / 1000)} s for close_ts`)
    await sleep(waitMs)
  }
  await confirm('publish', await client.publishRelayClose(market), market)
  const { confirmedAt: settledAt } = await confirm('settle', await client.settle(market), market)
  const settlementDelaySecs = (settledAt - closeTs * 1000) / 1000
  log(`Settlement delay from close_ts: ${settlementDelaySecs.toFixed(2)} s`)
  const redeemed = await confirm('redeem', await client.redeem(market), market)
  const left = redeemed.balances?.trader
  if (left && (left.yes !== 0n || left.no !== 0n)) {
    throw new Error(`The redeem left the trader holding ${left.yes} Yes and ${left.no} No`)
  }

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
