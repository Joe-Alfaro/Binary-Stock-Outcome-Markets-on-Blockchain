import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import anchor from '@anchor-lang/core'
import type { Idl } from '@anchor-lang/core'
import { createRelaySource } from '@meridian/price-providers'
import { assertNotMainnet } from '@meridian/sdk'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import { createAlerter, sinksFromEnv, type AlertSink, type LineWriter } from './alerts/index.js'
import {
  DEFAULT_IDL_PATH,
  createAnchorChainClient,
  loadMeridianIdl,
  loadOracleProgramId,
  oracleIdlPath,
  type ChainClient,
  type PythUpdateAccounts,
} from './chain/index.js'
import { loadConfig } from './config.js'
import type { HealthState } from './health.js'
import { runInvariantAudits } from './invariants.js'
import { TICKERS, runSettlementJob, systemClock, type Clock, type JobLogger } from './jobs/index.js'
import { runMorningScheduler } from './jobs/scheduler.js'
import { createRelayPublisher } from './relay/index.js'
import { createAnchorOracleClient, loadOracleIdl } from './relay/oracle-client.js'
import {
  relayClock,
  runCloseLoop,
  runLiveLoop,
  skippingUnknownTickers,
  withPublishHealth,
} from './relay/run.js'

const { utils } = anchor

const DEVNET_RPC_URL = 'https://api.devnet.solana.com'
const DEFAULT_LOCAL_RPC_PORT = '8899'
const SECRET_KEY_BYTES = 64

/** What the worker needs to reach the chain, from the environment. */
export interface ChainSettings {
  rpcUrl: string
  /** AUTOMATION_KEYPAIR: a keypair file path, a JSON byte array or a base58 secret key. */
  automationKeypair: string
  idlPath: string
  /** Overrides the IDL's program ID. */
  programId?: string
  oracleProgramId?: string
}

function rpcUrlFor(env: NodeJS.ProcessEnv): string {
  if (env.SOLANA_RPC_URL) return env.SOLANA_RPC_URL
  const cluster = env.SOLANA_CLUSTER ?? 'devnet'
  if (cluster === 'devnet') return DEVNET_RPC_URL
  if (cluster === 'localnet') {
    return `http://127.0.0.1:${env.LOCAL_VALIDATOR_RPC_PORT || DEFAULT_LOCAL_RPC_PORT}`
  }
  if (/^https?:\/\//.test(cluster)) return cluster
  throw new Error(`SOLANA_CLUSTER=${cluster} needs SOLANA_RPC_URL`)
}

/** Reads the chain settings; throws when AUTOMATION_KEYPAIR is missing or the RPC is mainnet. */
export function loadChainSettings(env: NodeJS.ProcessEnv = process.env): ChainSettings {
  const rpcUrl = rpcUrlFor(env)
  assertNotMainnet(rpcUrl)
  const automationKeypair = env.AUTOMATION_KEYPAIR?.trim()
  if (!automationKeypair) throw new Error('AUTOMATION_KEYPAIR is not set')
  return {
    rpcUrl,
    automationKeypair,
    idlPath: env.MERIDIAN_IDL_PATH || DEFAULT_IDL_PATH,
    ...(env.MERIDIAN_PROGRAM_ID ? { programId: env.MERIDIAN_PROGRAM_ID } : {}),
    ...(env.MERIDIAN_ORACLE_PROGRAM_ID ? { oracleProgramId: env.MERIDIAN_ORACLE_PROGRAM_ID } : {}),
  }
}

function secretFromJson(text: string): Uint8Array | null {
  try {
    const parsed: unknown = JSON.parse(text)
    const isBytes =
      Array.isArray(parsed) &&
      parsed.length === SECRET_KEY_BYTES &&
      parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
    return isBytes ? Uint8Array.from(parsed as number[]) : null
  } catch {
    return null
  }
}

/** A keypair from a JSON byte array, a base58 secret key or a solana-keygen file path. */
export function parseKeypair(
  value: string,
  readFile = (path: string) => readFileSync(path, 'utf8'),
) {
  const inline = secretFromJson(value)
  if (inline) return Keypair.fromSecretKey(inline)
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value)) {
    const decoded = utils.bytes.bs58.decode(value)
    if (decoded.length === SECRET_KEY_BYTES) return Keypair.fromSecretKey(decoded)
  }
  const path = value.replace(/^~(?=\/)/, homedir())
  const fromFile = secretFromJson(readFile(path))
  if (!fromFile) throw new Error(`${path} is not a keypair file (64-byte JSON array)`)
  return Keypair.fromSecretKey(fromFile)
}

/** JSON-line job log; bigints become decimal strings. */
export function createJobLogger(write: LineWriter = console.log, clock: Clock = systemClock) {
  const line = (level: 'info' | 'error', message: string, details: Record<string, unknown> = {}) =>
    write(
      JSON.stringify(
        { level, at: new Date(clock.now()).toISOString(), message, ...details },
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      ),
    )
  const log: JobLogger = {
    info: (message, details) => line('info', message, details),
    error: (message, details) => line('error', message, details),
  }
  return log
}

