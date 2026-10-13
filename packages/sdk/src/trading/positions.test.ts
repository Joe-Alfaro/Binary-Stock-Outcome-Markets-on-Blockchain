import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { computePortfolio, marketMakerSummary } from './index.js'
import type { BookSide, OutcomeSide, Portfolio, Position, ProgramEvent } from './index.js'

const ME = 'wallet-me'
const OTHER = 'wallet-other'
const MKT = 'market-aapl-230'

function fill(
  signature: string,
  maker: string,
  taker: string,
  takerSide: BookSide,
  priceCents: number,
  qty: number,
): ProgramEvent {
  return {
    kind: 'OrderFilled',
    signature,
    ts: 0,
    market: MKT,
    maker,
    taker,
    makerOrderId: `o-${signature}`,
    takerSide,
    priceCents,
    qty,
  }
}

function mint(signature: string, owner: string, qty: number): ProgramEvent {
  return { kind: 'PairMinted', signature, ts: 0, market: MKT, owner, qty }
}

function merge(signature: string, owner: string, qty: number): ProgramEvent {
  return { kind: 'PairMerged', signature, ts: 0, market: MKT, owner, qty }
}

function marks(yesMarkCents: number) {
  return { wallet: ME, yesMarks: new Map([[MKT, yesMarkCents]]) }
}

function position(portfolio: Portfolio, side: OutcomeSide): Position {
  const found = portfolio.positions.find((p) => p.market === MKT && p.side === side)
  assert.ok(found, `expected a ${side} position`)
  return found
}

function heldQty(portfolio: Portfolio, side: OutcomeSide): number {
  return portfolio.positions.find((p) => p.market === MKT && p.side === side)?.qty ?? 0
}

describe('R52 Yes positions', () => {
  it('averages entry across buys and realizes P&L on a sell', () => {
    const events = [
      fill('t1', OTHER, ME, 'Bid', 40, 2),
      fill('t2', OTHER, ME, 'Bid', 60, 2),
      fill('t3', OTHER, ME, 'Ask', 70, 1),
    ]
    const yes = position(computePortfolio(events, marks(65)), 'Yes')
    assert.equal(yes.qty, 3)
    assert.equal(yes.avgEntryCents, 50)
    assert.equal(yes.realizedPnlCents, 20)
    assert.equal(yes.markCents, 65)
    assert.equal(yes.currentValueCents, 195)
    assert.equal(yes.unrealizedPnlCents, 45)
  })

  it('ignores events between other wallets', () => {
    const events = [fill('t1', OTHER, 'wallet-third', 'Bid', 50, 4), mint('t2', OTHER, 9)]
    assert.deepEqual(computePortfolio(events, marks(50)).positions, [])
  })
})

describe('R52 No cost basis', () => {
  it('Buy No against a Yes bid of 0.60 records entry 0.40', () => {
    const events = [mint('buy', ME, 5), fill('buy', OTHER, ME, 'Ask', 60, 5)]
    const portfolio = computePortfolio(events, marks(60))
    const no = position(portfolio, 'No')
    assert.equal(no.qty, 5)
    assert.equal(no.avgEntryCents, 40)
    assert.equal(no.markCents, 40)
    assert.equal(no.unrealizedPnlCents, 0)
    assert.equal(heldQty(portfolio, 'Yes'), 0)
    assert.deepEqual(
      portfolio.trades.map(({ side, action, qty, priceCents, maker }) => ({
        side,
        action,
        qty,
        priceCents,
        maker,
      })),
      [{ side: 'No', action: 'Buy', qty: 5, priceCents: 40, maker: false }],
    )
  })

  it('Sell No against a Yes ask of 0.70 records exit 0.30 and realized -0.10 per token', () => {
    const events = [
      mint('buy', ME, 5),
      fill('buy', OTHER, ME, 'Ask', 60, 5),
      fill('sell', OTHER, ME, 'Bid', 70, 5),
      merge('sell', ME, 5),
    ]
    const portfolio = computePortfolio(events, marks(70))
    const no = position(portfolio, 'No')
    assert.equal(no.qty, 0)
    assert.equal(no.realizedPnlCents, -50)
    assert.equal(no.realizedPnlCents / 5, -10)
    assert.equal(no.unrealizedPnlCents, 0)
    assert.equal(heldQty(portfolio, 'Yes'), 0)
    const sell = portfolio.trades.find((t) => t.signature === 'sell')
    assert.deepEqual(
      sell && { side: sell.side, action: sell.action, qty: sell.qty, priceCents: sell.priceCents },
      { side: 'No', action: 'Sell', qty: 5, priceCents: 30 },
    )
  })

  it('a partly filled market Buy No keeps No only for the filled quantity at 1.00 minus the sale price', () => {
    const events = [mint('buy', ME, 5), fill('buy', OTHER, ME, 'Ask', 60, 3), merge('buy', ME, 2)]
    const portfolio = computePortfolio(events, marks(60))
    const no = position(portfolio, 'No')
    assert.equal(no.qty, 3)
    assert.equal(no.avgEntryCents, 40)
    assert.equal(no.realizedPnlCents, 0)
    assert.equal(heldQty(portfolio, 'Yes'), 0)
  })

  it('counts a maker fill of a resting Buy No limit, which lands in someone else transaction', () => {
    const events = [mint('place', ME, 5), fill('taker-tx', ME, OTHER, 'Bid', 62, 5)]
    const portfolio = computePortfolio(events, marks(62))
    const no = position(portfolio, 'No')
    assert.equal(no.qty, 5)
    assert.equal(no.avgEntryCents, 38)
    assert.equal(heldQty(portfolio, 'Yes'), 0)
    const trade = portfolio.trades.find((t) => t.signature === 'taker-tx')
    assert.deepEqual(
      trade && {
        side: trade.side,
        action: trade.action,
        qty: trade.qty,
        priceCents: trade.priceCents,
        maker: trade.maker,
      },
      { side: 'No', action: 'Buy', qty: 5, priceCents: 38, maker: true },
    )
  })

  it('counts a maker fill on a plain Yes bid', () => {
    const events = [fill('taker-tx', ME, OTHER, 'Ask', 45, 4)]
    const yes = position(computePortfolio(events, marks(50)), 'Yes')
    assert.equal(yes.qty, 4)
    assert.equal(yes.avgEntryCents, 45)
    assert.equal(yes.unrealizedPnlCents, 20)
  })
})

