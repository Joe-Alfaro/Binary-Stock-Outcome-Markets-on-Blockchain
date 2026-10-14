import './support/non-et-timezone'
import assert from 'node:assert/strict'
import { afterEach, describe, it, mock } from 'node:test'
import { act, cleanup, screen, within } from '@testing-library/react'
import { MarketsPage } from '../src/components'
import { TICKERS } from '../src/lib/chain'
import type { LatestPrice, Ticker } from '../src/lib/chain'
import { assertNoAxeViolations } from './support/axe'
import { createHarness, renderWith } from './support/render'

afterEach(() => {
  mock.timers.reset()
  cleanup()
})

const utc = (iso: string) => Date.parse(iso) / 1000

/** Fri 2026-10-16 6:00 PM EDT, already Saturday in Tokyo. */
const FRIDAY_EVENING = utc('2026-10-16T22:00:00Z')
/** Sat 2026-10-17 noon EDT. */
const SATURDAY = utc('2026-10-17T16:00:00Z')
/** Wed 2026-10-14 7:00 AM EDT. */
const WEDNESDAY_EARLY = utc('2026-10-14T11:00:00Z')
/** Tue 2026-10-13 8:00 PM EDT. */
const TUESDAY_EVENING = utc('2026-10-14T00:00:00Z')
/** Mon 2026-10-12 10:20 AM EDT, mid-session. */
const MID_SESSION = utc('2026-10-12T14:20:00Z')
/** Mon 2026-10-12 9:30 AM and 4:00 PM EDT. */
const MONDAY_OPEN = utc('2026-10-12T13:30:00Z')
const MONDAY_CLOSE = utc('2026-10-12T20:00:00Z')

/**
 * Every ticker priced, published `ageSecs` before `now`. The intraday worker is left unset, so the
 * cards show "Chart unavailable" and only the tag and the stale marker are under test.
 */
function setup(now: number, ageSecs = 30) {
  const harness = createHarness({ now })
  harness.chain.prices = TICKERS.map((ticker): LatestPrice => ({
    ticker,
    price: 100,
    publishTs: now - ageSecs,
  }))
  return harness
}

async function card(ticker: Ticker) {
  return screen.findByRole('article', { name: ticker })
}

/** The card's Closed tag: a status exposed to screen readers, named by its text. */
function closedTag(container: HTMLElement) {
  return within(container).queryByRole('status', { name: /^Closed\b/ })
}

function staleMarker(container: HTMLElement) {
  return within(container).queryByText(/^stale$/i)
}

/** Settles React work without real timers: the fakes answer in microtasks. */
async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => {})
}

/** Moves the injected clock to `to` and lets at most 60 s of timers run, with no re-render. */
async function advanceTo(harness: ReturnType<typeof setup>, to: number) {
  harness.clock.now = to
  await act(async () => {
    mock.timers.tick(60_000)
  })
  await settle()
}

