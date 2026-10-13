import assert from 'node:assert/strict'
import axe from 'axe-core'

/**
 * WCAG 2.1 A/AA rules, the same set `@axe-core/playwright` runs. Color contrast needs layout, which
 * jsdom lacks, so the Playwright specs cover it.
 */
export async function assertNoAxeViolations(container: Element): Promise<void> {
  const results = await axe.run(container, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    rules: { 'color-contrast': { enabled: false } },
  })
  const summary = results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  )
  assert.deepEqual(summary, [], 'axe violations')
}
