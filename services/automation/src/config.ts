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

/**
 * Reads `ORACLE_SLOT_1` (default relay) and `ORACLE_SLOT_2` (default disabled) and the settings
 * each kind needs. Throws naming the variable when a setting is missing or malformed.
 */
export function loadOracleSlotSettings(env: NodeJS.ProcessEnv = process.env): OracleSlotSettings {
  throw new Error(`loadOracleSlotSettings is not implemented (${Object.keys(env).length} vars)`)
}
