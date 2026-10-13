import type { OrderFilledEvent, OutcomeSide, ProgramEvent } from './types.js'

export interface PortfolioOptions {
  wallet: string
  /** Current Yes mark in cents per market; the No mark is `100 −` it. Settled markets use the outcome. */
  yesMarks: ReadonlyMap<string, number>
}

/** One side of one market. Closed positions stay listed with qty 0 so realized P&L remains visible. */
export interface Position {
  market: string
  side: OutcomeSide
  qty: number
  avgEntryCents: number
  markCents: number
  currentValueCents: number
  realizedPnlCents: number
  unrealizedPnlCents: number
}

/** A trade in outcome-token terms, with No trades priced net of the mint or merge. */
export interface Trade {
  market: string
  signature: string
  side: OutcomeSide
  action: 'Buy' | 'Sell'
  qty: number
  priceCents: number
  /** True when the wallet was the resting order, so the fill sits in someone else's transaction. */
  maker: boolean
}

export interface Portfolio {
  positions: Position[]
  trades: Trade[]
}

/** Net exposure per strike for the market-maker view. */
export interface MarketExposure {
  market: string
  yes: number
  no: number
  /** `yes − no`: positive is long Yes, negative is long No. */
  netYes: number
  fills: number
  makerFills: number
  realizedPnlCents: number
  unrealizedPnlCents: number
}

const PAIR_CENTS = 100

/** Tokens of one side held outside unsplit pairs. All money is in whole cents. */
interface SideLot {
  qty: number
  costCents: number
  realizedCents: number
  /** Whether the side was ever traded or redeemed, so a closed position stays listed. */
  touched: boolean
}

/**
 * Replay state for one market. Minted pairs stay unsplit (cost $1.00 each) until one leg is sold:
 * selling Yes out of a pair is a No purchase at `100 − price`, and buying Yes against held No is a
 * No sale at `100 − price` that turns the No back into a pair.
 */
interface MarketState {
  market: string
  yes: SideLot
  no: SideLot
  pairs: number
  outcome: OutcomeSide | null
  fills: number
  makerFills: number
}

interface Replay {
  states: MarketState[]
  trades: Trade[]
  lastYesPrice: Map<string, number>
}

function emptyLot(): SideLot {
  return { qty: 0, costCents: 0, realizedCents: 0, touched: false }
}

/** Removes `qty` tokens at average cost and returns the cost removed; the remainder stays exact. */
function takeFromLot(lot: SideLot, qty: number): number {
  if (qty === 0) return 0
  const removed = qty === lot.qty ? lot.costCents : Math.round((lot.costCents * qty) / lot.qty)
  lot.qty -= qty
  lot.costCents -= removed
  return removed
}

