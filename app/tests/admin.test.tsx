import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, it } from 'node:test'
import { cleanup, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AdminPage, SiteNav } from '../src/components'
import type { TickerDaySummary } from '../src/lib/chain'
import { assertNoAxeViolations } from './support/axe'
import { OTHER_WALLET, WALLET } from './support/fake-chain'
import { EARLY_CLOSE, REGULAR_CLOSE } from './support/fixtures'
import { createHarness, renderWith } from './support/render'
import type { Harness } from './support/render'

afterEach(cleanup)

const PROPOSE_AT = REGULAR_CLOSE + 900
const FINALIZE_AT = REGULAR_CLOSE + 3600

function tickerDay(overrides: Partial<TickerDaySummary> = {}): TickerDaySummary {
  return {
    ticker: 'AAPL',
    tradingDay: '2026-10-12',
    closeTs: REGULAR_CLOSE,
    status: 'Open',
    pendingAdminPrice: null,
    ...overrides,
  }
}

/** The connected test wallet is `Config.admin` unless `admin` says otherwise. */
function adminHarness(
  now: number,
  options: { admin?: string; connected?: boolean; days?: TickerDaySummary[] } = {},
): Harness {
  const harness = createHarness({ now, connected: options.connected ?? true })
  harness.chain.adminConfig.admin = options.admin ?? WALLET
  harness.chain.tickerDays = options.days ?? [tickerDay()]
  return harness
}

/** The Admin page's section for one ticker and day, named by its ticker. */
async function daySection(ticker = 'AAPL') {
  return screen.findByRole('region', { name: new RegExp(ticker) })
}

function programFailure(name: string, number: number): Error & { logs: string[] } {
  return Object.assign(new Error('Simulation failed.'), {
    logs: [
      `Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${number}. Error Message: x.`,
    ],
  })
}

function assertNoAdminControls(): void {
  assert.equal(screen.queryByRole('button', { name: /propose/i }), null)
  assert.equal(screen.queryByRole('button', { name: /finalize/i }), null)
  assert.equal(screen.queryByRole('button', { name: /pause/i }), null)
  assert.equal(screen.queryByRole('textbox'), null)
  assert.equal(screen.queryByRole('spinbutton'), null)
}

describe('R70 Admin link', () => {
  it('shows an Admin link to /admin when the connected wallet is Config.admin', async () => {
    renderWith(adminHarness(PROPOSE_AT), <SiteNav />)
    const link = await screen.findByRole('link', { name: 'Admin' })
    assert.equal(link.getAttribute('href'), '/admin')
    ;['Markets', 'Portfolio', 'History'].forEach((name) => {
      assert.ok(screen.getByRole('link', { name }), `${name} link`)
    })
  })

  it('never shows the Admin link to a regular wallet', async () => {
    renderWith(adminHarness(PROPOSE_AT, { admin: OTHER_WALLET }), <SiteNav />)
    await screen.findByRole('link', { name: 'Markets' })
    assert.equal(screen.queryByRole('link', { name: 'Admin' }), null)
  })

  it('never shows the Admin link with no wallet connected', async () => {
    renderWith(adminHarness(PROPOSE_AT, { connected: false }), <SiteNav />)
    await screen.findByRole('link', { name: 'Markets' })
    assert.equal(screen.queryByRole('link', { name: 'Admin' }), null)
  })

  it('shows the link once the admin connects and hides it on disconnect', async () => {
    const harness = adminHarness(PROPOSE_AT, { connected: false })
    renderWith(harness, <SiteNav />)
    await screen.findByRole('link', { name: 'Markets' })
    assert.equal(screen.queryByRole('link', { name: 'Admin' }), null)

    await harness.wallet.connect('Phantom')
    assert.ok(await screen.findByRole('link', { name: 'Admin' }))
    await harness.wallet.disconnect()
    await screen.findByRole('link', { name: 'Markets' })
    assert.equal(screen.queryByRole('link', { name: 'Admin' }), null)
  })
})

