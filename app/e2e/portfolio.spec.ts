import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { loadStack, traderSettledState } from './stack'
import type { E2eStack } from './stack'
import { connectTestWallet, installTestWallet } from './wallet'

// Runs against the live local stack `make e2e` starts (scripts/e2e.ts). Its settled market (see
// `E2eStack.settled`) holds the trader's winning No and a resting ask.
let stack: E2eStack

/** One dollar in USDC base units. */
const USDC = 1_000_000

/** The header's USDC balance for the connected wallet, in base units. */
async function headerUsdc(page: Page): Promise<number> {
  const balance = page.getByRole('banner').getByText(/^[\d,]+\.\d{2} USDC$/)
  const text = await balance.innerText()
  return Math.round(Number(text.replace(/[^\d.]/g, '')) * USDC)
}

/** The settled contract's row for `side` in the Positions table. */
function settledRow(page: Page, side: 'Yes' | 'No') {
  return page
    .getByRole('table', { name: 'Positions' })
    .getByRole('row')
    .filter({
      has: page.getByRole('rowheader', { name: new RegExp(`^${stack.settled.ticker} \\$`) }),
    })
    .filter({ has: page.getByRole('cell', { name: side, exact: true }) })
}

test.beforeAll(() => {
  stack = loadStack()
})

test('R56 the Portfolio page, with a wallet connected, has no axe violations', async ({ page }) => {
  await installTestWallet(page, stack.trader)
  await page.goto('/portfolio')
  await expect(page.getByRole('heading', { level: 1, name: 'Portfolio' })).toBeVisible()
  await connectTestWallet(page)
  await expect(page.getByRole('heading', { name: 'Positions' })).toBeVisible()

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} nodes`)).toEqual([])
})

test('R52 close out orders and redeem on a settled market takes one signature and pays the winning No', async ({
  page,
}) => {
  const before = await traderSettledState()
  expect(before, 'the stack left 7 No and the 3 Yes ask resting').toMatchObject({
    yes: 0,
    no: 7_000_000,
    restingOrders: 1,
  })
  const wallet = await installTestWallet(page, stack.trader)
  await page.goto('/portfolio')
  await connectTestWallet(page)
  const no = settledRow(page, 'No')
  await expect(no).toContainText(/Settled at \$521\.58/)
  await expect(page.getByRole('banner').getByText(/USDC$/)).toBeVisible()
  const headerBefore = await headerUsdc(page)
  expect(headerBefore).toBe(before.usdc)

  await no.getByRole('button', { name: 'Close out orders and redeem' }).click()
  await expect(page.getByRole('status')).toHaveText(/Close out and redeem confirmed/, {
    timeout: 30_000,
  })
  expect(wallet.signatures(), 'one resting order: one transaction').toBe(1)

  // The ask is cancelled and its 3 Yes redeemed for nothing; the 7 No pay $1.00 each.
  const after = await traderSettledState()
  expect(after).toEqual({ usdc: before.usdc + 7 * USDC, yes: 0, no: 0, restingOrders: 0 })

  // Redeemed: nothing left to redeem, and the No shows the realized $7.00 − $4.20 cost.
  for (const side of ['Yes', 'No'] as const) {
    const row = settledRow(page, side)
    await expect(row.getByRole('cell').nth(1)).toHaveText('0')
    await expect(row.getByRole('button')).toHaveCount(0)
  }
  await expect(no).toContainText('+$2.80')
  // The header balance follows the payout without a reload.
  await expect
    .poll(() => headerUsdc(page), { message: 'header USDC after redeem', timeout: 10_000 })
    .toBe(before.usdc + 7 * USDC)
})
