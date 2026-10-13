import type { Alert, Alerter } from '../alerts/index.js'
import type {
  ChainClient,
  ChainPrice,
  OpenMarket,
  OracleSlot,
  OracleSlots,
} from '../chain/index.js'
import type { Clock } from './clock.js'
import type { JobLogger } from './logger.js'
import { formatPrice, samePrice } from './price.js'

export interface SettlementJobDeps {
  chain: ChainClient
  alerter: Alerter
  clock: Clock
  log: JobLogger
  /** Stops the job; the returned promise resolves once it has stopped. */
  signal: AbortSignal
}

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS
const DISCOVERY_INTERVAL_MS = 30 * SECOND_MS
const FAST_POLL_MS = 30 * SECOND_MS
const SLOW_POLL_MS = 3 * MINUTE_MS
/** Offsets from `close_ts` of the escalation schedule (ARCHITECTURE, D14). */
const FAST_PHASE_END_MS = 15 * MINUTE_MS
const FAST_PHASE_START_MS: Record<OracleSlot, number> = { 1: 0, 2: 4 * MINUTE_MS }
/** Staggered slow polling: slot 1 at +16, +19, …; slot 2 a minute later. */
const SLOW_PHASE_START_MS: Record<OracleSlot, number> = { 1: 16 * MINUTE_MS, 2: 17 * MINUTE_MS }
const ADMIN_FINALIZE_MS = 60 * MINUTE_MS
const ADMIN_CHECK_INTERVAL_MS = MINUTE_MS
const ESCALATION_ALERTS = [
  { kind: 'settlement_first_alert', offsetMs: 15 * MINUTE_MS },
  { kind: 'settlement_second_alert', offsetMs: 50 * MINUTE_MS },
] as const

type EscalationKind = (typeof ESCALATION_ALERTS)[number]['kind']

