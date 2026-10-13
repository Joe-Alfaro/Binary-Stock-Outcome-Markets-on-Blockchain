import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { loadStack } from './stack'
import type { E2eStack } from './stack'
import { connectTestWallet, installTestWallet } from './wallet'

// Runs against the live local stack `make e2e` starts (scripts/e2e.ts).
let stack: E2eStack

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

test.fixme('R52 settle, then close out orders and redeem in one signature', async ({ page }) => {
  await page.goto('/portfolio')
})
