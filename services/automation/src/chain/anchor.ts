import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import anchor from '@anchor-lang/core'
import type { Idl } from '@anchor-lang/core'
import { createDataStreamsClient, createPythHermesProvider } from '@meridian/price-providers'
import type { DataStreamsClient, PythHermesProvider } from '@meridian/price-providers'
import { PublicKey } from '@solana/web3.js'
import type { AccountMeta, Connection, GetProgramAccountsFilter, Keypair } from '@solana/web3.js'
import {
  ADMIN_PRICE_EXPO,
  MARKET_STATUS_OFFSET,
  MARKET_STATUS_OPEN,
  MARKET_TICKER_OFFSET,
  MARKET_TRADING_DAY_OFFSET,
  STRIKE_EXPO,
  i64Le,
  isVariant,
  oracleKind,
  programSlot,
  scaleStrike,
  settleSource,
  strikeDollars,
  tickerBytes,
  tickerFromBytes,
  toAdminPrice,
  tradingDayNumber,
  tradingDayString,
  u32Le,
} from './codec.js'
import type { MarketCollateral } from '../invariants.js'
import { errorText, withRetry, type RetryPolicy } from './retry.js'
import type {
  ChainClient,
  ChainPrice,
  OpenMarket,
  OpenMarketFilter,
  OracleSlot,
  PendingAdminPrice,
  PythUpdateAccounts,
  SettleMarketResult,
} from './types.js'
import type { OracleSlotSetting, OracleSlotSettings } from '../config.js'

// The package is CommonJS and Node can't detect all of its named exports.
const { AnchorProvider, BN, Program, Wallet, utils } = anchor

/** Sub-second finality: every read and write waits for `confirmed`. */
const COMMITMENT = 'confirmed'
const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 500 }
const encoder = new TextEncoder()
const DEFAULT_SLOT_SETTINGS: OracleSlotSettings = {
  slot1: { kind: 'relay' },
  slot2: { kind: 'disabled' },
}
/**
 * The Data Streams verifier's access controller account, the same on devnet and mainnet
 * (docs.chain.link, Data Streams on Solana).
 */
export const DEFAULT_CHAINLINK_ACCESS_CONTROLLER = new PublicKey(
  '2k3DsgwBoqrnvXKVvd7jX7aptNxdcRBdcd5HkYsGgbrb',
)
/** The verifier keys a report's config account by the report's first word, its config digest. */
const CONFIG_DIGEST_BYTES = 32

/** Where `anchor build` writes the IDLs, from the repo root whatever the working directory. */
const BUILT_IDL_DIR = fileURLToPath(new URL('../../../../target/idl/', import.meta.url))
/**
 * The IDLs this service ships (`make ship-idls`), for a deploy that has no `target/`. Their
 * program IDs are the declared ones; a fresh build in this checkout takes precedence.
 */
const SHIPPED_IDL_DIR = fileURLToPath(new URL('../../idl/', import.meta.url))

/** The directory holding both program IDLs: this checkout's build, else the shipped copies. */
export const DEFAULT_IDL_DIR = existsSync(join(BUILT_IDL_DIR, 'meridian.json'))
  ? BUILT_IDL_DIR
  : SHIPPED_IDL_DIR

/** The `meridian` IDL the worker loads unless `MERIDIAN_IDL_PATH` names another. */
export const DEFAULT_IDL_PATH = join(DEFAULT_IDL_DIR, 'meridian.json')

/** The `meridian` IDL, read at runtime so the worker needn't compile against `target/`. */
export function loadMeridianIdl(path = DEFAULT_IDL_PATH): Idl {
  return JSON.parse(readFileSync(path, 'utf8')) as Idl
}

/** The `meridian_oracle` IDL beside the `meridian` IDL at `idlPath`, as `anchor build` writes them. */
export function oracleIdlPath(idlPath = DEFAULT_IDL_PATH): string {
  return join(dirname(idlPath), 'meridian_oracle.json')
}

/**
 * The `meridian_oracle` program ID from its built IDL. `anchor keys sync` (CI, or any checkout
 * with its own program keypairs) moves both programs to new IDs, and the `meridian` program finds
 * close records under the oracle ID it was built with, so the oracle ID must come from the same
 * build as the `meridian` IDL, never from a literal.
 */
