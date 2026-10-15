import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'
import { clipping } from './layout'
import { loadStack } from './stack'
import { connectTestWallet, installTestWallet } from './wallet'

// R69 with R70: with the admin's wallet connected, the header gains the Admin link and the
// connected wallet's address, balance and Disconnect button, and must still fit on mobile widths.
// Runs against the live local stack `make e2e` starts (scripts/e2e.ts).

const WIDTHS = [320, 360, 390]

for (const width of WIDTHS) {
  test(`R69 R70 the admin's header with the Admin link fits at ${width}px`, async ({ page }) => {
    await installTestWallet(page, loadStack().admin)
    await page.setViewportSize({ width, height: 800 })
    await page.goto('/markets')
    await connectTestWallet(page)

    const header = page.getByRole('banner')
    const nav = header.getByRole('navigation', { name: 'Main' })
    const admin = nav.getByRole('link', { name: 'Admin' })
    await expect(admin).toBeVisible()

    const doc = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }))
    const problems: string[] = []
    if (doc.scrollWidth > doc.clientWidth) {
      problems.push(
        `the page scrolls horizontally (scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth})`,
      )
    }
    const targets: [Locator, string][] = [
      [nav, 'nav'],
      ...(await nav.getByRole('link').all()).map((link, i): [Locator, string] => [
        link,
        `nav link ${i + 1}`,
      ]),
      [admin, 'Admin link'],
      [header.getByRole('button', { name: /disconnect/i }), 'Disconnect button'],
    ]
    for (const [element, label] of targets) {
      const problem = await clipping(page, element, label)
      if (problem !== null) problems.push(problem)
    }
    expect(problems, `layout problems at ${width}px`).toEqual([])
  })
}
