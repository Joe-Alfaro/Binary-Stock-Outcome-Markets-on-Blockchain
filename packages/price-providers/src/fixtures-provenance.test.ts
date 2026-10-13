// R39: the relay source's timeout, 429 and malformed-response handling is tested with fixtures.
// `fixtures/provenance.json` records where each Yahoo fixture came from. A fixture is either a
// capture of the live chart API, values transcribed from one live response whose bytes weren't
// kept (R44's recorded demo close), or (decision D67, when the API refuses) hand-written in its
// schema with a one-command re-record script and a README note. Anything else, or a file that
// changed since its entry was written, fails.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const FIXTURES = new URL('../fixtures/', import.meta.url)
const MANIFEST = new URL('provenance.json', FIXTURES)

interface Provenance {
  /**
   * `recorded`: the bytes the live endpoint returned (trimming whole bars is allowed).
   * `recorded-transcribed`: values copied from one live response whose bytes weren't saved.
   * `hand-written`: written in the chart API schema because the endpoint refused.
   */
  origin: string
  /** `recorded` and `recorded-transcribed`: the exact request that produced it. */
  url?: string
  /** `recorded` and `recorded-transcribed`: ISO 8601 time of the capture. */
  capturedAt?: string
  /** `hand-written`: the request `npm run record-fixtures` replaces it with. */
  recordFrom?: string
  /** `recorded-transcribed`: says the values were transcribed and no byte checksum exists. */
  note?: string
  /** SHA-256 of the committed file, so a later hand edit shows up. */
  sha256: string
}

const CHART_API = /^https:\/\/query[12]\.finance\.yahoo\.com\/v8\/finance\/chart\//
const PACKAGE_JSON = new URL('../package.json', import.meta.url)

const yahooFixtures = readdirSync(new URL('yahoo/', FIXTURES)).map((name) => `yahoo/${name}`)

function manifest(): Record<string, Provenance> {
  assert.ok(existsSync(MANIFEST), 'fixtures/provenance.json is missing')
  return JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, Provenance>
}

/** The `record-fixtures` npm script, if the package defines one. */
function recordScript() {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { scripts?: Record<string, string> }
  return pkg.scripts?.['record-fixtures']
}

