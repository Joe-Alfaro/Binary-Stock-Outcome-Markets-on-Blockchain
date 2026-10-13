import { PublicKey } from '@solana/web3.js'

export interface WorkerConfig {
  cluster: string
  demoMode: boolean
}

/** Reads the worker settings it needs from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return {
    cluster: env.SOLANA_CLUSTER ?? 'devnet',
    demoMode: env.DEMO_MODE === 'true',
  }
}

/** What `ORACLE_SLOT_<n>` accepts. */
export const ORACLE_SLOT_KINDS = ['relay', 'pyth', 'chainlink', 'disabled'] as const

export type OracleSlotKind = (typeof ORACLE_SLOT_KINDS)[number]

/** Pyth settings: PYTH_RECEIVER_PROGRAM_ID, PYTH_FEED_IDS, PYTH_ACCESS_TOKEN, PYTH_HERMES_URL. */
export interface PythSlotSetting {
  kind: 'pyth'
  /** The receiver program that owns the `PriceUpdateV2` accounts (base58). */
  receiverProgram: string
  /** Feed ID per ticker: 64 lowercase hex digits, no `0x`. */
  feedIds: Record<string, string>
  accessToken: string
  /** Hermes base URL, without a trailing slash. */
  hermesUrl: string
}

/**
 * Data Streams settings: CHAINLINK_VERIFIER_PROGRAM_ID, CHAINLINK_STREAM_IDS,
 * CHAINLINK_DATA_STREAMS_USERNAME, CHAINLINK_HMAC_SECRET, CHAINLINK_DATA_STREAMS_URL.
 */
export interface ChainlinkSlotSetting {
  kind: 'chainlink'
  /** The Data Streams verifier program (base58). */
  verifierProgram: string
  /** Stream ID per ticker: 64 lowercase hex digits, no `0x`. */
  streamIds: Record<string, string>
  username: string
  secret: string
  /** REST API base URL, without a trailing slash. */
  apiUrl: string
}

export type OracleSlotSetting =
  { kind: 'relay' } | { kind: 'disabled' } | PythSlotSetting | ChainlinkSlotSetting

export interface OracleSlotSettings {
  slot1: OracleSlotSetting
  slot2: OracleSlotSetting
}

const DEFAULT_SLOT_KINDS = { 1: 'relay', 2: 'disabled' } as const
const DEFAULT_HERMES_URL = 'https://hermes.pyth.network'
const DEFAULT_DATA_STREAMS_URL = 'https://api.dataengine.chain.link'
const HEX_ID = /^[0-9a-f]{64}$/

function isSlotKind(value: string): value is OracleSlotKind {
  return (ORACLE_SLOT_KINDS as readonly string[]).includes(value)
}

/** Reads each setting a kind needs, failing once with every missing one named. */
function required<const Names extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  slotVar: string,
  kind: OracleSlotKind,
  names: Names,
): Record<Names[number], string> {
  const values = Object.fromEntries(names.map((name) => [name, env[name]?.trim() ?? '']))
  const missing = names.filter((name) => values[name] === '')
  if (missing.length > 0) {
    throw new Error(`${slotVar}=${kind} needs ${missing.join(', ')}`)
  }
  return values as Record<Names[number], string>
}

/** A base58 program ID; the round trip rejects short or padded keys. */
function programId(name: string, value: string): string {
  let key: PublicKey
  try {
    key = new PublicKey(value)
  } catch {
    throw new Error(`${name} is not a base58 program ID`)
  }
  if (key.toBase58() !== value) throw new Error(`${name} is not a base58 program ID`)
  return value
}

/**
 * `TICKER=<64 hex digits>` pairs, comma-separated. Tickers are upper-cased and IDs lower-cased
 * without `0x`.
 */
function idsByTicker(name: string, value: string): Record<string, string> {
  const entries = value
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '')
    .map((pair) => {
      const [ticker, id, ...rest] = pair.split('=').map((part) => part.trim())
      const hex = id?.toLowerCase().replace(/^0x/, '') ?? ''
      if (!ticker || rest.length > 0 || !HEX_ID.test(hex)) {
        throw new Error(`${name} must be TICKER=<64 hex digits> pairs, comma-separated`)
      }
      return [ticker.toUpperCase(), hex] as const
    })
  if (entries.length === 0) throw new Error(`${name} lists no tickers`)
  return Object.fromEntries(entries)
}

function baseUrl(name: string, value: string | undefined, fallback: string): string {
  const url = value?.trim() || fallback
  try {
    new URL(url)
  } catch {
    throw new Error(`${name} is not a URL`)
  }
  return url.replace(/\/+$/, '')
}

function pythSetting(env: NodeJS.ProcessEnv, slotVar: string): PythSlotSetting {
  const values = required(env, slotVar, 'pyth', [
    'PYTH_RECEIVER_PROGRAM_ID',
    'PYTH_FEED_IDS',
    'PYTH_ACCESS_TOKEN',
  ] as const)
  return {
    kind: 'pyth',
    receiverProgram: programId('PYTH_RECEIVER_PROGRAM_ID', values.PYTH_RECEIVER_PROGRAM_ID),
    feedIds: idsByTicker('PYTH_FEED_IDS', values.PYTH_FEED_IDS),
    accessToken: values.PYTH_ACCESS_TOKEN,
    hermesUrl: baseUrl('PYTH_HERMES_URL', env.PYTH_HERMES_URL, DEFAULT_HERMES_URL),
  }
}

function chainlinkSetting(env: NodeJS.ProcessEnv, slotVar: string): ChainlinkSlotSetting {
  const values = required(env, slotVar, 'chainlink', [
    'CHAINLINK_VERIFIER_PROGRAM_ID',
    'CHAINLINK_STREAM_IDS',
    'CHAINLINK_DATA_STREAMS_USERNAME',
    'CHAINLINK_HMAC_SECRET',
  ] as const)
  return {
    kind: 'chainlink',
    verifierProgram: programId(
      'CHAINLINK_VERIFIER_PROGRAM_ID',
      values.CHAINLINK_VERIFIER_PROGRAM_ID,
    ),
    streamIds: idsByTicker('CHAINLINK_STREAM_IDS', values.CHAINLINK_STREAM_IDS),
    username: values.CHAINLINK_DATA_STREAMS_USERNAME,
    secret: values.CHAINLINK_HMAC_SECRET,
    apiUrl: baseUrl(
      'CHAINLINK_DATA_STREAMS_URL',
      env.CHAINLINK_DATA_STREAMS_URL,
      DEFAULT_DATA_STREAMS_URL,
    ),
  }
}

function slotSetting(env: NodeJS.ProcessEnv, slot: 1 | 2): OracleSlotSetting {
  const slotVar = `ORACLE_SLOT_${slot}`
  const kind = env[slotVar]?.trim() || DEFAULT_SLOT_KINDS[slot]
  if (!isSlotKind(kind)) {
    throw new Error(`${slotVar}=${kind} is not one of ${ORACLE_SLOT_KINDS.join(', ')}`)
  }
  if (kind === 'pyth') return pythSetting(env, slotVar)
  if (kind === 'chainlink') return chainlinkSetting(env, slotVar)
  return { kind }
}

/**
 * Reads `ORACLE_SLOT_1` (default relay) and `ORACLE_SLOT_2` (default disabled) and the settings
 * each kind needs. Throws naming the variable when a setting is missing or malformed. Error
 * messages never include a credential's value.
 */
export function loadOracleSlotSettings(env: NodeJS.ProcessEnv = process.env): OracleSlotSettings {
  return { slot1: slotSetting(env, 1), slot2: slotSetting(env, 2) }
}