export function loadOracleProgramId(path = oracleIdlPath()): PublicKey {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    throw new Error(
      `no meridian_oracle IDL at ${path}: run anchor build or set MERIDIAN_ORACLE_PROGRAM_ID`,
    )
  }
  return new PublicKey((JSON.parse(text) as Idl).address)
}

export interface AnchorChainClientOptions {
  connection: Connection
  /**
   * The automation authority: signs and pays for `create_strike_market`, `settle_market` and
   * `finalize_admin_settle`.
   */
  authority: Keypair
  /** The `meridian` IDL; its `address` is the program ID. */
  idl: Idl
  /** Signs `propose_admin_price`. Only the admin CLI needs it. */
  admin?: Keypair
  /** Defaults to the address in the built `meridian_oracle` IDL; see `loadOracleProgramId`. */
  oracleProgramId?: PublicKey
  /** Bounded retries for transport failures. Defaults to 3 tries, 500 ms then 1 s apart. */
  retry?: Partial<RetryPolicy>
  /**
   * How each slot settles, from `ORACLE_SLOT_<n>` (`loadOracleSlotSettings`). Defaults to slot 1
   * on the relay and slot 2 disabled.
   */
  slotSettings?: OracleSlotSettings
  /** Finds or posts the `PriceUpdateV2` accounts a Pyth slot settles from. */
  pythUpdates?: PythUpdateAccounts
  /** For the Pyth and Data Streams HTTP providers. Defaults to the global `fetch`. */
  fetch?: typeof fetch
  /** Milliseconds, for request signing. Defaults to `Date.now`. */
  now?: () => number
  /** The Data Streams verifier's access controller. Defaults to `DEFAULT_CHAINLINK_ACCESS_CONTROLLER`. */
  chainlinkAccessController?: PublicKey
}

/** The HTTP client each third-party slot reads its inputs from. */
interface SlotInputs {
  pyth?: PythHermesProvider
  chainlink?: DataStreamsClient
}

function slotInputs(
  setting: OracleSlotSetting,
  fetchImpl: typeof fetch | undefined,
  now: () => number,
): SlotInputs {
  const http = fetchImpl ? { fetch: fetchImpl } : {}
  if (setting.kind === 'pyth') {
    return {
      pyth: createPythHermesProvider({
        baseUrl: setting.hermesUrl,
        accessToken: setting.accessToken,
        feedIds: setting.feedIds,
        ...http,
      }),
    }
  }
  if (setting.kind === 'chainlink') {
    return {
      chainlink: createDataStreamsClient({
        baseUrl: setting.apiUrl,
        username: setting.username,
        secret: setting.secret,
        streamIds: setting.streamIds,
        now,
        ...http,
      }),
    }
  }
  return {}
}

/** An on-chain kind with no matching `ORACLE_SLOT_<n>`: the worker has no credentials for it. */
function slotMismatch(slot: OracleSlot, chainKind: string, setting: OracleSlotSetting): Error {
  return new Error(
    `oracle slot ${slot} is ${chainKind} on-chain but ORACLE_SLOT_${slot}=${setting.kind}`,
  )
}

/** The Anchor client also lets the admin propose a fallback price (R36). */
export interface AnchorChainClient extends ChainClient {
  /** The `meridian_oracle` program the client derives close records under. */
  readonly oracleProgramId: PublicKey
  /** Sends `propose_admin_price`; the price must be whole cents. Needs the `admin` option. */
  proposeAdminPrice(ticker: string, tradingDay: string, price: ChainPrice): Promise<void>
  /** Every market's collateral counters, vault balance and outcome-mint supplies (R46 audit). */
  listMarketCollateral(): Promise<MarketCollateral[]>
}

type Bn = InstanceType<typeof BN>

interface MarketAccount {
  ticker: number[]
  tradingDay: number
  strike: Bn
  strikeExpo: number
  closeTs: Bn
  status: object
  yesMint: PublicKey
  noMint: PublicKey
  vault: PublicKey
  collateral: Bn
  pairsOutstanding: Bn
  outcome: object | null
}