/** Records each successful open-market scan in the health state. */
export function withScanHealth(chain: ChainClient, health: HealthState, clock: Clock): ChainClient {
  return {
    readOracleSlots: () => chain.readOracleSlots(),
    async listOpenMarkets(filter) {
      const markets = await chain.listOpenMarkets(filter)
      health.recordScan(new Date(clock.now()))
      return markets
    },
    createStrikeMarket: (params) => chain.createStrikeMarket(params),
    settleMarket: (market, slot) => chain.settleMarket(market, slot),
    finalizeAdminSettle: (ticker, tradingDay) => chain.finalizeAdminSettle(ticker, tradingDay),
    readPendingAdminPrice: (ticker, tradingDay) => chain.readPendingAdminPrice(ticker, tradingDay),
  }
}

/** Injected by tests; production uses the defaults. */
export interface WorkerDeps {
  /** Drives every job and the relay. Defaults to the system clock. */
  clock?: Clock
  /** Receives every JSON log line, from the jobs and the relay. Defaults to `console.log`. */
  log?: LineWriter
  /** Alert sinks. Defaults to `sinksFromEnv(env)`. */
  alertSinks?: AlertSink[]
  /** Finds or posts the `PriceUpdateV2` accounts a Pyth slot settles from. */
  pythUpdates?: PythUpdateAccounts
}

export interface Worker {
  /** Resolves once every job and the relay have stopped. */
  done: Promise<void>
  stop(): void
}

/** The slot-1 relay signer from RELAY_SIGNER_1_KEYPAIR, in any form `parseKeypair` reads. */
function relaySigner(env: NodeJS.ProcessEnv): Keypair {
  const value = env.RELAY_SIGNER_1_KEYPAIR?.trim()
  if (!value) throw new Error('RELAY_SIGNER_1_KEYPAIR is not set')
  try {
    return parseKeypair(value)
  } catch (error) {
    // Never echo the value: it may be a secret key.
    throw new Error(
      'RELAY_SIGNER_1_KEYPAIR is not a keypair (file path, 64-byte JSON array or base58 secret key)',
      { cause: error },
    )
  }
}

/**
 * Starts the morning job scheduler, the settlement loop, the slot-1 relay (close records after
 * `close_ts` and live prices) and the invariant audit against the cluster in `env`. The jobs sign
 * with the automation authority and the relay with its own signer.
 */
export function startWorker(
  health: HealthState,
  env: NodeJS.ProcessEnv = process.env,
  deps: WorkerDeps = {},
): Worker {
  const settings = loadChainSettings(env)
  const signer = relaySigner(env)
  const idl: Idl = loadMeridianIdl(settings.idlPath)
  const oracleIdl = loadOracleIdl(oracleIdlPath(settings.idlPath))
  const oracleProgramId = settings.oracleProgramId
    ? new PublicKey(settings.oracleProgramId)
    : loadOracleProgramId(oracleIdlPath(settings.idlPath))
  const connection = new Connection(settings.rpcUrl, 'confirmed')
  const chain = createAnchorChainClient({
    connection,
    authority: parseKeypair(settings.automationKeypair),
    idl: settings.programId ? { ...idl, address: settings.programId } : idl,
    oracleProgramId,
  })
  const clock = deps.clock ?? systemClock
  const write = deps.log ?? console.log
  const log = createJobLogger(write, clock)
  const alerter = createAlerter({ sinks: deps.alertSinks ?? sinksFromEnv(env) })
  const controller = new AbortController()
  const { signal } = controller
  const shared = { chain: withScanHealth(chain, health, clock), alerter, clock, log }
  const source = createRelaySource(env, 1, { now: () => Math.floor(clock.now() / 1000) })
  const oracle = createAnchorOracleClient({
    connection,
    signer,
    idl: { ...oracleIdl, address: oracleProgramId.toBase58() },
  })
  const publisher = createRelayPublisher({
    oracle: withPublishHealth(oracle, () => health.recordRelayPublish(new Date(clock.now()))),
    source,
    live: skippingUnknownTickers(source, (ticker, error) =>
      log.info('relay source has no live price; skipping ticker', {
        ticker,
        source: source.name,
        error: error.message,
      }),
    ),
    tickers: TICKERS,
    clock: relayClock(clock, signal),
    log: write,
    demo: loadConfig(env).demoMode,
  })
  const done = Promise.all([
    runMorningScheduler({ ...shared, provider: source, signal }),
    runSettlementJob({ ...shared, signal }),
    runCloseLoop({ ...shared, publisher, signal }),
    runLiveLoop({ publisher, signal }),
    runInvariantAudits({ chain, alerter, log, clock, signal }),
  ]).then(() => undefined)
  return { done, stop: () => controller.abort() }
}
