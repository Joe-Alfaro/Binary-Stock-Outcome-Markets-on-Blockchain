// D5: AI_USAGE.md has an entry per merged feature, each with a date, what was built and how AI
// was used.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { git, readRepoFile, sections } from './repo.js'

// This package's own entry, which its implementation worker adds before merging.
const ownBranch = 'feat/docs'

function entries(log: string) {
  return sections(log).filter((s) => s.level === 2)
}

// Source branches of merge commits reachable from HEAD. CI clones with depth 1, so this list
// can be empty there; the full history is checked locally.
function mergedBranches() {
  const shallow = git(['rev-parse', '--is-shallow-repository']).trim() === 'true'
  if (shallow) return undefined
  return git(['log', '--merges', '--format=%s', 'HEAD'])
    .split('\n')
    .map((subject) => /^Merge branch '([^']+)' into 'main'/.exec(subject)?.[1])
    .filter((branch): branch is string => Boolean(branch))
}

describe('AI usage log (D5)', () => {
  const log = readRepoFile('AI_USAGE.md')

  it('exists with at least one entry', () => {
    assert.ok(log, 'AI_USAGE.md is missing from the repo root')
    assert.ok(entries(log).length > 0, 'AI_USAGE.md has no "## " entries')
  })

  it('gives every entry a date, what was built, the tool and how AI was used', () => {
    assert.ok(log, 'AI_USAGE.md is missing from the repo root')
    const incomplete = entries(log)
      .filter(
        (e) =>
          !/^\d{4}-\d{2}-\d{2}\b.*[A-Za-z]{3}/.test(e.heading) ||
          !/\*\*Tool:\*\*\s*\S/.test(e.body) ||
          !/\*\*What the AI did:\*\*\s*\S/.test(e.body),
      )
      .map((e) => e.heading)
    assert.deepEqual(
      incomplete,
      [],
      'each "## YYYY-MM-DD — <what was built>" entry needs Tool and What the AI did',
    )
  })

  it('has an entry for every merged feature branch', (t) => {
    assert.ok(log, 'AI_USAGE.md is missing from the repo root')
    const branches = mergedBranches()
    if (!branches) {
      t.skip('shallow clone: merge history is not available')
      return
    }
    const headings = entries(log).map((e) => e.heading)
    const missing = branches.filter((b) => !headings.some((h) => h.includes(b)))
    assert.deepEqual(missing, [], 'add an entry whose heading names each merged branch')
  })

  it(`has an entry for this package (${ownBranch})`, () => {
    assert.ok(log, 'AI_USAGE.md is missing from the repo root')
    assert.ok(
      entries(log).some((e) => e.heading.includes(ownBranch)),
      `add an AI_USAGE.md entry whose heading names ${ownBranch}`,
    )
  })
})