describe('R70 Admin page access', () => {
  it('a regular wallet visiting the page directly sees "Admin only" and no controls', async () => {
    const harness = adminHarness(FINALIZE_AT, {
      admin: OTHER_WALLET,
      days: [tickerDay({ pendingAdminPrice: 231.07 })],
    })
    renderWith(harness, <AdminPage />)
    assert.ok(await screen.findByText('Admin only'))
    assertNoAdminControls()
    assert.equal(screen.queryByText(/AAPL/), null, 'no ticker-day details either')
  })

  it('with no wallet connected the page shows "Admin only" and no controls', async () => {
    renderWith(adminHarness(FINALIZE_AT, { connected: false }), <AdminPage />)
    assert.ok(await screen.findByText('Admin only'))
    assertNoAdminControls()
  })

  it('the admin sees each open ticker-day with its pending price', async () => {
    const harness = adminHarness(PROPOSE_AT, {
      days: [
        tickerDay({ pendingAdminPrice: 231.07 }),
        tickerDay({ ticker: 'MSFT', pendingAdminPrice: null }),
      ],
    })
    renderWith(harness, <AdminPage />)
    const aapl = await daySection('AAPL')
    assert.ok(within(aapl).getByText(/\$231\.07/))
    const msft = await daySection('MSFT')
    assert.ok(within(msft).getByText(/no (price|admin price) (is )?pending|none pending/i))
    assert.equal(screen.queryByText('Admin only'), null)
  })
})

describe('R70 button timing per close_ts', () => {
  it('propose is disabled at close_ts + 899 and shows 4:15 PM ET', async () => {
    renderWith(adminHarness(REGULAR_CLOSE + 899), <AdminPage />)
    const day = await daySection()
    const propose = within(day).getByRole('button', { name: /propose/i })
    assert.equal((propose as HTMLButtonElement).disabled, true)
    assert.ok(within(day).getByText(/4:15 PM ET/))
  })

  it('propose is enabled at close_ts + 900', async () => {
    renderWith(adminHarness(PROPOSE_AT), <AdminPage />)
    const day = await daySection()
    const propose = within(day).getByRole('button', { name: /propose/i })
    assert.equal((propose as HTMLButtonElement).disabled, false)
  })

  it('finalize is disabled at close_ts + 3599 with a pending price and shows 5:00 PM ET', async () => {
    renderWith(
      adminHarness(REGULAR_CLOSE + 3599, { days: [tickerDay({ pendingAdminPrice: 231.07 })] }),
      <AdminPage />,
    )
    const day = await daySection()
    const finalize = within(day).getByRole('button', { name: /finalize/i })
    assert.equal((finalize as HTMLButtonElement).disabled, true)
    assert.ok(within(day).getByText(/5:00 PM ET/))
  })

  it('finalize is enabled at close_ts + 3600 with a pending price', async () => {
    renderWith(
      adminHarness(FINALIZE_AT, { days: [tickerDay({ pendingAdminPrice: 231.07 })] }),
      <AdminPage />,
    )
    const day = await daySection()
    const finalize = within(day).getByRole('button', { name: /finalize/i })
    assert.equal((finalize as HTMLButtonElement).disabled, false)
  })

  it('finalize stays disabled at close_ts + 3600 without a pending price', async () => {
    renderWith(adminHarness(FINALIZE_AT), <AdminPage />)
    const day = await daySection()
    const finalize = within(day).getByRole('button', { name: /finalize/i })
    assert.equal((finalize as HTMLButtonElement).disabled, true)
  })

  it('on an early-close day the times follow close_ts: 1:15 PM ET and 2:00 PM ET', async () => {
    const harness = adminHarness(EARLY_CLOSE + 899, {
      days: [
        tickerDay({ tradingDay: '2026-11-27', closeTs: EARLY_CLOSE, pendingAdminPrice: 231.07 }),
      ],
    })
    renderWith(harness, <AdminPage />)
    const day = await daySection()
    assert.ok(within(day).getByText(/1:15 PM ET/))
    assert.ok(within(day).getByText(/2:00 PM ET/))
    const propose = within(day).getByRole('button', { name: /propose/i })
    const finalize = within(day).getByRole('button', { name: /finalize/i })
    assert.equal((propose as HTMLButtonElement).disabled, true)
    assert.equal((finalize as HTMLButtonElement).disabled, true)
    cleanup()

    harness.clock.now = EARLY_CLOSE + 900
    renderWith(harness, <AdminPage />)
    const later = await daySection()
    assert.equal(
      (within(later).getByRole('button', { name: /propose/i }) as HTMLButtonElement).disabled,
      false,
    )
    assert.equal(
      (within(later).getByRole('button', { name: /finalize/i }) as HTMLButtonElement).disabled,
      true,
    )
    cleanup()

    harness.clock.now = EARLY_CLOSE + 3600
    renderWith(harness, <AdminPage />)
    const final = await daySection()
    assert.equal(
      (within(final).getByRole('button', { name: /finalize/i }) as HTMLButtonElement).disabled,
      false,
    )
  })

  it('the buttons enable on their own when the time comes', async () => {
    const harness = adminHarness(REGULAR_CLOSE + 899)
    renderWith(harness, <AdminPage />)
    const day = await daySection()
    const propose = within(day).getByRole('button', { name: /propose/i }) as HTMLButtonElement
    assert.equal(propose.disabled, true)
    harness.clock.now = PROPOSE_AT
    await waitFor(() => !propose.disabled, 'propose enables at close_ts + 900 without a reload')
  })
})

