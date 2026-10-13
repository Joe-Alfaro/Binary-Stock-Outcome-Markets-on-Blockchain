import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'

// Stubs: the devnet/e2e package fills these in once a validator and a test wallet are wired up.

test.fixme('R56 the Portfolio page has no axe violations', async ({ page }) => {
  await page.goto('/portfolio')
  await expect(page.getByRole('heading', { name: /portfolio/i })).toBeVisible()
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()
  expect(results.violations).toEqual([])
})

test.fixme('R52 settle, then close out orders and redeem in one signature', async ({ page }) => {
  await page.goto('/portfolio')
})
