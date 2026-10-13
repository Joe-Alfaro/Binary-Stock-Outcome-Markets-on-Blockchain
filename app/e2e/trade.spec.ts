import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Stubs: the devnet/e2e package fills these in once a validator and a test wallet are wired up.

test.fixme('R56 the Trade page has no axe violations', async ({ page }) => {
  await page.goto('/trade/AAPL')
  await expect(page.getByRole('heading', { name: /AAPL/ })).toBeVisible()
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])
})

test.fixme('R22 a new order from another wallet shows within 2 s', async ({ page }) => {
  await page.goto('/trade/AAPL')
})

test.fixme('R23-R26 each trade path prompts one signature and updates the portfolio', async ({
  page,
}) => {
  await page.goto('/trade/AAPL')
})
