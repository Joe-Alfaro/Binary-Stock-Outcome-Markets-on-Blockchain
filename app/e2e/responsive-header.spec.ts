import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'
import { clipping } from './layout'

// R69: no page scrolls sideways on mobile widths, and the site header keeps its nav links and
// wallet button fully on screen. Runs against the stack `make e2e` starts; it reads no chain
// state, so it needs no stack file.

const WIDTHS = [320, 360, 390, 768]
const PAGES = ['/', '/markets', '/trade/AAPL', '/portfolio', '/history']

for (const width of WIDTHS) {
  test(`R69 no page scrolls sideways and the header fits at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 })
    const problems: string[] = []

    for (const path of PAGES) {
      await page.goto(path)
      const header = page.getByRole('banner')
      const nav = header.getByRole('navigation', { name: 'Main' })
      const wallet = header.getByRole('button', { name: 'Connect wallet' })
      await expect(nav).toBeVisible()
      await expect(wallet).toBeVisible()

      // Captured before the assertions, so the evidence exists when the layout fails.
      const name = `header-${width}${path === '/' ? '-home' : path.replace(/\//g, '-')}`
      const screenshot = testInfo.outputPath(`${name}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      await testInfo.attach(name, { path: screenshot, contentType: 'image/png' })

      const doc = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }))
      if (doc.scrollWidth > doc.clientWidth) {
        problems.push(
          `${path}: the page scrolls horizontally (scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth})`,
        )
      }

      const targets: [Locator, string][] = [
        [nav, 'nav'],
        ...(await nav.getByRole('link').all()).map((link, i): [Locator, string] => [
          link,
          `nav link ${i + 1}`,
        ]),
        [wallet, 'wallet button'],
      ]
      for (const [element, label] of targets) {
        const problem = await clipping(page, element, label)
        if (problem !== null) problems.push(`${path}: ${problem}`)
      }
    }

    expect(problems, `layout problems at ${width}px`).toEqual([])
  })
}