/** The first scheduled `settle_market` attempt from `slot` at or after `fromMs`. */
function nextPollAt(slot: OracleSlot, closeMs: number, fromMs: number): number {
  const fastStart = closeMs + FAST_PHASE_START_MS[slot]
  const fastEnd = closeMs + FAST_PHASE_END_MS
  const fastSteps = Math.max(0, Math.ceil((fromMs - fastStart) / FAST_POLL_MS))
  const fast = fastStart + fastSteps * FAST_POLL_MS
  if (fast < fastEnd) return fast
  const slowStart = closeMs + SLOW_PHASE_START_MS[slot]
  const slowSteps = Math.max(0, Math.ceil((fromMs - slowStart) / SLOW_POLL_MS))
  return slowStart + slowSteps * SLOW_POLL_MS
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function slotEnabled(slots: OracleSlots, slot: OracleSlot): boolean {
  return (slot === 1 ? slots.slot1 : slots.slot2) !== 'Disabled'
}

interface SettlerContext extends SettlementJobDeps {
  slots(): OracleSlots
}

/** Runs the escalation schedule for one ticker and trading day until every market is settled. */
class TickerDaySettler {
  readonly #ctx: SettlerContext
  readonly #ticker: string
  readonly #tradingDay: string
  readonly #closeMs: number
  readonly #markets = new Map<string, OpenMarket>()
  readonly #settled = new Set<string>()
  #mismatchChecked = false

  constructor(ctx: SettlerContext, first: OpenMarket) {
    this.#ctx = ctx
    this.#ticker = first.ticker
    this.#tradingDay = first.tradingDay
    this.#closeMs = first.closeTs * 1000
    this.addMarket(first)
  }

  /** Markets found later, such as `add_strike` markets, join the schedule. */
  addMarket(market: OpenMarket): void {
    if (!this.#markets.has(market.address)) this.#markets.set(market.address, market)
  }

  get #done(): boolean {
    return [...this.#markets.keys()].every((address) => this.#settled.has(address))
  }

  get #details() {
    return { ticker: this.#ticker, tradingDay: this.#tradingDay }
  }

  async run(): Promise<void> {
    const { clock, signal } = this.#ctx
    const startedAt = clock.now()
    const next: Record<OracleSlot | 'admin', number> = {
      1: nextPollAt(1, this.#closeMs, startedAt),
      2: nextPollAt(2, this.#closeMs, startedAt),
      admin: Math.max(this.#closeMs + ADMIN_FINALIZE_MS, startedAt),
    }
    const alerts = this.#alertSchedule(startedAt, next[1])

    while (!signal.aborted && !this.#done) {
      const slots = this.#ctx.slots()
      const polled = ([1, 2] as const).filter((slot) => slotEnabled(slots, slot))
      const wakeAt = Math.min(
        ...polled.map((slot) => next[slot]),
        next.admin,
        alerts[0]?.at ?? Infinity,
      )
      await clock.sleep(wakeAt - clock.now(), signal)
      if (signal.aborted) return
      const now = clock.now()

      for (const slot of polled.filter((slot) => next[slot] <= now)) {
        await this.#settleAll(slot)
        next[slot] = nextPollAt(slot, this.#closeMs, Math.max(clock.now(), next[slot]) + 1)
      }
      if (this.#done) return
      if (next.admin <= now) {
        await this.#finalizePendingAdminPrice()
        next.admin = clock.now() + ADMIN_CHECK_INTERVAL_MS
      }
      if (this.#done) return
      const due = alerts.filter((alert) => alert.at <= now)
      alerts.splice(0, due.length)
      for (const { kind } of due) await this.#escalate(kind)
    }
  }

  /**
   * Escalation alerts still ahead of `startedAt` keep their times. After a restart, the latest one
   * already due is sent once, at the first poll, if that poll does not settle the ticker-day.
   */
  #alertSchedule(startedAt: number, firstPollMs: number) {
    const timed = ESCALATION_ALERTS.map(({ kind, offsetMs }) => ({
      kind,
      at: this.#closeMs + offsetMs,
    }))
    const upcoming = timed.filter((alert) => alert.at >= startedAt)
    const missed = timed.filter((alert) => alert.at < startedAt).at(-1)
    return missed ? [{ kind: missed.kind, at: firstPollMs }, ...upcoming] : upcoming
  }

  /** Tries `settle_market` on each open market from `slot`, stopping when the slot has no price. */
  async #settleAll(slot: OracleSlot): Promise<void> {
    const { chain, log, signal } = this.#ctx
    const open = [...this.#markets.values()].filter((market) => !this.#settled.has(market.address))
    for (const market of open) {
      if (signal.aborted) return
      const details = { ...this.#details, market: market.address, slot }
      try {
        const result = await chain.settleMarket(market, slot)
        if (result.status === 'no_price') return
        this.#settled.add(market.address)
        if (result.status === 'already_settled') {
          log.info('market already settled', details)
          continue
        }
        log.info('market settled', {
          ...details,
          price: formatPrice(result.price),
          source: result.source,
        })
        if (result.source !== 'admin') await this.#checkAdminMismatch(result.price, result.source)
      } catch (error) {
        log.error('settle_market failed', { ...details, error: errorMessage(error) })
      }
    }
  }

  /** R36: an oracle price that differs from a pending admin price is alerted once. */
  async #checkAdminMismatch(oraclePrice: ChainPrice, source: OracleSlot): Promise<void> {
    if (this.#mismatchChecked) return
    const { chain, log } = this.#ctx
    const pending = await chain
      .readPendingAdminPrice(this.#ticker, this.#tradingDay)
      .catch((error: unknown) => {
        // Left unchecked, so the next settled market of this ticker-day checks again.
        log.error('reading the pending admin price failed', {
          ...this.#details,
          error: errorMessage(error),
        })
        return undefined
      })
    if (pending === undefined) return
    this.#mismatchChecked = true
    if (!pending || samePrice(pending.price, oraclePrice)) return
    await this.#alert({
      kind: 'admin_price_mismatch',
      message: `${this.#ticker} ${this.#tradingDay} settled from slot ${source} at ${formatPrice(oraclePrice)}, not the pending admin price ${formatPrice(pending.price)}`,
      details: {
        ...this.#details,
        oraclePrice: formatPrice(oraclePrice),
        adminPrice: formatPrice(pending.price),
        source,
      },
    })
  }

  /** From +60, finalizes a pending admin price and settles every market at it. */
  async #finalizePendingAdminPrice(): Promise<void> {
    const { chain, log } = this.#ctx
    try {
      const pending = await chain.readPendingAdminPrice(this.#ticker, this.#tradingDay)
      if (!pending) return
      await chain.finalizeAdminSettle(this.#ticker, this.#tradingDay)
      log.info('admin price finalized', { ...this.#details, price: formatPrice(pending.price) })
    } catch (error) {
      log.error('finalize_admin_settle failed', { ...this.#details, error: errorMessage(error) })
      return
    }
    await this.#settleAll(1)
  }

  async #escalate(kind: EscalationKind): Promise<void> {
    const unsettled = this.#markets.size - this.#settled.size
    const minutes = Math.round((this.#ctx.clock.now() - this.#closeMs) / MINUTE_MS)
    await this.#alert({
      kind,
      message: `${this.#ticker} ${this.#tradingDay}: ${unsettled} markets unsettled ${minutes} minutes after close`,
      details: { ...this.#details, closeTs: this.#closeMs / 1000, unsettledMarkets: unsettled },
    })
  }

  async #alert(alert: Alert): Promise<void> {
    this.#ctx.log.error(alert.message, { kind: alert.kind, ...alert.details })
    await this.#ctx.alerter.alert(alert)
  }
}

/**
 * Long-running settlement loop. Finds open markets on-chain, groups them by ticker and day, and
 * runs the escalation schedule for each from `close_ts`: 30 s polling for 15 minutes, the first
 * alert and staggered 3-minute polling at +15, the second alert at +50 and admin finalization at
 * +60. The phase comes from the clock, so a restart resumes where it should.
 */
export async function runSettlementJob(deps: SettlementJobDeps): Promise<void> {
  const { chain, clock, log, signal } = deps
  let slots: OracleSlots | undefined
  const ctx: SettlerContext = {
    ...deps,
    slots: () => slots ?? { slot1: 'Disabled', slot2: 'Disabled' },
  }
  const settlers = new Map<string, { settler: TickerDaySettler; done: Promise<void> }>()

  async function discover(): Promise<void> {
    try {
      const [nextSlots, markets] = await Promise.all([
        chain.readOracleSlots(),
        chain.listOpenMarkets(),
      ])
      slots = nextSlots
      markets.forEach((market) => {
        const key = `${market.ticker}|${market.tradingDay}`
        const existing = settlers.get(key)
        if (existing) {
          existing.settler.addMarket(market)
          return
        }
        const settler = new TickerDaySettler(ctx, market)
        const done = settler
          .run()
          .catch((error: unknown) => {
            log.error('settlement failed', { key, error: errorMessage(error) })
          })
          .finally(() => settlers.delete(key))
        settlers.set(key, { settler, done })
      })
    } catch (error) {
      log.error('open market discovery failed', { error: errorMessage(error) })
    }
  }

  while (!signal.aborted) {
    await discover()
    await clock.sleep(DISCOVERY_INTERVAL_MS, signal)
  }
  await Promise.all([...settlers.values()].map(({ done }) => done))
}
