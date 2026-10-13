// R63 [G]: the docs make no regulatory or compliance claims.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readRepoFile, trackedFiles } from './repo.js'

// Words and phrases that claim a regulatory or legal status.
const claimPatterns = [
  /\bcompliant\b/i,
  /\bcomplies with\b/i,
  /\bcompliance with\b/i,
  /\bin compliance\b/i,
  /\bregulated\b/i,
  /\bregulatory approval\b/i,
  /\blicensed\b/i,
  /\bapproved by\b/i,
  /\bauthori[sz]ed by\b/i,
  /\bregistered with\b/i,
  /\b(?:sec|cftc|finra)[- ]registered\b/i,
  /\blegal(?:ly)?\b/i,
  /\blawful\b/i,
]

// Neutral statements that would otherwise match. Matching text is removed before scanning.
// Add an entry here only for a negation or a statement that claims nothing about the product.
const allowlist = [
  /\bthis is not financial advice\b/i,
  /\bthis is not legal advice\b/i,
  /\bnot regulated\b/i,
  /\bnot licensed\b/i,
  /\bnot approved by any regulator\b/i,
  /\bmakes? no regulatory or compliance claims\b/i,
  /\bneeds a licensed (?:data )?source\b/i,
]

function findClaims(text: string) {
  const neutral = allowlist.reduce((t, pattern) => t.replace(new RegExp(pattern, 'gi'), ' '), text)
  return neutral
    .split('\n')
    .flatMap((line, index) =>
      claimPatterns
        .filter((pattern) => pattern.test(line))
        .map((pattern) => `line ${index + 1}: ${pattern} in "${line.trim()}"`),
    )
}

describe('no regulatory or compliance claims (R63)', () => {
  it('flags claim phrases and ignores allowlisted negations', () => {
    assert.equal(findClaims('The exchange is fully compliant and regulated.').length, 2)
    assert.equal(findClaims('Trading is legal in every state.').length, 1)
    assert.deepEqual(findClaims('This is not financial advice. This is not legal advice.'), [])
    assert.deepEqual(findClaims('A registered relay signer publishes prices.'), [])
  })

  it('finds no claims in any tracked markdown file', () => {
    const docs = trackedFiles().filter((f) => f.toLowerCase().endsWith('.md'))
    assert.ok(docs.includes('README.md'), 'README.md is missing from the repo root')
    const claims = docs.flatMap((path) =>
      findClaims(readRepoFile(path) ?? '').map((claim) => `${path} ${claim}`),
    )
    assert.deepEqual(claims, [])
  })
})
