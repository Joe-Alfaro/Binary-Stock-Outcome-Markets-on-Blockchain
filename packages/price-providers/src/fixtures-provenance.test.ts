// R39: the relay source's timeout, 429 and malformed-response handling is "tested with recorded
// fixtures". `fixtures/provenance.json` records where each Yahoo fixture came from, and this test
// flags any that isn't marked as a capture of the live chart API, or that changed since capture.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const FIXTURES = new URL('../fixtures/', import.meta.url)
const MANIFEST = new URL('provenance.json', FIXTURES)

interface Provenance {
  /** `recorded`: the bytes the live endpoint returned (trimming whole bars is allowed). */
  origin: string
  /** The exact request that produced it. */
  url: string
  /** ISO 8601 time of the capture. */
  capturedAt: string
  /** SHA-256 of the committed file, so a later hand edit shows up. */
  sha256: string
}

const yahooFixtures = readdirSync(new URL('yahoo/', FIXTURES)).map((name) => `yahoo/${name}`)

function manifest(): Record<string, Provenance> {
  assert.ok(existsSync(MANIFEST), 'fixtures/provenance.json is missing')
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, Provenance>
}

/** The latest Unix time in a chart response; a capture can't predate its own data. */
function latestDataTime(body: string) {
  try {
    const result = (
      JSON.parse(body) as {
        chart?: { result?: { meta?: { regularMarketTime?: number }; timestamp?: number[] }[] }
      }
    ).chart?.result?.[0]
    return Math.max(0, result?.meta?.regularMarketTime ?? 0, ...(result?.timestamp ?? []))
  } catch {
    return 0
  }
}

describe('Yahoo fixture provenance (R39)', () => {
  it('has Yahoo fixtures to check', () => {
    assert.ok(yahooFixtures.length > 0)
  })

  yahooFixtures.forEach((path) => {
    it(`${path} is marked as recorded from the live chart API`, () => {
      const entry = manifest()[path]
      assert.ok(entry, `${path} has no provenance entry`)
      assert.equal(entry.origin, 'recorded', `${path} is not marked as recorded`)
      assert.match(
        entry.url,
        /^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\//,
        `${path} needs the chart API request it was captured from`,
      )
      const captured = Date.parse(entry.capturedAt)
      assert.ok(Number.isFinite(captured), `${path} capturedAt is not a timestamp`)
      const body = readFileSync(new URL(path, FIXTURES), 'utf8')
      assert.ok(
        captured / 1000 >= latestDataTime(body),
        `${path} claims a capture before the data it contains`,
      )
      assert.equal(
        createHash('sha256').update(body).digest('hex'),
        entry.sha256,
        `${path} changed since it was captured`,
      )
    })
  })

  it('the fixtures README no longer says the Yahoo files were written by hand', () => {
    const readme = readFileSync(new URL('README.md', FIXTURES), 'utf8')
    const yahooNotes = readme
      .split(/\n(?=- )/)
      .filter((note) => /yahoo\//.test(note))
      .join('\n')
    assert.doesNotMatch(yahooNotes, /by hand|hand-written|handwritten|constructed/i)
  })
})