interface TickerDayAccount {
  status: object
  settlePrice: Bn
  settleExpo: number
  settleSource: object
  pendingAdminPrice: Bn
  pendingAdminAt: Bn
}

interface ConfigAccount {
  usdcMint: PublicKey
  oracleSlots: { kind: object; relaySigner: PublicKey }[]
}

/** `getMultipleAccounts` takes at most this many addresses per call. */
const MAX_MULTIPLE_ACCOUNTS = 100
/** SPL token layouts: a token account's `amount` and a mint's `supply`, both u64 LE. */
const TOKEN_AMOUNT_OFFSET = 64
const MINT_SUPPLY_OFFSET = 36

function u64At(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(offset, true)
}

function outcomeOf(outcome: object | null): MarketCollateral['outcome'] {
  if (outcome === null) return null
  return isVariant(outcome, 'yes') ? 'yes' : 'no'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `ChainClient` backed by the deployed `meridian` program. Oracle slot kinds and relay signers
 * come from the on-chain `Config`. Expected program outcomes (an existing market, a market
 * already settled, no close record yet) come back as values; anything else throws after the
 * bounded retries.
 */
export function createAnchorChainClient(options: AnchorChainClientOptions): AnchorChainClient {
  const { connection, authority, admin } = options
  const oracleProgramId = options.oracleProgramId ?? loadOracleProgramId()
  const policy: RetryPolicy = { ...DEFAULT_RETRY, sleep, ...options.retry }
  const provider = new AnchorProvider(connection, new Wallet(authority), {
    commitment: COMMITMENT,
    preflightCommitment: COMMITMENT,
  })
  const program = new Program(options.idl, provider)
  const programId = program.programId
  // `Program` camel-cases the IDL, so account names are `config`, `market` and `tickerDay`.
  const coder = program.coder.accounts
  const retry = <T>(fn: () => Promise<T>) => withRetry(policy, fn)
  const slotSettings = options.slotSettings ?? DEFAULT_SLOT_SETTINGS
  const now = options.now ?? Date.now
  const inputs: Record<OracleSlot, SlotInputs> = {
    1: slotInputs(slotSettings.slot1, options.fetch, now),
    2: slotInputs(slotSettings.slot2, options.fetch, now),
  }
  const settingOf = (slot: OracleSlot) => (slot === 1 ? slotSettings.slot1 : slotSettings.slot2)
  const accessController = options.chainlinkAccessController ?? DEFAULT_CHAINLINK_ACCESS_CONTROLLER

  const pda = (owner: PublicKey, seeds: Uint8Array[]) =>
    PublicKey.findProgramAddressSync(seeds, owner)[0]
  const configPda = pda(programId, [encoder.encode('config')])
  const tickerDayPda = (ticker: string, tradingDay: string) =>
    pda(programId, [
      encoder.encode('day'),
      tickerBytes(ticker),
      u32Le(tradingDayNumber(tradingDay)),
    ])
  const marketPda = (ticker: string, tradingDay: string, strike: bigint) =>
    pda(programId, [
      encoder.encode('market'),
      tickerBytes(ticker),
      u32Le(tradingDayNumber(tradingDay)),
      i64Le(strike),
    ])
  const closeRecordPda = (signer: PublicKey, ticker: string, tradingDay: string) =>
    pda(oracleProgramId, [
      encoder.encode('close'),
      signer.toBytes(),
      tickerBytes(ticker),
      u32Le(tradingDayNumber(tradingDay)),
    ])

  /** The generic `Idl` type can't prove an instruction exists, so check it at runtime. */
  function method(name: string) {
    const build = program.methods[name]
    if (!build) throw new Error(`the meridian IDL has no ${name} instruction`)
    return build
  }

  async function fetchAccount<T>(name: string, address: PublicKey): Promise<T | null> {
    const info = await retry(() => connection.getAccountInfo(address, COMMITMENT))
    return info ? coder.decode<T>(name, info.data) : null
  }

  async function readConfig(): Promise<ConfigAccount> {
    const config = await fetchAccount<ConfigAccount>('config', configPda)
    if (!config) throw new Error(`no meridian Config at ${configPda.toBase58()}`)
    return config
  }

  async function exists(address: PublicKey): Promise<boolean> {
    return (await retry(() => connection.getAccountInfo(address, COMMITMENT))) !== null
  }

  function bytesFilter(offset: number, bytes: Uint8Array): GetProgramAccountsFilter {
    return { memcmp: { offset, bytes: utils.bytes.bs58.encode(bytes) } }
  }

  function toOpenMarket(address: PublicKey, account: MarketAccount): OpenMarket {
    return {
      address: address.toBase58(),
      ticker: tickerFromBytes(account.ticker),
      tradingDay: tradingDayString(account.tradingDay),
      strike: strikeDollars(BigInt(account.strike.toString()), account.strikeExpo),
      closeTs: account.closeTs.toNumber(),
    }
  }

  async function marketAccounts(filters: GetProgramAccountsFilter[] = []) {
    const discriminator = coder.memcmp('market')
    const accounts = await retry(() =>
      connection.getProgramAccounts(programId, {
        commitment: COMMITMENT,
        filters: [
          { memcmp: { offset: discriminator.offset ?? 0, bytes: discriminator.bytes ?? '' } },
          ...filters,
        ],
      }),
    )
    return accounts.map(({ pubkey, account }) => ({
      address: pubkey,
      market: coder.decode<MarketAccount>('market', account.data),
    }))
  }

  /** Each address's account data, in order; a missing account is an error. */
  async function accountData(addresses: PublicKey[]): Promise<Uint8Array[]> {
    const chunks = Array.from(
      { length: Math.ceil(addresses.length / MAX_MULTIPLE_ACCOUNTS) },
      (_, index) =>
        addresses.slice(index * MAX_MULTIPLE_ACCOUNTS, (index + 1) * MAX_MULTIPLE_ACCOUNTS),
    )
    const infos = (
      await Promise.all(
        chunks.map((chunk) => retry(() => connection.getMultipleAccountsInfo(chunk, COMMITMENT))),
      )
    ).flat()
    return infos.map((info, index) => {
      if (!info) throw new Error(`AccountNotInitialized: ${addresses[index]?.toBase58()}`)
      return info.data
    })
  }

  function pendingOf(day: TickerDayAccount): PendingAdminPrice | null {
    if (day.pendingAdminAt.isZero()) return null
    return {
      price: { price: BigInt(day.pendingAdminPrice.toString()), expo: ADMIN_PRICE_EXPO },
      proposedAt: day.pendingAdminAt.toNumber(),
    }
  }

  interface SettleTarget {
    market: OpenMarket
    slot: OracleSlot
    address: PublicKey
    tickerDay: PublicKey
  }

  /** Sends one settle instruction, then reads the price the ticker-day settled at. */
  async function sendSettle(
    { tickerDay }: SettleTarget,
    send: () => Promise<string>,
  ): Promise<SettleMarketResult> {
    try {
      await retry(send)
    } catch (error) {
      if (/MarketSettled/.test(errorText(error))) return { status: 'already_settled' }
      throw error
    }
    const final = await fetchAccount<TickerDayAccount>('tickerDay', tickerDay)
    if (!final) throw new Error(`ticker-day ${tickerDay.toBase58()} vanished`)
    return {
      status: 'settled',
      price: { price: BigInt(final.settlePrice.toString()), expo: final.settleExpo },
      source: settleSource(final.settleSource),
    }
  }

  /** `settle_market` reading `closeRecord`, then `remaining` as further inputs. */
  function settleFromAccounts(
    target: SettleTarget,
    closeRecord: PublicKey,
    remaining: PublicKey[],
  ): Promise<SettleMarketResult> {
    const remainingAccounts: AccountMeta[] = remaining.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: false,
    }))
    return sendSettle(target, () =>
      method('settleMarket')(programSlot(target.slot))
        .accountsPartial({
          caller: authority.publicKey,
          tickerDay: target.tickerDay,
          market: target.address,
          closeRecord,
        })
        .remainingAccounts(remainingAccounts)
        .rpc(),
    )
  }

  /**
   * A Pyth slot: the Hermes update at `close_ts`, posted or found as `PriceUpdateV2` accounts.
   * The first account goes in `close_record`, the rest follow as remaining accounts.
   */
  async function settleFromPyth(target: SettleTarget): Promise<SettleMarketResult> {
    const setting = settingOf(target.slot)
    const hermes = inputs[target.slot].pyth
    if (!hermes) throw slotMismatch(target.slot, 'Pyth', setting)
    if (!options.pythUpdates) throw new Error('a Pyth slot needs a PriceUpdateV2 locator')
    const update = await hermes.prepareClose(target.market.ticker, target.market.closeTs)
    if (!update) return { status: 'no_price' }
    const [first, ...rest] = await options.pythUpdates.accountsFor(update, target.market)
    if (!first) return { status: 'no_price' }
    return settleFromAccounts(target, first, rest)
  }

  /**
   * A Data Streams slot: `settle_market_with_reports` with the signed reports at `close_ts`,
   * verified on-chain by the slot's verifier program through its `verify` accounts.
   */
  async function settleFromReports(target: SettleTarget): Promise<SettleMarketResult> {
    const setting = settingOf(target.slot)
    const streams = inputs[target.slot].chainlink
    if (!streams || setting.kind !== 'chainlink') {
      throw slotMismatch(target.slot, 'ChainlinkDataStreams', setting)
    }
    const reports = await streams.reportsAt(target.market.ticker, target.market.closeTs)
    const [firstReport] = reports?.fullReports ?? []
    if (!reports || !firstReport) return { status: 'no_price' }
    const verifierProgram = new PublicKey(setting.verifierProgram)
    return sendSettle(target, () =>
      method('settleMarketWithReports')(
        programSlot(target.slot),
        reports.fullReports.map((report) => Buffer.from(report)),
      )
        .accountsPartial({
          caller: authority.publicKey,
          tickerDay: target.tickerDay,
          market: target.address,
          verifierProgram,
          verifierAccount: pda(verifierProgram, [encoder.encode('verifier')]),
          accessController,
          reportConfig: pda(verifierProgram, [firstReport.slice(0, CONFIG_DIGEST_BYTES)]),
        })
        .rpc(),
    )
  }

  return {
    oracleProgramId,

    async readOracleSlots() {
      const [slot1, slot2] = (await readConfig()).oracleSlots
      if (!slot1 || !slot2) throw new Error('Config has fewer than two oracle slots')
      return { slot1: oracleKind(slot1.kind), slot2: oracleKind(slot2.kind) }
    },

    async listOpenMarkets(filter: OpenMarketFilter = {}) {
      const filters = [bytesFilter(MARKET_STATUS_OFFSET, Uint8Array.of(MARKET_STATUS_OPEN))]
      if (filter.ticker !== undefined) {
        filters.push(bytesFilter(MARKET_TICKER_OFFSET, tickerBytes(filter.ticker)))
      }
      if (filter.tradingDay !== undefined) {
        filters.push(
          bytesFilter(MARKET_TRADING_DAY_OFFSET, u32Le(tradingDayNumber(filter.tradingDay))),
        )
      }
      const accounts = await marketAccounts(filters)
      return accounts.map(({ address, market }) => toOpenMarket(address, market))
    },

    async createStrikeMarket(params) {
      const strike = scaleStrike(params.strike)
      const market = marketPda(params.ticker, params.tradingDay, strike)
      if (await exists(market)) return 'already_exists'
      const { usdcMint } = await readConfig()
      try {
        await retry(() =>
          method('createStrikeMarket')({
            ticker: [...tickerBytes(params.ticker)],
            tradingDay: tradingDayNumber(params.tradingDay),
            strike: new BN(strike.toString()),
            strikeExpo: STRIKE_EXPO,
            closeTs: new BN(params.closeTs),
            mintOpenTs: new BN(params.mintOpenTs),
            tradingOpenTs: new BN(params.tradingOpenTs),
          })
            .accountsPartial({
              authority: authority.publicKey,
              tickerDay: tickerDayPda(params.ticker, params.tradingDay),
              market,
              usdcMint,
            })
            .rpc(),
        )
        return 'created'
      } catch (error) {
        // Created by a concurrent run, or by our own try whose confirmation timed out.
        if (/already in use/.test(errorText(error))) return 'already_exists'
        throw error
      }
    },

    async settleMarket(market, slot: OracleSlot) {
      const address = new PublicKey(market.address)
      const state = await fetchAccount<MarketAccount>('market', address)
      if (!state) throw new Error(`AccountNotInitialized: ${market.address}`)
      if (isVariant(state.status, 'settled')) return { status: 'already_settled' }

      const tickerDay = tickerDayPda(market.ticker, market.tradingDay)
      const day = await fetchAccount<TickerDayAccount>('tickerDay', tickerDay)
      if (!day) throw new Error(`AccountNotInitialized: ticker-day ${tickerDay.toBase58()}`)
      const oracleSlot = (await readConfig()).oracleSlots[programSlot(slot)]
      if (!oracleSlot) throw new Error(`Config has no oracle slot ${slot}`)
      const settle = { market, slot, address, tickerDay }
      const closeRecord = closeRecordPda(oracleSlot.relaySigner, market.ticker, market.tradingDay)
      // Once the ticker-day is final, the program ignores the slot's inputs and uses the stored
      // price, so every kind settles the next strike through `settle_market` without fetching.
      if (!isVariant(day.status, 'open')) return settleFromAccounts(settle, closeRecord, [])

      const kind = oracleKind(oracleSlot.kind)
      if (kind === 'Pyth') return settleFromPyth(settle)
      if (kind === 'ChainlinkDataStreams') return settleFromReports(settle)
      if (kind === 'MeridianRelay' && !(await exists(closeRecord))) return { status: 'no_price' }
      return settleFromAccounts(settle, closeRecord, [])
    },

    async finalizeAdminSettle(ticker, tradingDay) {
      await retry(() =>
        method('finalizeAdminSettle')([...tickerBytes(ticker)], tradingDayNumber(tradingDay))
          .accountsPartial({
            caller: authority.publicKey,
            tickerDay: tickerDayPda(ticker, tradingDay),
          })
          .rpc(),
      )
    },

    async readPendingAdminPrice(ticker, tradingDay) {
      const day = await fetchAccount<TickerDayAccount>(
        'tickerDay',
        tickerDayPda(ticker, tradingDay),
      )
      return day ? pendingOf(day) : null
    },

    async proposeAdminPrice(ticker, tradingDay, price) {
      if (!admin) throw new Error('proposing an admin price needs the admin keypair')
      const cents = toAdminPrice(price)
      await retry(() =>
        method('proposeAdminPrice')(
          [...tickerBytes(ticker)],
          tradingDayNumber(tradingDay),
          new BN(cents.toString()),
        )
          .accountsPartial({ admin: admin.publicKey, tickerDay: tickerDayPda(ticker, tradingDay) })
          .signers([admin])
          .rpc(),
      )
    },

    async listMarketCollateral() {
      const accounts = await marketAccounts()
      const data = await accountData(
        accounts.flatMap(({ market }) => [market.vault, market.yesMint, market.noMint]),
      )
      return accounts.map(({ address, market }, index): MarketCollateral => {
        const [vault, yes, no] = data.slice(index * 3, index * 3 + 3) as [
          Uint8Array,
          Uint8Array,
          Uint8Array,
        ]
        return {
          address: address.toBase58(),
          ticker: tickerFromBytes(market.ticker),
          tradingDay: tradingDayString(market.tradingDay),
          status: isVariant(market.status, 'settled') ? 'settled' : 'open',
          outcome: outcomeOf(market.outcome),
          collateral: BigInt(market.collateral.toString()),
          pairsOutstanding: BigInt(market.pairsOutstanding.toString()),
          vaultBalance: u64At(vault, TOKEN_AMOUNT_OFFSET),
          yesSupply: u64At(yes, MINT_SUPPLY_OFFSET),
          noSupply: u64At(no, MINT_SUPPLY_OFFSET),
        }
      })
    },
  }
}
