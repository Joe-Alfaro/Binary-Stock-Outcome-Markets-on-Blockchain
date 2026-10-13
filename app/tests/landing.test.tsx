import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { cleanup, screen } from '@testing-library/react'
import { LandingPage } from '../src/components'
import { TICKERS } from '../src/lib/chain'
import { REGULAR_NOW } from './support/fixtures'
import { createHarness, renderWith } from './support/render'

afterEach(cleanup)

describe('R49 landing page', () => {
  it('explains the product, shows live prices and asks to connect a wallet', async () => {
    const harness = createHarness({ now: REGULAR_NOW })
    harness.chain.prices = TICKERS.map((ticker, i) => ({
      ticker,
      price: 100 + i + 0.25,
      publishTs: REGULAR_NOW - 30,
    }))
    renderWith(harness, <LandingPage />)

    assert.ok(screen.getByRole('heading', { level: 1, name: 'Meridian' }))
    assert.ok(screen.getAllByText(/closes at or above/i).length > 0, 'explains the Yes/No question')
    assert.ok(screen.getAllByText(/\$1\.00/).length > 0, 'explains the $1.00 payout')
    assert.ok(await screen.findByText('$100.25'))
    TICKERS.forEach((ticker) => assert.ok(screen.getAllByText(ticker).length > 0, ticker))
    assert.ok(screen.getByRole('button', { name: /connect wallet/i }))
  })
})
