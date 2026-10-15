import type { Clock } from '../jobs/clock.js'
import type {
  ChainClient,
  ChainPrice,
  CreateStrikeMarketParams,
  CreateStrikeMarketResult,
  OpenMarket,
  OpenMarketFilter,
  OracleSlot,
  OracleSlots,
  PendingAdminPrice,
  SettleMarketResult,
} from './types.js'

/** A settled market's final state in the fake. */
export interface FakeSettlement {
  price: ChainPrice
  source: OracleSlot | 'admin'
  /** Milliseconds, from the clock. */
  at: number
}

export interface FakeMarket extends OpenMarket {
  settlement?: FakeSettlement
}

export interface CreateCall {
  params: CreateStrikeMarketParams
  at: number
  /** The returned value, or the thrown error. */
  outcome: CreateStrikeMarketResult | Error
}

export interface SettleCall {
  market: OpenMarket
  slot: OracleSlot
  at: number
  outcome?: SettleMarketResult | Error
}

export interface FinalizeCall {
  ticker: string
  tradingDay: string
  at: number
}

/**
 * Runs before a call takes effect. It may throw (a transport error), sleep on the clock (a slow
 * RPC) or change the fake's state (a third party acting first).
 */
export type CreateHook = (params: CreateStrikeMarketParams) => Promise<void> | void
export type SettleHook = (market: OpenMarket, slot: OracleSlot) => Promise<void> | void

interface FakeTickerDay {
  final?: { price: ChainPrice; source: OracleSlot | 'admin' }
  pending?: PendingAdminPrice
}

function tickerDayKey(ticker: string, tradingDay: string): string {
  return `${ticker}|${tradingDay}`
}

function marketAddress(ticker: string, tradingDay: string, strike: bigint): string {
  return `market-${ticker}-${tradingDay}-${strike}`
}

/**
 * In-memory chain with the program's settlement rules: one price per ticker and day, a close
 * record per slot, the admin fallback delays and "already exists" / "already settled" outcomes.
 * Records every call with its clock time.
 */
export class FakeChainClient implements ChainClient {
  readonly creates: CreateCall[] = []
  readonly settleCalls: SettleCall[] = []
  readonly finalizeCalls: FinalizeCall[] = []
  slots: OracleSlots = { slot1: 'MeridianRelay', slot2: 'Disabled' }
  createHook?: CreateHook
  settleHook?: SettleHook

  readonly #clock: Clock
  readonly #markets = new Map<string, FakeMarket>()
  readonly #tickerDays = new Map<string, FakeTickerDay>()
  readonly #closeRecords = new Map<string, ChainPrice>()

  constructor(clock: Clock) {
    this.#clock = clock
  }

  // Test controls.

  /** Adds a market directly, as `add_strike` or an earlier morning job would have. */
  addMarket(market: Omit<OpenMarket, 'address'>): FakeMarket {
    const address = marketAddress(market.ticker, market.tradingDay, market.strike)
    const created: FakeMarket = { ...market, address }
    this.#markets.set(address, created)
    return created
  }

  /** The relay's write-once close record for a slot, ticker and day. */
  publishClose(slot: OracleSlot, ticker: string, tradingDay: string, price: ChainPrice): void {
    this.#closeRecords.set(`${slot}|${tickerDayKey(ticker, tradingDay)}`, price)
  }

  /** `propose_admin_price`; a later proposal replaces the pending one. */
  proposeAdminPrice(ticker: string, tradingDay: string, price: ChainPrice): void {
    this.#tickerDay(ticker, tradingDay).pending = {
      price,
      proposedAt: Math.floor(this.#clock.now() / 1000),
    }
  }

  /**
   * The admin finalizes the pending price outside the worker (the web app or admin CLI, D93).
   * Settles nothing by itself: each market still needs `settle_market`.
   */
  finalizeByAdmin(ticker: string, tradingDay: string): void {
    const tickerDay = this.#tickerDay(ticker, tradingDay)
    if (!tickerDay.pending) throw new Error('NoPendingAdminPrice')
    tickerDay.final = { price: tickerDay.pending.price, source: 'admin' }
  }

