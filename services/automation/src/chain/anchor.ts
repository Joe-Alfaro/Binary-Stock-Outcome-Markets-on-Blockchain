import { readFileSync } from 'node:fs'
import anchor from '@anchor-lang/core'
import type { Idl } from '@anchor-lang/core'
import { PublicKey } from '@solana/web3.js'
import type { Connection, GetProgramAccountsFilter, Keypair } from '@solana/web3.js'
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
import { errorText, withRetry, type RetryPolicy } from './retry.js'
import type {
  ChainClient,
  ChainPrice,
  OpenMarket,
  OpenMarketFilter,
  OracleSlot,
  PendingAdminPrice,
} from './types.js'

// The package is CommonJS and Node can't detect all of its named exports.
const { AnchorProvider, BN, Program, Wallet, utils } = anchor

/** Sub-second finality: every read and write waits for `confirmed`. */
const COMMITMENT = 'confirmed'
const DEFAULT_RETRY = { attempts: 3, baseDelayMs: 500 }
/** The `meridian_oracle` program's declared ID; close records live under it. */
export const MERIDIAN_ORACLE_PROGRAM_ID = new PublicKey(
  '3HDbiFX8iSf7zXfaYmFRPNnKsjUiLvF55rHperUvjjVY',
)

const encoder = new TextEncoder()

/** The IDL `anchor build` writes, read at runtime so the worker needn't compile against `target/`. */
export function loadMeridianIdl(path = 'target/idl/meridian.json'): Idl {
  return JSON.parse(readFileSync(path, 'utf8')) as Idl
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
  /** Defaults to the declared `meridian_oracle` ID. */
  oracleProgramId?: PublicKey
  /** Bounded retries for transport failures. Defaults to 3 tries, 500 ms then 1 s apart. */
  retry?: Partial<RetryPolicy>
}

/** The Anchor client also lets the admin propose a fallback price (R36). */
export interface AnchorChainClient extends ChainClient {
  /** Sends `propose_admin_price`; the price must be whole cents. Needs the `admin` option. */
  proposeAdminPrice(ticker: string, tradingDay: string, price: ChainPrice): Promise<void>
}

type Bn = InstanceType<typeof BN>

interface MarketAccount {
  ticker: number[]
  tradingDay: number
  strike: Bn
  strikeExpo: number
  closeTs: Bn
  status: object
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
  const oracleProgramId = options.oracleProgramId ?? MERIDIAN_ORACLE_PROGRAM_ID
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

  function pendingOf(day: TickerDayAccount): PendingAdminPrice | null {
    if (day.pendingAdminAt.isZero()) return null
    return {
      price: { price: BigInt(day.pendingAdminPrice.toString()), expo: ADMIN_PRICE_EXPO },
      proposedAt: day.pendingAdminAt.toNumber(),
    }
  }

  return {
    async readOracleSlots() {
      const [slot1, slot2] = (await readConfig()).oracleSlots
      if (!slot1 || !slot2) throw new Error('Config has fewer than two oracle slots')
      return { slot1: oracleKind(slot1.kind), slot2: oracleKind(slot2.kind) }
    },

    async listOpenMarkets(filter: OpenMarketFilter = {}) {
      const discriminator = coder.memcmp('market')
      const filters: GetProgramAccountsFilter[] = [
        { memcmp: { offset: discriminator.offset ?? 0, bytes: discriminator.bytes ?? '' } },
        bytesFilter(MARKET_STATUS_OFFSET, Uint8Array.of(MARKET_STATUS_OPEN)),
      ]
      if (filter.ticker !== undefined) {
        filters.push(bytesFilter(MARKET_TICKER_OFFSET, tickerBytes(filter.ticker)))
      }
      if (filter.tradingDay !== undefined) {
        filters.push(
          bytesFilter(MARKET_TRADING_DAY_OFFSET, u32Le(tradingDayNumber(filter.tradingDay))),
        )
      }
      const accounts = await retry(() =>
        connection.getProgramAccounts(programId, { commitment: COMMITMENT, filters }),
      )
      return accounts.map(({ pubkey, account }) =>
        toOpenMarket(pubkey, coder.decode<MarketAccount>('market', account.data)),
      )
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
      const closeRecord = closeRecordPda(oracleSlot.relaySigner, market.ticker, market.tradingDay)
      // Until the ticker-day is final, settling needs the slot's close record; once it is final,
      // the program ignores the record and uses the stored price.
      const needsRecord =
        isVariant(day.status, 'open') && oracleKind(oracleSlot.kind) === 'MeridianRelay'
      if (needsRecord && !(await exists(closeRecord))) return { status: 'no_price' }

      try {
        await retry(() =>
          method('settleMarket')(programSlot(slot))
            .accountsPartial({
              caller: authority.publicKey,
              tickerDay,
              market: address,
              closeRecord,
            })
            .rpc(),
        )
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
  }
}
