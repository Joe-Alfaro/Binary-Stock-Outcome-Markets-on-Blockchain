import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import { expect, test } from '@playwright/test'
import { loadStack, makerAsksYes, makerBidsYes } from './stack'
import type { E2eStack } from './stack'
import { connectTestWallet, installTestWallet } from './wallet'

// Runs against the live local stack `make e2e` starts (scripts/e2e.ts): a private validator, the
// deployed programs, one demo market and the web app with the test wallet adapter. The config runs
// one worker, so these share the market in file order without stopping at the first failure.

let stack: E2eStack

test.beforeAll(() => {
  stack = loadStack()
})

function yesBook(page: Page) {
  return page.getByRole('table', { name: 'Yes order book' })
}

function bidRow(page: Page, priceCents: number, qty: number) {
  return yesBook(page).getByRole('row', { name: new RegExp(`^Bid\\s+${priceCents}¢\\s+${qty}$`) })
}

/** A bid price with nothing resting yet, so a new order there shows as its own row. */
async function emptyBidPrice(page: Page) {
  const rows = await yesBook(page).getByRole('row').allInnerTexts()
  const taken = rows.flatMap((text) => /^Bid\s+(\d+)¢/.exec(text)?.[1] ?? []).map(Number)
  const price = Array.from({ length: 39 }, (_, i) => i + 2).find((p) => !taken.includes(p))
  if (price === undefined) throw new Error('No empty bid level from 2¢ to 40¢')
  return price
}

/** Opens the demo market's Trade page and picks its one strike, so the book and form show. */
async function openStrike(page: Page) {
  await page.goto(`/trade/${stack.ticker}`)
  await expect(page.getByRole('heading', { level: 1, name: stack.ticker })).toBeVisible()
  await page
    .getByRole('button', { name: /^Trade\b/ })
    .first()
    .click()
  await expect(yesBook(page)).toBeVisible()
}

test('R56 the Trade page, with a strike open and a wallet connected, has no axe violations', async ({
  page,
}) => {
  await installTestWallet(page, stack.trader)
  await openStrike(page)
  await connectTestWallet(page)
  await expect(page.getByRole('form', { name: 'Place an order' })).toBeVisible()

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.length} nodes`)).toEqual([])
})

test('R22 a new order placed by another wallet shows in the book within 2 s on the local validator', async ({
  page,
}) => {
  await openStrike(page)
  await expect(yesBook(page).getByRole('row').nth(1)).toBeVisible()
  const price = await emptyBidPrice(page)
  const row = bidRow(page, price, 3)

  await makerBidsYes(price, 3)
  const confirmedAt = Date.now()
  await expect(row).toBeVisible({ timeout: 2_000 })
  expect(Date.now() - confirmedAt).toBeLessThanOrEqual(2_000)
})

test('R23 Buy Yes at market through the UI takes one signature and fills', async ({ page }) => {
  await makerAsksYes(60, 5)
  const wallet = await installTestWallet(page, stack.trader)
  await openStrike(page)
  await connectTestWallet(page)
  await expect(yesBook(page).getByRole('row', { name: /^Ask\s+60¢\s+\d+$/ })).toBeVisible()

  const form = page.getByRole('form', { name: 'Place an order' })
  const holding = form.getByText(/^You hold \d+ Yes and \d+ No for this strike\.$/)
  const heldYes = async () => Number(/You hold (\d+) Yes/.exec(await holding.innerText())?.[1])
  await expect(holding).toBeVisible()
  const before = await heldYes()
  await form.getByRole('radio', { name: 'Buy Yes' }).check()
  await form.getByRole('radio', { name: 'Market' }).check()
  await form.getByLabel('Quantity').fill('2')
  await form.getByRole('button', { name: 'Place order' }).click()

  await expect(form.getByRole('status')).toHaveText(/Order confirmed/, { timeout: 30_000 })
  expect(wallet.signatures()).toBe(1)
  await expect(form.getByText(new RegExp(`^You hold ${before + 2} Yes and`))).toBeVisible()
})
