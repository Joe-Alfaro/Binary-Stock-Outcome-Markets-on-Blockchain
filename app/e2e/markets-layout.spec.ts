import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'

// R69: the Markets cards' layout while the market is closed, at every width the grid uses. The
// header pill says only "Closed"; the reopen text is the status line below the chart, in place of
// "Waiting for the first price". Runs against the stack `make e2e` starts; it reads no chain
// state, so it needs no stack file.

/** Tue 2026-10-13 8:00 PM EDT: closed, reopening tomorrow 9:30 AM ET. */
const CLOSED_AT = new Date('2026-10-14T00:00:00Z')
const WIDTHS = [1280, 1024, 768, 390]
const TICKER_COUNT = 7

interface Box {
  x: number
  y: number
  width: number
  height: number
}

async function box(locator: Locator): Promise<Box> {
  const found = await locator.boundingBox()
  expect(found, 'the element is laid out').not.toBeNull()
  return found as Box
}

/** Whether `inner` lies within `outer`, allowing half a pixel for subpixel rounding. */
function contains(outer: Box, inner: Box): boolean {
  const slack = 0.5
  return (
    inner.x >= outer.x - slack &&
    inner.y >= outer.y - slack &&
    inner.x + inner.width <= outer.x + outer.width + slack &&
    inner.y + inner.height <= outer.y + outer.height + slack
  )
}

function intersects(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

const show = (b: Box) =>
  `x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} w=${b.width.toFixed(1)} h=${b.height.toFixed(1)}`

for (const width of WIDTHS) {
  test(`R69 closed Markets cards: a 'Closed' pill, the reopen line under the chart, nothing overflowing at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    // The injected clock: the browser's Date reads closed-market time; timers still run.
    await page.clock.setFixedTime(CLOSED_AT)
    await page.goto('/markets')
    await expect(page.getByRole('heading', { level: 1, name: 'Markets' })).toBeVisible()
    const cards = page.getByRole('article')
    await expect(cards).toHaveCount(TICKER_COUNT)
    await expect(cards.first().getByRole('status', { name: /^Closed\b/ })).toBeVisible()

    // Captured before the assertions, so the evidence exists when the layout fails.
    const screenshot = testInfo.outputPath(`markets-closed-${width}.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    await testInfo.attach(`markets-closed-${width}`, { path: screenshot, contentType: 'image/png' })

    const problems: string[] = []
    for (const card of await cards.all()) {
      const ticker = await card.getByRole('heading', { level: 2 }).innerText()
      const cardBox = await box(card)
      const tickerBox = await box(card.getByRole('heading', { level: 2 }))
      const tag = card.getByRole('status', { name: /^Closed\b/ })
      await expect(tag, `${ticker} shows the Closed tag`).toBeVisible()
      const tagBox = await box(tag)
      const pillText = (await tag.innerText()).replace(/\s+/g, ' ').trim()
      const reopen = card.getByText(/^Reopens .*9:30 AM ET$/)
      await expect(reopen, `${ticker} shows the reopen line`).toBeVisible()
      const reopenBox = await box(reopen)
      const reopenInPill = await tag.evaluate(
        (pill, line) => line !== null && pill.contains(line),
        await reopen.elementHandle(),
      )
      // The chart, or its empty state where the worker isn't reachable.
      const chart = card
        .getByRole('figure')
        .or(card.getByText(/^(Chart unavailable|Loading chart…)$/))
        .first()
      const chartBox = await box(chart)
      const waiting = await card.getByText('Waiting for the first price').count()
      const overflow = await card.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }))

      if (!contains(cardBox, tagBox)) {
        problems.push(`${ticker}: tag ${show(tagBox)} leaves card ${show(cardBox)}`)
      }
      if (intersects(tagBox, tickerBox)) {
        problems.push(`${ticker}: tag ${show(tagBox)} overlaps ticker ${show(tickerBox)}`)
      }
      if (overflow.scrollWidth > overflow.clientWidth) {
        problems.push(
          `${ticker}: card scrolls horizontally (scrollWidth ${overflow.scrollWidth} > clientWidth ${overflow.clientWidth})`,
        )
      }
      if (pillText !== 'Closed') {
        problems.push(`${ticker}: the pill reads "${pillText}", not just "Closed"`)
      }
      if (reopenInPill) {
        problems.push(`${ticker}: the reopen text is inside the Closed pill`)
      }
      if (reopenBox.y < chartBox.y + chartBox.height - 0.5) {
        problems.push(
          `${ticker}: reopen line ${show(reopenBox)} is not below the chart ${show(chartBox)}`,
        )
      }
      if (waiting > 0) {
        problems.push(`${ticker}: shows 'Waiting for the first price' while closed`)
      }
      if (!contains(cardBox, reopenBox)) {
        problems.push(`${ticker}: reopen line ${show(reopenBox)} leaves card ${show(cardBox)}`)
      }
    }
    expect(problems, `layout problems at ${width}px`).toEqual([])
  })
}
