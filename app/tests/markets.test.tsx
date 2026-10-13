import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { cleanup, screen, within } from '@testing-library/react'
import { MarketsPage } from '../src/components'
import { TICKERS } from '../src/lib/chain'
import type { LatestPrice } from '../src/lib/chain'
import { assertNoAxeViolations } from './support/axe'
import { contract, REGULAR_NOW } from './support/fixtures'
import { createHarness, renderWith } from './support/render'

afterEach(cleanup)

function setup() {
  const harness = createHarness({ now: REGULAR_NOW })
  harness.chain.prices = TICKERS.map((ticker): LatestPrice => ({
    ticker,
    price: ticker === 'AAPL' ? 231.42 : 100,
    // TSLA last published 6 minutes ago; everything else 30 seconds ago.
    publishTs: ticker === 'TSLA' ? REGULAR_NOW - 360 : REGULAR_NOW - 30,
  }))
  harness.chain.markets = [
    contract({ market: 'aapl-225', strike: 225 }),
    contract({ market: 'aapl-230', strike: 230 }),
    contract({ market: 'aapl-235', strike: 235 }),
    contract({
      market: 'aapl-old',
      strike: 220,
      status: 'Settled',
      settlement: { price: 229.1, source: 'Oracle', outcome: 'Yes' },
    }),
    contract({ market: 'msft-400', ticker: 'MSFT', strike: 400 }),
  ]
  return harness
}

async function card(ticker: string) {
  return screen.findByRole('article', { name: ticker })
}

describe('R50 markets grid', () => {
  it('shows a card for each of the 7 tickers', async () => {
    renderWith(setup(), <MarketsPage />)
    await card('AAPL')
    assert.equal(screen.getAllByRole('article').length, 7)
    TICKERS.forEach((ticker) => assert.ok(screen.getByRole('article', { name: ticker }), ticker))
  })

  it('shows the live price and the number of active contracts', async () => {
    renderWith(setup(), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(within(aapl).getByText('$231.42'))
    assert.ok(within(aapl).getByText(/3 active contracts/i))
    assert.ok(
      within(screen.getByRole('article', { name: 'MSFT' })).getByText(/1 active contract\b/i),
    )
    assert.ok(
      within(screen.getByRole('article', { name: 'NVDA' })).getByText(/0 active contracts/i),
    )
  })

  it('links each card to its trade page', async () => {
    renderWith(setup(), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.equal(within(aapl).getByRole('link').getAttribute('href'), '/trade/AAPL')
  })
})

describe('R47 live prices from the oracle accounts', () => {
  it('shows each publish time in ET', async () => {
    renderWith(setup(), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(within(aapl).getByText(/10:19:30\sAM ET/))
  })

  it('marks a price older than 5 minutes as stale', async () => {
    renderWith(setup(), <MarketsPage />)
    const tsla = await card('TSLA')
    assert.ok(within(tsla).getByText(/stale/i))
    assert.equal(within(screen.getByRole('article', { name: 'AAPL' })).queryByText(/stale/i), null)
  })

  it('updates when the latest-price account changes', async () => {
    const harness = setup()
    renderWith(harness, <MarketsPage />)
    const tsla = await card('TSLA')
    harness.chain.pushPrice({ ticker: 'TSLA', price: 251.07, publishTs: REGULAR_NOW })
    assert.ok(await within(tsla).findByText('$251.07'))
    assert.equal(within(tsla).queryByText(/stale/i), null)
  })
})

describe('R56 markets accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = renderWith(setup(), <MarketsPage />)
    await card('AAPL')
    await assertNoAxeViolations(container)
  })
})