  /** Someone else settles every strike of a ticker and day from slot 1. */
  settleExternally(ticker: string, tradingDay: string, price: ChainPrice): void {
    this.publishClose(1, ticker, tradingDay, price)
    this.#tickerDay(ticker, tradingDay).final = { price, source: 1 }
    this.marketsOf(ticker, tradingDay).forEach((market) => {
      market.settlement ??= { price, source: 1, at: this.#clock.now() }
    })
  }

  allMarkets(): FakeMarket[] {
    return [...this.#markets.values()]
  }

  marketsOf(ticker: string, tradingDay?: string): FakeMarket[] {
    return this.allMarkets().filter(
      (market) =>
        market.ticker === ticker && (tradingDay === undefined || market.tradingDay === tradingDay),
    )
  }

  // ChainClient.

  async readOracleSlots(): Promise<OracleSlots> {
    return { ...this.slots }
  }

  async listOpenMarkets(filter: OpenMarketFilter = {}): Promise<OpenMarket[]> {
    return this.allMarkets()
      .filter(
        (market) =>
          !market.settlement &&
          (filter.ticker === undefined || market.ticker === filter.ticker) &&
          (filter.tradingDay === undefined || market.tradingDay === filter.tradingDay),
      )
      .map(({ address, ticker, tradingDay, strike, closeTs }) => ({
        address,
        ticker,
        tradingDay,
        strike,
        closeTs,
      }))
  }

  async createStrikeMarket(params: CreateStrikeMarketParams): Promise<CreateStrikeMarketResult> {
    const call: CreateCall = { params: { ...params }, at: this.#clock.now(), outcome: 'created' }
    this.creates.push(call)
    try {
      await this.createHook?.(params)
    } catch (error) {
      call.outcome = error instanceof Error ? error : new Error(String(error))
      throw error
    }
    const address = marketAddress(params.ticker, params.tradingDay, params.strike)
    if (this.#markets.has(address)) {
      call.outcome = 'already_exists'
      return 'already_exists'
    }
    this.#markets.set(address, {
      address,
      ticker: params.ticker,
      tradingDay: params.tradingDay,
      strike: params.strike,
      closeTs: params.closeTs,
    })
    return 'created'
  }

  async settleMarket(market: OpenMarket, slot: OracleSlot): Promise<SettleMarketResult> {
    const call: SettleCall = { market: { ...market }, slot, at: this.#clock.now() }
    this.settleCalls.push(call)
    try {
      await this.settleHook?.(market, slot)
      const outcome = this.#settle(market, slot)
      call.outcome = outcome
      return outcome
    } catch (error) {
      call.outcome = error instanceof Error ? error : new Error(String(error))
      throw error
    }
  }

  async finalizeAdminSettle(ticker: string, tradingDay: string): Promise<void> {
    this.finalizeCalls.push({ ticker, tradingDay, at: this.#clock.now() })
    const closeTs = this.marketsOf(ticker, tradingDay)[0]?.closeTs
    if (closeTs === undefined) throw new Error('AccountNotInitialized: TickerDay')
    if (this.#clock.now() / 1000 < closeTs + 3600) throw new Error('AdminFinalizeTooEarly')
    const tickerDay = this.#tickerDay(ticker, tradingDay)
    if (tickerDay.final) throw new Error('TickerDayAlreadyFinal')
    if (!tickerDay.pending) throw new Error('NoPendingAdminPrice')
    tickerDay.final = { price: tickerDay.pending.price, source: 'admin' }
  }

  async readPendingAdminPrice(
    ticker: string,
    tradingDay: string,
  ): Promise<PendingAdminPrice | null> {
    return this.#tickerDays.get(tickerDayKey(ticker, tradingDay))?.pending ?? null
  }

  #tickerDay(ticker: string, tradingDay: string): FakeTickerDay {
    const key = tickerDayKey(ticker, tradingDay)
    const existing = this.#tickerDays.get(key)
    if (existing) return existing
    const created: FakeTickerDay = {}
    this.#tickerDays.set(key, created)
    return created
  }

  #settle(market: OpenMarket, slot: OracleSlot): SettleMarketResult {
    const stored = this.#markets.get(market.address)
    if (!stored) throw new Error(`AccountNotInitialized: ${market.address}`)
    if (stored.settlement) return { status: 'already_settled' }
    const nowSecs = this.#clock.now() / 1000
    if (nowSecs < stored.closeTs) throw new Error('MarketNotClosed')
    const tickerDay = this.#tickerDay(stored.ticker, stored.tradingDay)
    if (!tickerDay.final) {
      const slotKind = slot === 1 ? this.slots.slot1 : this.slots.slot2
      if (slotKind === 'Disabled') throw new Error(`OracleSlotDisabled: slot ${slot}`)
      const record = this.#closeRecords.get(
        `${slot}|${tickerDayKey(stored.ticker, stored.tradingDay)}`,
      )
      if (!record) return { status: 'no_price' }
      tickerDay.final = { price: record, source: slot }
    }
    stored.settlement = { ...tickerDay.final, at: this.#clock.now() }
    return { status: 'settled', price: tickerDay.final.price, source: tickerDay.final.source }
  }
}
