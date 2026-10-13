import type { PythCloseUpdate } from '@meridian/price-providers'
import type { PublicKey } from '@solana/web3.js'

/** Price as stored on-chain: `price × 10^expo`, as Pyth and the program use. */
export interface ChainPrice {
  price: bigint
  expo: number
}

/** The kinds an oracle slot can be configured as in the program's `Config`. */
export type OracleKind = 'Disabled' | 'MeridianRelay' | 'Pyth' | 'ChainlinkDataStreams'

/** One of the two oracle slots in `Config`. */
export type OracleSlot = 1 | 2

export interface OracleSlots {
  slot1: OracleKind
  slot2: OracleKind
}

/** An open `Market` account as read from the chain. */
export interface OpenMarket {
  /** Market account address (base58). */
  address: string
  ticker: string
  /** `YYYY-MM-DD` in America/New_York. */
  tradingDay: string
  /** Strike in whole US dollars. */
  strike: bigint
  /** Unix seconds. */
  closeTs: number
}

/** Narrows `listOpenMarkets` on-chain; every field is optional. */
export interface OpenMarketFilter {
  ticker?: string
  /** `YYYY-MM-DD` in America/New_York. */
  tradingDay?: string
}

/** Arguments of one `create_strike_market` instruction: exactly one strike. */
export interface CreateStrikeMarketParams {
  ticker: string
  /** `YYYY-MM-DD` in America/New_York. */
  tradingDay: string
  /** Strike in whole US dollars; the client scales it to the configured price exponent. */
  strike: bigint
  /** Unix seconds, from the exchange calendar. */
  closeTs: number
  mintOpenTs: number
  tradingOpenTs: number
}

/** `already_exists` means the market PDA was already initialized, which the morning job treats as success. */
export type CreateStrikeMarketResult = 'created' | 'already_exists'

/**
 * Outcome of one `settle_market` attempt.
 * - `settled`: this call settled the market, at the ticker-day's single price.
 * - `already_settled`: someone else settled it first; a success.
 * - `no_price`: the slot has no valid close record yet (the transaction would fail); poll again.
 */
export type SettleMarketResult =
  | { status: 'settled'; price: ChainPrice; source: OracleSlot | 'admin' }
  | { status: 'already_settled' }
  | { status: 'no_price' }

/** A price the admin has proposed for a ticker and day, waiting for `finalize_admin_settle`. */
export interface PendingAdminPrice {
  price: ChainPrice
  /** Unix seconds. */
  proposedAt: number
}

/**
 * Everything the automation jobs need from the chain. Implementations throw on transport or
 * unexpected program errors; expected outcomes are returned as values.
 */
export interface ChainClient {
  /** The oracle slot kinds from the program's `Config`. */
  readOracleSlots(): Promise<OracleSlots>
  /**
   * Every `Market` that is not settled yet, read from the chain: from every ticker and trading
   * day, or only those matching `filter`.
   */
  listOpenMarkets(filter?: OpenMarketFilter): Promise<OpenMarket[]>
  /** Sends one transaction with one `create_strike_market` instruction. */
  createStrikeMarket(params: CreateStrikeMarketParams): Promise<CreateStrikeMarketResult>
  /**
   * Sends `settle_market` for one market, reading the close record of `slot`. Once the ticker-day
   * has a final price, any slot settles the market at that price.
   */
  settleMarket(market: OpenMarket, slot: OracleSlot): Promise<SettleMarketResult>
  /** Sends `finalize_admin_settle` for a ticker and day. Fails before `close_ts + 3600`. */
  finalizeAdminSettle(ticker: string, tradingDay: string): Promise<void>
  /** The pending admin price of a ticker and day, or null when none is pending. */
  readPendingAdminPrice(ticker: string, tradingDay: string): Promise<PendingAdminPrice | null>
}

/**
 * Finds or posts the Pyth receiver `PriceUpdateV2` accounts that hold a Hermes close update, for
 * `settle_market` on a Pyth slot.
 */
export interface PythUpdateAccounts {
  /** The update accounts, first one first: it goes in `close_record`, the rest are remaining accounts. */
  accountsFor(update: PythCloseUpdate, market: OpenMarket): Promise<PublicKey[]>
}