// R68: a Closed tag with the next open on each Markets card while the regular session is closed.
describe('R68 Closed tag on Markets cards', () => {
  it('renders in a browser time zone other than ET', () => {
    assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Tokyo')
  })

  it("Friday after the close tags every card 'Closed' and 'Reopens Mon 9:30 AM ET'", async () => {
    renderWith(setup(FRIDAY_EVENING), <MarketsPage />)
    await card('AAPL')
    TICKERS.forEach((ticker) => {
      const article = screen.getByRole('article', { name: ticker })
      const tag = closedTag(article)
      assert.ok(tag, `${ticker} has a Closed tag`)
      assert.ok(within(article).getByText('Closed'), `${ticker} shows 'Closed' as text`)
      assert.ok(within(article).getByText('Reopens Mon 9:30 AM ET'), `${ticker} shows the reopen`)
    })
  })

  it('gives the tag an accessible name with the reopen time', async () => {
    renderWith(setup(FRIDAY_EVENING), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(within(aapl).getByRole('status', { name: /^Closed\b.*Reopens Mon 9:30 AM ET/ }))
  })

  it("puts the tag in the card's header, beside the ticker", async () => {
    renderWith(setup(FRIDAY_EVENING), <MarketsPage />)
    const aapl = await card('AAPL')
    const header = within(aapl).getByRole('heading', { name: 'AAPL' }).closest('header')
    assert.ok(header, 'the card has a header')
    assert.ok(header.contains(closedTag(aapl)), 'the tag sits in the header')
  })

  it("Saturday reopens 'Mon'", async () => {
    renderWith(setup(SATURDAY), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(within(aapl).getByRole('status', { name: /Reopens Mon 9:30 AM ET/ }))
  })

  it("a weekday before the open reopens 'today'", async () => {
    renderWith(setup(WEDNESDAY_EARLY), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(within(aapl).getByRole('status', { name: /Reopens today 9:30 AM ET/ }))
    assert.ok(within(aapl).getByText('Reopens today 9:30 AM ET'))
  })

  it("a weekday evening reopens 'tomorrow'", async () => {
    renderWith(setup(TUESDAY_EVENING), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(within(aapl).getByRole('status', { name: /Reopens tomorrow 9:30 AM ET/ }))
  })

  it('the day before a holiday reopens on the next trading day', async () => {
    // Wed 2026-11-25 5:00 PM EST; Thursday is Thanksgiving.
    renderWith(setup(utc('2026-11-25T22:00:00Z')), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(within(aapl).getByRole('status', { name: /Reopens Fri 9:30 AM ET/ }))
  })

  it('an early-close day after 1:00 PM ET reopens Mon', async () => {
    // Fri 2026-11-27 2:00 PM EST.
    renderWith(setup(utc('2026-11-27T19:00:00Z')), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(within(aapl).getByRole('status', { name: /Reopens Mon 9:30 AM ET/ }))
  })

  it('shows no Closed tag mid-session', async () => {
    renderWith(setup(MID_SESSION), <MarketsPage />)
    await card('AAPL')
    TICKERS.forEach((ticker) => {
      const article = screen.getByRole('article', { name: ticker })
      assert.equal(closedTag(article), null, `${ticker} has no tag`)
      assert.equal(within(article).queryByText(/Reopens/), null, `${ticker} has no reopen line`)
    })
  })

  it('removes the tag at 9:30 AM ET without a reload', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const harness = setup(MONDAY_OPEN - 30)
    renderWith(harness, <MarketsPage />)
    await settle()
    const aapl = screen.getByRole('article', { name: 'AAPL' })
    assert.ok(within(aapl).getByRole('status', { name: /Reopens today 9:30 AM ET/ }))

    await advanceTo(harness, MONDAY_OPEN)
    assert.equal(closedTag(screen.getByRole('article', { name: 'AAPL' })), null)
  })

  it("adds the tag at 4:00 PM ET without a reload, reopening 'tomorrow'", async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const harness = setup(MONDAY_CLOSE - 30)
    renderWith(harness, <MarketsPage />)
    await settle()
    assert.equal(closedTag(screen.getByRole('article', { name: 'AAPL' })), null)

    await advanceTo(harness, MONDAY_CLOSE)
    const aapl = screen.getByRole('article', { name: 'AAPL' })
    assert.ok(within(aapl).getByRole('status', { name: /^Closed\b.*Reopens tomorrow 9:30 AM ET/ }))
  })
})

// R68 with R47: the stale marker applies while open; the Closed tag replaces it while closed.
describe('R68 stale marker only while open', () => {
  it('marks a price over 5 minutes old as stale mid-session, with no Closed tag', async () => {
    renderWith(setup(MID_SESSION, 360), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(await within(aapl).findByText(/^stale$/i), 'stale while open')
    assert.equal(closedTag(aapl), null)
  })

  it('shows the Closed tag and no stale marker for an old price while closed', async () => {
    // The last price is from Friday's close, more than a day old.
    renderWith(setup(SATURDAY, 20 * 3600), <MarketsPage />)
    const aapl = await card('AAPL')
    await within(aapl).findByText('$100.00')
    assert.ok(closedTag(aapl), 'Closed tag while closed')
    assert.equal(staleMarker(aapl), null, 'no stale marker while closed')
  })

  it('swaps the stale marker for the Closed tag at the close, never showing both', async () => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
    const harness = setup(MONDAY_CLOSE - 30, 600)
    renderWith(harness, <MarketsPage />)
    await settle()
    const before = screen.getByRole('article', { name: 'AAPL' })
    assert.ok(staleMarker(before), 'stale just before the close')
    assert.equal(closedTag(before), null)

    await advanceTo(harness, MONDAY_CLOSE)
    const after = screen.getByRole('article', { name: 'AAPL' })
    assert.ok(closedTag(after), 'Closed tag at the close')
    assert.equal(staleMarker(after), null, 'the Closed tag replaces the stale marker')
  })
})

describe('R68 accessibility', () => {
  it('has no axe violations with the Closed tags shown', async () => {
    const { container } = renderWith(setup(FRIDAY_EVENING), <MarketsPage />)
    const aapl = await card('AAPL')
    assert.ok(closedTag(aapl), 'the tags are rendered')
    await assertNoAxeViolations(container)
  })
})
