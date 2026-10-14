import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { act, cleanup, screen, within } from '@testing-library/react'
import { MarketsPage } from '../src/components'
import { TICKERS } from '../src/lib/chain'
import type { LatestPrice, Ticker } from '../src/lib/chain'
import { INTRADAY_REFRESH_MS } from '../src/lib/intraday'
import { assertNoAxeViolations } from './support/axe'
import { intradaySeries } from './support/fake-intraday'
import { contract, REGULAR_NOW } from './support/fixtures'
import { createHarness, renderWith } from './support/render'

afterEach(() => {
  mock.timers.reset()
  cleanup()
})

const utc = (iso: string) => Date.parse(iso) / 1000

/** Monday 2026-10-12's open, 9:30 AM EDT; REGULAR_NOW is 10:20 AM, mid-session. */
const LIVE_OPEN = utc('2026-10-12T13:30:00Z')
/** Saturday 2026-10-10, noon EDT: the chart shows Friday 2026-10-09's session. */
const WEEKEND_NOW = utc('2026-10-10T16:00:00Z')
const FRIDAY_OPEN = utc('2026-10-09T13:30:00Z')

/** AAPL from 230.00 at the open to 231.42 now: +0.62%. */
const AAPL_LIVE = intradaySeries({
  ticker: 'AAPL',
  live: true,
  sessionDate: '2026-10-12',
  openTs: LIVE_OPEN,
  prices: [230, 229.5, 230.8, 231.1, 231.42],
  stepSecs: 600,
})

/** MSFT from 400.00 to 395.00: −1.25%. */
const MSFT_LIVE = intradaySeries({
  ticker: 'MSFT',
  live: true,
  sessionDate: '2026-10-12',
  openTs: LIVE_OPEN,
  prices: [400, 398, 395],
  stepSecs: 600,
})

/** AAPL's full Friday session, 243.80 at the open to 245.27 at the close: +0.60%. */
const AAPL_FRIDAY = intradaySeries({
  ticker: 'AAPL',
  live: false,
  sessionDate: '2026-10-09',
  openTs: FRIDAY_OPEN,
  prices: [243.8, 244.9, 243.3, 247.3, 245.27],
  stepSecs: 5850,
})

function flatSeries(ticker: Ticker, live: boolean, sessionDate: string, openTs: number) {
  return intradaySeries({ ticker, live, sessionDate, openTs, prices: [100, 100.5, 100] })
}

function setup(now = REGULAR_NOW) {
  const harness = createHarness({ now })
  harness.chain.prices = TICKERS.map((ticker): LatestPrice => ({
    ticker,
    price: ticker === 'AAPL' ? 231.42 : 100,
    publishTs: now - 30,
  }))
  harness.chain.markets = [
    contract({ market: 'aapl-225', strike: 225 }),
    contract({ market: 'aapl-230', strike: 230 }),
  ]
  const live = now === REGULAR_NOW
  TICKERS.forEach((ticker) =>
    harness.intraday.series.set(
      ticker,
      live
        ? flatSeries(ticker, true, '2026-10-12', LIVE_OPEN)
        : flatSeries(ticker, false, '2026-10-09', FRIDAY_OPEN),
    ),
  )
  if (live) {
    harness.intraday.series.set('AAPL', AAPL_LIVE)
    harness.intraday.series.set('MSFT', MSFT_LIVE)
  } else {
    harness.intraday.series.set('AAPL', AAPL_FRIDAY)
  }
  return harness
}

async function card(ticker: Ticker) {
  return screen.findByRole('article', { name: ticker })
}

/** The card's chart: an image whose accessible name is the text alternative. */
async function chartIn(ticker: Ticker) {
  return within(await card(ticker)).findByRole('img', { name: new RegExp(ticker) })
}

/** Visible text matching `pattern`, outside the chart graphic itself. */
function visibleText(container: HTMLElement, pattern: RegExp): HTMLElement[] {
  return within(container)
    .queryAllByText(pattern)
    .filter((element) => !element.closest('svg'))
}

