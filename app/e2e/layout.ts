import type { Locator, Page } from '@playwright/test'

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const show = (b: Box) =>
  `x=${b.x.toFixed(1)} y=${b.y.toFixed(1)} w=${b.width.toFixed(1)} h=${b.height.toFixed(1)}`

/** Why `element` isn't fully visible inside the viewport and every clipping ancestor, if it isn't. */
export async function clipping(
  page: Page,
  element: Locator,
  label: string,
): Promise<string | null> {
  const found = await element.boundingBox()
  if (found === null) return `${label} is not laid out`
  const viewport = page.viewportSize() as { width: number; height: number }
  const slack = 0.5
  if (found.x < -slack || found.x + found.width > viewport.width + slack) {
    return `${label} ${show(found)} leaves the ${viewport.width}px viewport`
  }
  const clipper = await element.evaluate((el) => {
    const self = el.getBoundingClientRect()
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue
      const outer = node.getBoundingClientRect()
      if (
        self.left < outer.left - 0.5 ||
        self.right > outer.right + 0.5 ||
        self.top < outer.top - 0.5 ||
        self.bottom > outer.bottom + 0.5
      ) {
        return `${node.tagName.toLowerCase()}.${node.className}`
      }
    }
    return null
  })
  return clipper === null ? null : `${label} ${show(found)} is clipped by ${clipper}`
}
