import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { executableQuotes, impliedNoPrice, noView } from './index.js'
import { yesBookFixture } from './fixtures/yes-book.js'

describe('R29 No view of the Yes book', () => {
  it('maps Yes bid 60 / ask 65 to No bid 35 / ask 40', () => {
    const view = noView({ bids: [{ priceCents: 60, qty: 5 }], asks: [{ priceCents: 65, qty: 7 }] })
    assert.deepEqual(view.bids, [{ priceCents: 35, qty: 7 }])
    assert.deepEqual(view.asks, [{ priceCents: 40, qty: 5 }])
  })

  it('builds No asks from Yes bids and No bids from Yes asks, same quantities, best-first', () => {
    const view = noView(yesBookFixture)
    assert.deepEqual(view.asks, [
      { priceCents: 40, qty: 25 },
      { priceCents: 42, qty: 40 },
      { priceCents: 45, qty: 100 },
    ])
    assert.deepEqual(view.bids, [
      { priceCents: 35, qty: 10 },
      { priceCents: 33, qty: 50 },
      { priceCents: 30, qty: 30 },
    ])
  })

  it('does not mutate the Yes book', () => {
    const before = structuredClone(yesBookFixture)
    noView(yesBookFixture)
    assert.deepEqual(yesBookFixture, before)
  })
})

describe('R29 executable quotes', () => {
  it('quotes Buy No against the best Yes bid and Sell No against the best Yes ask', () => {
    assert.deepEqual(executableQuotes(yesBookFixture), {
      buyYes: 65,
      sellYes: 60,
      buyNo: 40,
      sellNo: 35,
    })
  })

  it('returns null for quotes whose Yes side is empty', () => {
    assert.deepEqual(executableQuotes({ bids: [], asks: [{ priceCents: 65, qty: 1 }] }), {
      buyYes: 65,
      sellYes: null,
      buyNo: null,
      sellNo: 35,
    })
  })

  it('implied No price is 100 minus the Yes price', () => {
    assert.equal(impliedNoPrice(60), 40)
    assert.equal(impliedNoPrice(1), 99)
  })
})