// R66: each Markets card shows a line chart of today's or the last complete session.
describe('R66 markets card chart', () => {
  it('renders a line chart of the series on every card', async () => {
    renderWith(setup(), <MarketsPage />)
    const chart = await chartIn('AAPL')
    assert.ok(chart.querySelector('polyline, path'), 'the chart draws a line')
    for (const ticker of TICKERS) {
      const img = await chartIn(ticker)
      assert.ok(img.querySelector('polyline, path'), `${ticker} draws a line`)
    }
  })

  it("labels an open session 'Live · today' with the signed change since the open", async () => {
    renderWith(setup(), <MarketsPage />)
    await chartIn('AAPL')
    const aapl = await card('AAPL')
    assert.equal(visibleText(aapl, /Live · today/).length, 1)
    assert.ok(visibleText(aapl, /\+0\.62%/).length >= 1, 'shows +0.62%')
    assert.equal(visibleText(aapl, /Closed/).length, 0)
  })

  it('shows a fall since the open as a negative percentage', async () => {
    renderWith(setup(), <MarketsPage />)
    await chartIn('MSFT')
    const msft = await card('MSFT')
    assert.ok(visibleText(msft, /[−-]1\.25%/).length >= 1, 'shows −1.25%')
  })

  it("labels a closed market 'Closed · <date>' with that session's change", async () => {
    renderWith(setup(WEEKEND_NOW), <MarketsPage />)
    await chartIn('AAPL')
    const aapl = await card('AAPL')
    assert.equal(visibleText(aapl, /Closed · .*\bOct\w* 9\b/).length, 1)
    assert.ok(visibleText(aapl, /\+0\.60%/).length >= 1, 'shows +0.60%')
    assert.equal(visibleText(aapl, /Live/).length, 0)
  })

  it('gives the live chart a text alternative with the open, last price and change', async () => {
    renderWith(setup(), <MarketsPage />)
    const chart = await chartIn('AAPL')
    const name = chart.getAttribute('aria-label') ?? chart.textContent ?? ''
    assert.match(name, /open \$230\.00/i)
    assert.match(name, /last \$231\.42/i)
    assert.match(name, /\+0\.62%/)
  })

  it('gives the closed chart a text alternative with the open, close and change', async () => {
    renderWith(setup(WEEKEND_NOW), <MarketsPage />)
    const chart = await chartIn('AAPL')
    const name = chart.getAttribute('aria-label') ?? chart.textContent ?? ''
    assert.match(name, /open \$243\.80/i)
    assert.match(name, /close \$245\.27/i)
    assert.match(name, /\+0\.60%/)
  })

  it("shows 'Chart unavailable' for an empty series and keeps the rest of the card", async () => {
    const harness = setup()
    harness.intraday.series.set('AAPL', { ...AAPL_LIVE, points: [] })
    renderWith(harness, <MarketsPage />)
    await chartIn('MSFT')
    const aapl = await card('AAPL')
    assert.ok(await within(aapl).findByText('Chart unavailable'))
    assert.equal(within(aapl).queryByRole('img'), null)
    assert.ok(within(aapl).getByText('$231.42'))
    assert.ok(within(aapl).getByText(/2 active contracts/i))
    assert.equal(within(aapl).getByRole('link').getAttribute('href'), '/trade/AAPL')
  })

  it("shows 'Chart unavailable' when the worker errors and keeps the other charts", async () => {
    const harness = setup()
    harness.intraday.series.set('AAPL', new Error('503 rate-limited'))
    renderWith(harness, <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(await within(aapl).findByText('Chart unavailable'))
    assert.ok(within(aapl).getByText('$231.42'))
    assert.ok(within(aapl).getByRole('link', { name: /trade aapl/i }))
    assert.ok(await chartIn('MSFT'), 'other cards still chart')
  })

  it('reads the series only through the worker client, never the network directly', async () => {
    const realFetch = globalThis.fetch
    const fetchCalls: unknown[] = []
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls.push(args)
      return Promise.reject(new Error('the card must not fetch directly'))
    }) as typeof fetch
    try {
      const harness = setup()
      renderWith(harness, <MarketsPage />)
      await chartIn('AAPL')
      TICKERS.forEach((ticker) => assert.ok(harness.intraday.callsFor(ticker) >= 1, ticker))
      assert.equal(fetchCalls.length, 0)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('refreshes the chart at least every 60 s while the session is open', async () => {
    assert.ok(INTRADAY_REFRESH_MS <= 60_000)
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const harness = setup()
    renderWith(harness, <MarketsPage />)
    // Settle the first load without real timers: the fake client answers in microtasks.
    for (let i = 0; i < 5; i += 1) await act(async () => {})
    const before = harness.intraday.callsFor('AAPL')
    assert.equal(before, 1, 'loaded once on mount')
    assert.ok(screen.getByRole('img', { name: /AAPL.*last \$231\.42/i }))

    harness.intraday.series.set('AAPL', {
      ...AAPL_LIVE,
      endTs: AAPL_LIVE.endTs + 60,
      points: [...AAPL_LIVE.points, { t: AAPL_LIVE.endTs + 60, price: 232.3 }],
    })
    await act(async () => {
      mock.timers.tick(60_000)
    })
    for (let i = 0; i < 5; i += 1) await act(async () => {})

    assert.ok(harness.intraday.callsFor('AAPL') >= 2, 'asked the worker again within 60 s')
    assert.ok(screen.getByRole('img', { name: /AAPL.*last \$232\.30/i }))
    assert.ok(visibleText(screen.getByRole('article', { name: 'AAPL' }), /\+1\.00%/).length >= 1)
  })

  it('has no axe violations with the charts drawn', async () => {
    const { container } = renderWith(setup(), <MarketsPage />)
    await chartIn('AAPL')
    await chartIn('TSLA')
    await assertNoAxeViolations(container)
  })

  it("has no axe violations with 'Chart unavailable'", async () => {
    const harness = setup()
    TICKERS.forEach((ticker) => harness.intraday.series.set(ticker, new Error('down')))
    const { container } = renderWith(harness, <MarketsPage />)
    await within(await card('AAPL')).findByText('Chart unavailable')
    await assertNoAxeViolations(container)
  })
})
