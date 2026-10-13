// R44, R63: the README says the demo replays the recorded AAPL close of 2026-10-12, and no doc calls
// anything recorded that isn't. The only recorded data are that close (transcribed from one live
// chart API response) and the HTTP 429 body; every other price fixture is hand-written.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readRepoFile, sections } from './repo.js'

const DOCS = ['README.md', 'packages/price-providers/fixtures/README.md']

/** What may truthfully be called recorded. */
const RECORDED_SUBJECTS = [/2026-10-12/, /\b429\b|rate-limited/i]
/** A sentence that says something is not recorded claims nothing. */
const NEGATION = /\bnot\b|n't\b|hand-written|by hand|rather than|instead of/i

function read(path: string) {
  const text = readRepoFile(path)
  assert.ok(text, `${path} is missing`)
  return text
}

/** Prose sentences, with fenced blocks and inline code spans (such as `recorded`) removed. */
function sentences(markdown: string) {
  return markdown
    .replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?:])\s+/)
}

describe('the recorded demo close in the docs (R44, R63)', () => {
  it('the lifecycle demo section says it replays the recorded AAPL close of 2026-10-12', () => {
    const demo = sections(read('README.md')).find((section) => /demo/i.test(section.heading))
    assert.ok(demo, 'README.md has no demo section')
    const prose = demo.body.replace(/\s+/g, ' ')
    assert.match(prose, /replays the recorded AAPL close of 2026-10-12\b/)
    assert.match(prose, /\$340\.97\b/)
  })

  DOCS.forEach((path) => {
    it(`${path} calls nothing recorded but the 2026-10-12 close and the 429 body`, () => {
      const overclaims = sentences(read(path)).filter(
        (sentence) =>
          /\brecorded\b|\breal close\b/i.test(sentence) &&
          !NEGATION.test(sentence) &&
          !RECORDED_SUBJECTS.some((subject) => subject.test(sentence)),
      )
      assert.deepEqual(overclaims, [], `${path} claims these are recorded`)
    })
  })
})