/** Polls `check` for up to 3 s, for state that follows a timer such as `useNow`. */
async function waitFor(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(message)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('R70 admin actions, one signature each', () => {
  it('proposes a price for the ticker and day with one signature at confirmed', async () => {
    const harness = adminHarness(PROPOSE_AT)
    const user = userEvent.setup()
    renderWith(harness, <AdminPage />)
    const day = await daySection()

    await user.type(within(day).getByLabelText(/price/i), '231.07')
    await user.click(within(day).getByRole('button', { name: /propose/i }))

    assert.ok(await within(day).findByText(/\$231\.07/), 'the new pending price shows')
    assert.deepEqual(harness.chain.calls.buildProposeAdminPrice, [
      { admin: WALLET, ticker: 'AAPL', tradingDay: '2026-10-12', priceCents: 23_107 },
    ])
    assert.equal(harness.wallet.signPrompts, 1)
    assert.equal(harness.chain.calls.sendAndConfirm.length, 1)
    assert.equal(harness.chain.calls.sendAndConfirm[0]?.commitment, 'confirmed')
  })

  it('finalizes the pending price with one signature at confirmed', async () => {
    const harness = adminHarness(FINALIZE_AT, {
      days: [tickerDay({ pendingAdminPrice: 231.07 })],
    })
    const user = userEvent.setup()
    renderWith(harness, <AdminPage />)
    const day = await daySection()

    await user.click(within(day).getByRole('button', { name: /finalize/i }))

    assert.ok(await screen.findByText(/finalized|final price/i))
    assert.deepEqual(harness.chain.calls.buildFinalizeAdminSettle, [
      { admin: WALLET, ticker: 'AAPL', tradingDay: '2026-10-12' },
    ])
    assert.equal(harness.wallet.signPrompts, 1)
    assert.equal(harness.chain.calls.sendAndConfirm.length, 1)
    assert.equal(harness.chain.calls.sendAndConfirm[0]?.commitment, 'confirmed')
  })

  it('pauses, then unpauses, one signature each', async () => {
    const harness = adminHarness(PROPOSE_AT)
    const user = userEvent.setup()
    renderWith(harness, <AdminPage />)

    assert.ok(await screen.findByText(/trading is active/i))
    await user.click(screen.getByRole('button', { name: /^pause/i }))
    assert.ok(await screen.findByText(/trading is paused/i))
    assert.deepEqual(harness.chain.calls.buildSetPaused, [{ admin: WALLET, paused: true }])
    assert.equal(harness.wallet.signPrompts, 1)
    assert.equal(harness.chain.calls.sendAndConfirm.length, 1)

    await user.click(await screen.findByRole('button', { name: /^unpause/i }))
    assert.ok(await screen.findByText(/trading is active/i))
    assert.deepEqual(harness.chain.calls.buildSetPaused, [
      { admin: WALLET, paused: true },
      { admin: WALLET, paused: false },
    ])
    assert.equal(harness.wallet.signPrompts, 2)
    assert.equal(harness.chain.calls.sendAndConfirm.length, 2)
    assert.ok(harness.chain.calls.sendAndConfirm.every((c) => c.commitment === 'confirmed'))
  })

  it('a paused program offers only Unpause', async () => {
    const harness = adminHarness(PROPOSE_AT)
    harness.chain.adminConfig.paused = true
    renderWith(harness, <AdminPage />)
    assert.ok(await screen.findByRole('button', { name: /^unpause/i }))
    assert.equal(screen.queryByRole('button', { name: /^pause/i }), null)
  })
})

describe('R70 admin error messages', () => {
  it('a rejected signature says nothing was sent', async () => {
    const harness = adminHarness(FINALIZE_AT, {
      days: [tickerDay({ pendingAdminPrice: 231.07 })],
    })
    harness.wallet.rejectNextSign = true
    const user = userEvent.setup()
    renderWith(harness, <AdminPage />)
    const day = await daySection()

    await user.click(within(day).getByRole('button', { name: /finalize/i }))

    const alert = await screen.findByRole('alert')
    assert.match(alert.textContent ?? '', /rejected the signature/i)
    assert.equal(harness.chain.calls.sendAndConfirm.length, 0)
  })

  it('an Unauthorized program error says only the admin wallet can do this', async () => {
    const harness = adminHarness(FINALIZE_AT, {
      days: [tickerDay({ pendingAdminPrice: 231.07 })],
    })
    harness.chain.sendError = programFailure('Unauthorized', 6001)
    const user = userEvent.setup()
    renderWith(harness, <AdminPage />)
    const day = await daySection()

    await user.click(within(day).getByRole('button', { name: /finalize/i }))

    const alert = await screen.findByRole('alert')
    assert.match(alert.textContent ?? '', /only the admin/i)
  })

  it('a too-early program error says when the action opens', async () => {
    const harness = adminHarness(FINALIZE_AT, {
      days: [tickerDay({ pendingAdminPrice: 231.07 })],
    })
    harness.chain.sendError = programFailure('AdminFinalizeTooEarly', 6030)
    const user = userEvent.setup()
    renderWith(harness, <AdminPage />)
    const day = await daySection()

    await user.click(within(day).getByRole('button', { name: /finalize/i }))

    const alert = await screen.findByRole('alert')
    assert.match(alert.textContent ?? '', /too early/i)
    assert.match(alert.textContent ?? '', /5:00 PM ET/)
  })

  it('a ticker-day that is already final says so', async () => {
    const harness = adminHarness(FINALIZE_AT, {
      days: [tickerDay({ pendingAdminPrice: 231.07 })],
    })
    harness.chain.sendError = programFailure('TickerDayFinal', 6028)
    const user = userEvent.setup()
    renderWith(harness, <AdminPage />)
    const day = await daySection()

    await user.click(within(day).getByRole('button', { name: /finalize/i }))

    const alert = await screen.findByRole('alert')
    assert.match(alert.textContent ?? '', /already (has its )?final/i)
  })

  it('a price that is not a positive dollar amount is refused before any signature', async () => {
    const harness = adminHarness(PROPOSE_AT)
    const user = userEvent.setup()
    renderWith(harness, <AdminPage />)
    const day = await daySection()

    for (const input of ['0', '-5', 'abc', '231.075']) {
      const field = within(day).getByLabelText(/price/i)
      await user.clear(field)
      await user.type(field, input)
      await user.click(within(day).getByRole('button', { name: /propose/i }))
      const alert = await screen.findByRole('alert')
      assert.match(alert.textContent ?? '', /price/i, `input ${input}`)
    }
    assert.equal(harness.wallet.signPrompts, 0)
    assert.deepEqual(harness.chain.calls.buildProposeAdminPrice, [])
  })
})

describe('R56 Admin page accessibility', () => {
  it('the admin page with its forms has no axe violations', async () => {
    const harness = adminHarness(FINALIZE_AT, {
      days: [
        tickerDay({ pendingAdminPrice: 231.07 }),
        tickerDay({ ticker: 'MSFT', pendingAdminPrice: null }),
      ],
    })
    const { container } = renderWith(harness, <AdminPage />)
    await daySection('MSFT')
    await assertNoAxeViolations(container)
  })

  it('the "Admin only" page has no axe violations', async () => {
    const { container } = renderWith(
      adminHarness(FINALIZE_AT, { admin: OTHER_WALLET }),
      <AdminPage />,
    )
    await screen.findByText('Admin only')
    await assertNoAxeViolations(container)
  })
})

describe('R70 Admin route wiring', () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('the site header renders SiteNav, which holds the Admin link', () => {
    assert.match(source('../app/layout.tsx'), /<SiteNav\s*\/>/)
  })

  it('/admin renders the Admin page', () => {
    const page = new URL('../app/admin/page.tsx', import.meta.url)
    assert.ok(existsSync(page), 'app/admin/page.tsx exists')
    assert.match(readFileSync(page, 'utf8'), /<AdminPage\s*\/>/)
  })
})