/** The fixtures README's notes that mention `yahoo/` files. */
function yahooReadmeNotes() {
  return readFileSync(new URL('README.md', FIXTURES), 'utf8')
    .split(/\n(?=- )/)
    .filter((note) => /yahoo\//.test(note))
    .join('\n')
}

const HAND_WRITTEN_NOTE = /by hand|hand-written|handwritten|constructed/i

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

const TRANSCRIBED_NOTE = /transcribed/i
const NO_CHECKSUM_NOTE = /\bno\b[^.]*\bchecksum\b/i

/** A capture's request and time, which can't predate the data it holds. */
function checkCapture(path: string, entry: Provenance, body: string) {
  assert.match(
    entry.url ?? '',
    CHART_API,
    `${path} needs the chart API request it was captured from`,
  )
  const captured = Date.parse(entry.capturedAt ?? '')
  assert.ok(Number.isFinite(captured), `${path} capturedAt is not a timestamp`)
  assert.ok(
    captured / 1000 >= latestDataTime(body),
    `${path} claims a capture before the data it contains`,
  )
}

/** Fails unless `entry` is one of the three accepted provenance shapes and matches `body`. */
function checkProvenance(path: string, entry: Provenance, body: string) {
  if (entry.origin === 'recorded') {
    checkCapture(path, entry, body)
  } else if (entry.origin === 'recorded-transcribed') {
    checkCapture(path, entry, body)
    assert.equal(entry.recordFrom, undefined, `${path} is recorded, so it has no recordFrom`)
    assert.match(entry.note ?? '', TRANSCRIBED_NOTE, `${path} note must say it was transcribed`)
    assert.match(
      entry.note ?? '',
      NO_CHECKSUM_NOTE,
      `${path} note must say no byte checksum of the response exists`,
    )
  } else if (entry.origin === 'hand-written') {
    assert.match(
      entry.recordFrom ?? '',
      CHART_API,
      `${path} needs the chart API request to re-record it from`,
    )
    assert.ok(
      recordScript()?.trim(),
      `${path} is hand-written but package.json has no record-fixtures script`,
    )
    assert.match(
      yahooReadmeNotes(),
      HAND_WRITTEN_NOTE,
      `${path} is hand-written but the fixtures README doesn't say so`,
    )
    assert.match(
      yahooReadmeNotes(),
      /npm run record-fixtures/,
      `${path} is hand-written but the fixtures README doesn't name npm run record-fixtures`,
    )
  } else {
    assert.fail(
      `${path} origin must be "recorded", "recorded-transcribed" or "hand-written", got ${String(entry.origin)}`,
    )
  }
  assert.equal(
    createHash('sha256').update(body).digest('hex'),
    entry.sha256,
    `${path} changed since its provenance entry was written`,
  )
}

describe('Yahoo fixture provenance (R39)', () => {
  it('has Yahoo fixtures to check', () => {
    assert.ok(yahooFixtures.length > 0)
  })

  yahooFixtures.forEach((path) => {
    it(`${path} is recorded from the live chart API, or hand-written with a re-record path`, () => {
      const entry = manifest()[path]
      assert.ok(entry, `${path} has no provenance entry`)
      checkProvenance(path, entry, readFileSync(new URL(path, FIXTURES), 'utf8'))
    })
  })

  it('the fixtures README says the Yahoo files were written by hand only while some are', () => {
    const entries = manifest()
    const anyHandWritten = yahooFixtures.some((path) => entries[path]?.origin === 'hand-written')
    if (anyHandWritten) {
      assert.match(yahooReadmeNotes(), HAND_WRITTEN_NOTE)
      assert.match(yahooReadmeNotes(), /npm run record-fixtures/)
    } else {
      assert.doesNotMatch(yahooReadmeNotes(), HAND_WRITTEN_NOTE)
    }
  })
})

describe('provenance shapes (R39, R44)', () => {
  const body = JSON.stringify({
    chart: { result: [{ meta: { regularMarketTime: 1_791_835_201 } }] },
  })
  const sha256 = createHash('sha256').update(body).digest('hex')
  const transcribed: Provenance = {
    origin: 'recorded-transcribed',
    url: 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1m&range=1d',
    capturedAt: '2026-10-13T00:20:00Z',
    note: 'Values transcribed from one live response; its bytes were not saved, so no byte checksum exists.',
    sha256,
  }

  it('accepts values transcribed from a live response with capture time, request and note', () => {
    assert.doesNotThrow(() => checkProvenance('t.json', transcribed, body))
  })

  const broken: [string, Partial<Provenance>][] = [
    ['without a request URL', { url: undefined }],
    ['with a request that is not the chart API', { url: 'https://example.com/chart/AAPL' }],
    ['without a capture time', { capturedAt: undefined }],
    ['with a capture time before its data', { capturedAt: '2026-10-12T19:00:00Z' }],
    ['without a note', { note: undefined }],
    ['with a note that does not say it was transcribed', { note: 'No byte checksum exists.' }],
    ['with a note that does not mention the missing checksum', { note: 'Transcribed by hand.' }],
    ['with a hand-written re-record request', { recordFrom: transcribed.url }],
    ['whose file changed since the entry', { sha256: '0'.repeat(64) }],
  ]
  broken.forEach(([label, change]) => {
    it(`rejects a transcribed entry ${label}`, () => {
      assert.throws(() => checkProvenance('t.json', { ...transcribed, ...change }, body))
    })
  })

  it('rejects any other origin', () => {
    ;['transcribed', 'recorded-by-hand', 'mock', ''].forEach((origin) =>
      assert.throws(() => checkProvenance('t.json', { ...transcribed, origin }, body), /origin/),
    )
  })
})
