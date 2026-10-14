import './support/non-et-timezone'
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { cleanup, screen, within } from '@testing-library/react'
import { MarketsPage } from '../src/components'
import { TICKERS } from '../src/lib/chain'
import type { LatestPrice } from '../src/lib/chain'
import { assertNoAxeViolations } from './support/axe'
import { intradaySeries } from './support/fake-intraday'
import { createHarness, renderWith } from './support/render'

afterEach(cleanup)

const utc = (iso: string) => Date.parse(iso) / 1000

/** Tue 2026-10-13 8:00 PM EDT: closed, the last session is Tuesday's. */
const TUESDAY_EVENING = utc('2026-10-14T00:00:00Z')
const TUESDAY_OPEN = utc('2026-10-13T13:30:00Z')
/** Mon 2026-10-12 10:20 AM EDT, mid-session. */
const MID_SESSION = utc('2026-10-12T14:20:00Z')
const MONDAY_OPEN = utc('2026-10-12T13:30:00Z')

/** AAPL's Tuesday session from the worker's intraday route: it closed at 187.25. */
const AAPL_TUESDAY = intradaySeries({
  ticker: 'AAPL',
  live: false,
  sessionDate: '2026-10-13',
  openTs: TUESDAY_OPEN,
  prices: [190, 188.4, 189.1, 187.25],
  stepSecs: 7800,
})

/** AAPL live on Monday, last at 231.42. */
const AAPL_LIVE = intradaySeries({
  ticker: 'AAPL',
  live: true,
  sessionDate: '2026-10-12',
  openTs: MONDAY_OPEN,
  prices: [230, 231.42],
  stepSecs: 600,
})

/** A fresh local chain: no on-chain latest price for any ticker. */
function freshChain(now: number) {
  const harness = createHarness({ now })
  harness.chain.prices = []
  return harness
}

function priced(now: number, price: number) {
  const harness = createHarness({ now })
  harness.chain.prices = TICKERS.map((ticker): LatestPrice => ({
    ticker,
    price,
    publishTs: now - 30,
  }))
  return harness
}

async function aaplCard() {
  return screen.findByRole('article', { name: 'AAPL' })
}

/** The card's visible text: chart text alternatives sit in aria-labels and don't count. */
function cardText(card: HTMLElement) {
  return card.textContent ?? ''
}

/** Waits until the card's visible text matches `pattern`, failing with the text it found. */
async function waitForText(card: HTMLElement, pattern: RegExp) {
  try {
    await within(card).findByText(
      (_, element) =>
        element !== null &&
        pattern.test(element.textContent ?? '') &&
        element.children.length === 0,
      undefined,
      { timeout: 1000 },
    )
  } catch {
    assert.fail(`expected ${pattern} in the card, found: ${cardText(card)}`)
  }
}

// R69: while closed the price line shows the last session's close, labelled "Last close".
describe('R69 Last close on Markets cards while closed', () => {
  it("a closed card on a fresh chain shows 'Last close' with the worker's session close", async () => {
    const harness = freshChain(TUESDAY_EVENING)
    harness.intraday.series.set('AAPL', AAPL_TUESDAY)
    renderWith(harness, <MarketsPage />)
    const card = await aaplCard()
    await waitForText(card, /Last close/)
    assert.match(cardText(card), /\$187\.25/, 'the session close is shown')
  })

  it("a closed card on a fresh chain shows no 'Waiting for the first price' and no dash", async () => {
    const harness = freshChain(TUESDAY_EVENING)
    harness.intraday.series.set('AAPL', AAPL_TUESDAY)
    renderWith(harness, <MarketsPage />)
    const card = await aaplCard()
    await waitForText(card, /Last close/)
    assert.equal(within(card).queryByText(/Waiting for the first price/), null)
    assert.equal(within(card).queryByText('—'), null, 'no placeholder dash for the price')
  })

  it('a closed card prefers the on-chain latest price over the worker close', async () => {
    const harness = priced(TUESDAY_EVENING, 186.9)
    harness.intraday.series.set('AAPL', AAPL_TUESDAY)
    renderWith(harness, <MarketsPage />)
    const card = await aaplCard()
    await waitForText(card, /Last close/)
    assert.ok(within(card).getByText('$186.90'), 'the on-chain price is the price line')
    assert.doesNotMatch(cardText(card), /\$187\.25/, 'the worker close is not shown as the price')
  })
})

// R69 with R47: while open, the price line is unchanged.
describe('R69 open market keeps R47 behaviour', () => {
  it("an open card with no on-chain price still waits for the first price, with no 'Last close'", async () => {
    const harness = freshChain(MID_SESSION)
    harness.intraday.series.set('AAPL', AAPL_LIVE)
    renderWith(harness, <MarketsPage />)
    const card = await aaplCard()
    await within(card).findByText('Live · today')
    assert.ok(within(card).getByText('Waiting for the first price'))
    assert.ok(within(card).getByText('—'))
    assert.doesNotMatch(cardText(card), /Last close/)
  })

  it("an open card shows the on-chain price with its publish time, not 'Last close'", async () => {
    const harness = priced(MID_SESSION, 231.5)
    harness.intraday.series.set('AAPL', AAPL_LIVE)
    renderWith(harness, <MarketsPage />)
    const card = await aaplCard()
    await within(card).findByText('$231.50')
    assert.ok(within(card).getByText(/^As of /))
    assert.doesNotMatch(cardText(card), /Last close/)
  })
})

describe('R69 accessibility', () => {
  it("has no axe violations with 'Last close' shown on a closed card", async () => {
    const harness = freshChain(TUESDAY_EVENING)
    TICKERS.forEach((ticker) => harness.intraday.series.set(ticker, { ...AAPL_TUESDAY, ticker }))
    const { container } = renderWith(harness, <MarketsPage />)
    const card = await aaplCard()
    await waitForText(card, /Last close/)
    await assertNoAxeViolations(container)
  })
})
