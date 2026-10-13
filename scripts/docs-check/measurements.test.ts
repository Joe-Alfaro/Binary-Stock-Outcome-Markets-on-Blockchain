// R6, R13, R19: the README statements those requirements' done checks ask for. The rent figures
// themselves are compared with the validator's accounts by `tests/measurements.test.ts`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readRepoFile, sections } from './repo.js'

const readme = readRepoFile('README.md') ?? ''

/** README prose as sentences, with line breaks and list markers folded away. */
function sentences(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\n\s*[-*]\s+/g, '\n')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
}

function sentenceMatchingAll(patterns: RegExp[]) {
  return sentences(readme).find((s) => patterns.every((p) => p.test(s)))
}

/** The section (any heading level) that mentions the most of `patterns`, and what it misses. */
function closestSection(patterns: RegExp[]) {
  const scored = sections(readme).map((section) => ({
    heading: section.heading,
    missing: patterns.filter((p) => !p.test(section.body)).map(String),
  }))
  return scored.reduce((a, b) => (b.missing.length < a.missing.length ? b : a), {
    heading: '(none)',
    missing: patterns.map(String),
  })
}

describe('README: vault donations and direct burns (R6)', () => {
  it('documents that USDC sent straight to a vault is never paid out and bricks nothing', () => {
    const best = closestSection([
      /donat/i,
      /vault/i,
      /directly|straight/i,
      /internal|counter/i,
      /never paid out|isn't paid out|is not paid out|never pays? (it )?out/i,
    ])
    assert.deepEqual(best.missing, [], `closest section "${best.heading}"`)
  })

  it('documents that holders can burn Yes or No outside Meridian and the market keeps working', () => {
    const best = closestSection([
      /\bburn/i,
      /token program/i,
      /outside (Meridian|the program)/i,
      /(keeps?|still) (working|works|settles|redeems)|unaffected|isn't affected|is not affected/i,
    ])
    assert.deepEqual(best.missing, [], `closest section "${best.heading}"`)
  })
})

describe('README: strikes are adjusted only by adding new ones (R13)', () => {
  it('says the admin adjusts the ladder by adding strikes', () => {
    assert.ok(
      sentenceMatchingAll([/adjust/i, /strike/i, /\badd(s|ing)?\b/i]),
      'no sentence says strikes are adjusted by adding new ones',
    )
  })

  it("says no instruction changes an existing market's strike", () => {
    assert.ok(
      sentenceMatchingAll([
        /strike/i,
        /no instruction|nothing|never|can't|cannot|can not/i,
        /chang|edit|modif|mutat/i,
        /existing|live|open/i,
      ]),
      "no sentence says an existing market's strike can't be changed",
    )
  })
})

describe('README: measured rent per market and per day (R19)', () => {
  it('states the measured rent per market, about 0.035 SOL', () => {
    assert.ok(
      sentenceMatchingAll([/\b0\.035 SOL\b/, /per market|each market|a market/i]),
      'no sentence gives the measured 0.035 SOL per market',
    )
  })

  it('states the measured rent per trading day, about 1.74 SOL', () => {
    assert.ok(
      sentenceMatchingAll([
        /\b1\.74 SOL\b/,
        /per (trading )?day|a (trading )?day|each (trading )?day/i,
      ]),
      'no sentence gives the measured 1.74 SOL per day',
    )
  })

  it('gives no other rent figure (the old "about 2 SOL" estimate is gone)', () => {
    const stale = sentences(readme).filter((s) => {
      if (!/rent/i.test(s)) return false
      const figures = [...s.matchAll(/(\d+(?:\.\d+)?) SOL\b/g)].map((m) => m[1])
      return figures.some((f) => f !== '0.035' && f !== '1.74')
    })
    assert.deepEqual(stale, [], 'rent sentences with a figure other than the measured ones')
  })

  it('no longer lists the rent measurement as unfinished', () => {
    const status = sections(readme).find((s) => /^status$/i.test(s.heading))?.body ?? ''
    const unfinished = status.split(/not finished yet:?/i)[1] ?? ''
    assert.doesNotMatch(unfinished, /rent/i)
  })
})