describe('R52 settlement and redemption', () => {
  it('values a winning Yes at 1.00 after settlement and realizes it on redeem', () => {
    const settled: ProgramEvent[] = [
      fill('t1', OTHER, ME, 'Bid', 55, 10),
      { kind: 'MarketSettled', signature: 's', ts: 0, market: MKT, outcome: 'Yes' },
    ]
    const before = position(computePortfolio(settled, marks(50)), 'Yes')
    assert.equal(before.markCents, 100)
    assert.equal(before.currentValueCents, 1000)
    assert.equal(before.unrealizedPnlCents, 450)

    const redeemed: ProgramEvent[] = [
      ...settled,
      { kind: 'Redeemed', signature: 'r', ts: 0, market: MKT, owner: ME, yesQty: 10, noQty: 0 },
    ]
    const after = position(computePortfolio(redeemed, marks(50)), 'Yes')
    assert.equal(after.qty, 0)
    assert.equal(after.realizedPnlCents, 450)
    assert.equal(after.unrealizedPnlCents, 0)
  })

  it('a losing No redeems for zero and realizes the full cost', () => {
    const events: ProgramEvent[] = [
      mint('buy', ME, 5),
      fill('buy', OTHER, ME, 'Ask', 60, 5),
      { kind: 'MarketSettled', signature: 's', ts: 0, market: MKT, outcome: 'Yes' },
      { kind: 'Redeemed', signature: 'r', ts: 0, market: MKT, owner: ME, yesQty: 0, noQty: 5 },
    ]
    const no = position(computePortfolio(events, marks(60)), 'No')
    assert.equal(no.qty, 0)
    assert.equal(no.realizedPnlCents, -200)
  })
})

describe('R52 market-maker exposure', () => {
  const quoting = [mint('m1', ME, 10), fill('taker-1', ME, OTHER, 'Bid', 60, 4)]

  it('reports net Yes and No per strike, fills and maker fills', () => {
    const [exposure, ...rest] = marketMakerSummary(quoting, marks(60))
    assert.equal(rest.length, 0)
    assert.ok(exposure)
    assert.equal(exposure.market, MKT)
    assert.equal(exposure.yes, 6)
    assert.equal(exposure.no, 10)
    assert.equal(exposure.netYes, -4)
    assert.equal(exposure.fills, 1)
    assert.equal(exposure.makerFills, 1)
    assert.equal(exposure.realizedPnlCents, 0)
    assert.equal(exposure.unrealizedPnlCents, 0)
  })

  it('marks the exposure to the current Yes price', () => {
    const [exposure] = marketMakerSummary(quoting, marks(70))
    assert.equal(exposure?.unrealizedPnlCents, -40)
  })

  it('realizes the spread after buying back and merging', () => {
    const events = [...quoting, fill('mine', OTHER, ME, 'Bid', 50, 4), merge('m2', ME, 10)]
    const [exposure] = marketMakerSummary(events, marks(55))
    assert.ok(exposure)
    assert.equal(exposure.yes, 0)
    assert.equal(exposure.no, 0)
    assert.equal(exposure.fills, 2)
    assert.equal(exposure.makerFills, 1)
    assert.equal(exposure.realizedPnlCents, 40)
    assert.equal(exposure.unrealizedPnlCents, 0)
  })
})