function replay(events: readonly ProgramEvent[], wallet: string): Replay {
  const byMarket = new Map<string, MarketState>()
  const trades: Trade[] = []
  const lastYesPrice = new Map<string, number>()

  function stateFor(market: string): MarketState {
    const existing = byMarket.get(market)
    if (existing) return existing
    const created: MarketState = {
      market,
      yes: emptyLot(),
      no: emptyLot(),
      pairs: 0,
      outcome: null,
      fills: 0,
      makerFills: 0,
    }
    byMarket.set(market, created)
    return created
  }

  function record(
    fill: OrderFilledEvent,
    side: OutcomeSide,
    action: Trade['action'],
    qty: number,
    priceCents: number,
    maker: boolean,
  ) {
    if (qty === 0) return
    trades.push({
      market: fill.market,
      signature: fill.signature,
      side,
      action,
      qty,
      priceCents,
      maker,
    })
  }

  function buyYes(state: MarketState, fill: OrderFilledEvent, maker: boolean) {
    const noPrice = PAIR_CENTS - fill.priceCents
    const fromNo = Math.min(fill.qty, state.no.qty)
    const removed = takeFromLot(state.no, fromNo)
    state.no.realizedCents += noPrice * fromNo - removed
    state.pairs += fromNo
    if (fromNo > 0) state.no.touched = true
    record(fill, 'No', 'Sell', fromNo, noPrice, maker)

    const rest = fill.qty - fromNo
    state.yes.qty += rest
    state.yes.costCents += fill.priceCents * rest
    if (rest > 0) state.yes.touched = true
    record(fill, 'Yes', 'Buy', rest, fill.priceCents, maker)
  }

  function sellYes(state: MarketState, fill: OrderFilledEvent, maker: boolean) {
    const noPrice = PAIR_CENTS - fill.priceCents
    const fromPairs = Math.min(fill.qty, state.pairs)
    state.pairs -= fromPairs
    state.no.qty += fromPairs
    state.no.costCents += noPrice * fromPairs
    if (fromPairs > 0) state.no.touched = true
    record(fill, 'No', 'Buy', fromPairs, noPrice, maker)

    const rest = Math.min(fill.qty - fromPairs, state.yes.qty)
    const removed = takeFromLot(state.yes, rest)
    state.yes.realizedCents += fill.priceCents * rest - removed
    if (rest > 0) state.yes.touched = true
    record(fill, 'Yes', 'Sell', rest, fill.priceCents, maker)
  }

  function onFill(fill: OrderFilledEvent) {
    lastYesPrice.set(fill.market, fill.priceCents)
    const isTaker = fill.taker === wallet
    const isMaker = fill.maker === wallet
    if (!isTaker && !isMaker) return
    const state = stateFor(fill.market)
    state.fills += 1
    if (isMaker) state.makerFills += 1
    // A self-trade applies both legs: the wallet buys and sells the same tokens.
    if (isTaker) {
      if (fill.takerSide === 'Bid') buyYes(state, fill, false)
      else sellYes(state, fill, false)
    }
    if (isMaker) {
      if (fill.takerSide === 'Ask') buyYes(state, fill, true)
      else sellYes(state, fill, true)
    }
  }

  function onMerge(state: MarketState, qty: number) {
    const fromPairs = Math.min(qty, state.pairs)
    state.pairs -= fromPairs
    // Pairs returned for $1.00 against a $1.00 cost realize nothing. Any further merge burns Yes
    // and No held separately; the Yes leg closes at cost and the No leg takes the gain or loss.
    const rest = Math.min(qty - fromPairs, state.yes.qty, state.no.qty)
    if (rest === 0) return
    const yesCost = takeFromLot(state.yes, rest)
    const noCost = takeFromLot(state.no, rest)
    state.no.realizedCents += PAIR_CENTS * rest - yesCost - noCost
    state.yes.touched = true
    state.no.touched = true
  }

  function onSettle(state: MarketState, outcome: OutcomeSide) {
    state.outcome = outcome
    // Unsplit pairs become one winning token worth $1.00 and one losing token worth $0.00.
    const winner = outcome === 'Yes' ? state.yes : state.no
    const loser = outcome === 'Yes' ? state.no : state.yes
    winner.qty += state.pairs
    winner.costCents += PAIR_CENTS * state.pairs
    loser.qty += state.pairs
    state.pairs = 0
  }

  function redeemLot(lot: SideLot, qty: number, payoutCents: number) {
    const taken = Math.min(qty, lot.qty)
    if (taken === 0) return
    const removed = takeFromLot(lot, taken)
    lot.realizedCents += payoutCents * taken - removed
    lot.touched = true
  }

  events.forEach((event) => {
    switch (event.kind) {
      case 'OrderFilled':
        onFill(event)
        return
      case 'PairMinted':
        if (event.owner === wallet) stateFor(event.market).pairs += event.qty
        return
      case 'PairMerged':
        if (event.owner === wallet) onMerge(stateFor(event.market), event.qty)
        return
      case 'MarketSettled': {
        const state = byMarket.get(event.market)
        if (state) onSettle(state, event.outcome)
        else stateFor(event.market).outcome = event.outcome
        return
      }
      case 'Redeemed': {
        if (event.owner !== wallet) return
        const state = stateFor(event.market)
        if (state.outcome === null) return
        redeemLot(state.yes, event.yesQty, state.outcome === 'Yes' ? PAIR_CENTS : 0)
        redeemLot(state.no, event.noQty, state.outcome === 'No' ? PAIR_CENTS : 0)
        return
      }
    }
  })

  const states = [...byMarket.values()].filter(
    (state) => state.yes.touched || state.no.touched || state.pairs > 0 || state.fills > 0,
  )
  return { states, trades, lastYesPrice }
}

/**
 * The Yes mark: the outcome once settled, else the caller's mark, else the last fill seen in the
 * events, else 50.
 */
function yesMark(state: MarketState, options: PortfolioOptions, replayed: Replay): number {
  if (state.outcome !== null) return state.outcome === 'Yes' ? PAIR_CENTS : 0
  return options.yesMarks.get(state.market) ?? replayed.lastYesPrice.get(state.market) ?? 50
}

/** Unsplit pairs are carried on both sides at the current marks, so they add no unrealized P&L. */
function sidePosition(state: MarketState, side: OutcomeSide, yesMarkCents: number): Position {
  const lot = side === 'Yes' ? state.yes : state.no
  const markCents = side === 'Yes' ? yesMarkCents : PAIR_CENTS - yesMarkCents
  const qty = lot.qty + state.pairs
  const costCents = lot.costCents + markCents * state.pairs
  const currentValueCents = markCents * qty
  return {
    market: state.market,
    side,
    qty,
    avgEntryCents: qty === 0 ? 0 : Math.round(costCents / qty),
    markCents,
    currentValueCents,
    realizedPnlCents: lot.realizedCents,
    unrealizedPnlCents: currentValueCents - costCents,
  }
}

export function computePortfolio(
  events: readonly ProgramEvent[],
  options: PortfolioOptions,
): Portfolio {
  const replayed = replay(events, options.wallet)
  const positions = replayed.states.flatMap((state) => {
    const mark = yesMark(state, options, replayed)
    const sides: OutcomeSide[] = ['Yes', 'No']
    return sides
      .filter((side) => {
        const lot = side === 'Yes' ? state.yes : state.no
        return lot.touched || lot.qty > 0 || state.pairs > 0
      })
      .map((side) => sidePosition(state, side, mark))
  })
  return { positions, trades: replayed.trades }
}

export function marketMakerSummary(
  events: readonly ProgramEvent[],
  options: PortfolioOptions,
): MarketExposure[] {
  const replayed = replay(events, options.wallet)
  return replayed.states.map((state) => {
    const mark = yesMark(state, options, replayed)
    const yes = sidePosition(state, 'Yes', mark)
    const no = sidePosition(state, 'No', mark)
    return {
      market: state.market,
      yes: yes.qty,
      no: no.qty,
      netYes: yes.qty - no.qty,
      fills: state.fills,
      makerFills: state.makerFills,
      realizedPnlCents: yes.realizedPnlCents + no.realizedPnlCents,
      unrealizedPnlCents: yes.unrealizedPnlCents + no.unrealizedPnlCents,
    }
  })
}
