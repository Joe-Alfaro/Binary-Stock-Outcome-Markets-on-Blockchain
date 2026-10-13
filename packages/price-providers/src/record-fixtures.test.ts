import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import type { Manifest } from './record-fixtures.js'
import { recordFixtures, sha256 } from './record-fixtures.js'

const CHART = '/v8/finance/chart/AAPL?interval=1m&period1=1&period2=2'
const CHART_BODY = '{"chart":{"result":[{"meta":{"symbol":"AAPL"}}],"error":null}}'

function fixturesDir(manifest: Manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'record-fixtures-'))
  mkdirSync(join(dir, 'yahoo'))
  writeFileSync(join(dir, 'provenance.json'), JSON.stringify(manifest))
  for (const path of Object.keys(manifest)) writeFileSync(join(dir, path), 'hand-written')
  return pathToFileURL(`${dir}/`)
}

function handWritten(...paths: string[]): Manifest {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      {
        origin: 'hand-written',
        recordFrom: `https://query1.finance.yahoo.com${CHART}`,
        sha256: '',
      },
    ]),
  )
}

/** A clock that only moves when the recorder sleeps, plus a scripted fetch. */
function harness(responses: [number, string][]) {
  let clock = 1_791_600_000_000
  const calls: { url: string; at: number; userAgent: string }[] = []
  return {
    calls,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms
    },
    fetch: (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>
      calls.push({ url, at: clock, userAgent: headers['User-Agent'] ?? '' })
      const [status, body] = responses.shift() ?? [429, 'Too Many Requests']
      return new Response(body, { status })
    }) as typeof fetch,
    log: () => {},
  }
}

function readManifest(dir: URL) {
  return JSON.parse(readFileSync(new URL('provenance.json', dir), 'utf8')) as Manifest
}

describe('record-fixtures', () => {
  it('writes the body byte for byte and marks it recorded with its request, time and hash', async () => {
    const dir = fixturesDir(handWritten('yahoo/a.json'))
    const h = harness([[200, CHART_BODY]])
    const result = await recordFixtures({ fixturesDir: dir, ...h })

    assert.deepEqual(result.recorded, ['yahoo/a.json'])
    assert.equal(readFileSync(new URL('yahoo/a.json', dir), 'utf8'), CHART_BODY)
    assert.deepEqual(readManifest(dir)['yahoo/a.json'], {
      origin: 'recorded',
      url: `https://query1.finance.yahoo.com${CHART}`,
      capturedAt: new Date(h.now()).toISOString(),
      sha256: sha256(Buffer.from(CHART_BODY)),
    })
    assert.match(h.calls[0]?.userAgent ?? '', /Mozilla/)
  })

  it('falls back to query2 after a 429, at least 60 s later', async () => {
    const dir = fixturesDir(handWritten('yahoo/a.json'))
    const h = harness([
      [429, 'Too Many Requests'],
      [200, CHART_BODY],
    ])
    await recordFixtures({ fixturesDir: dir, ...h })

    assert.deepEqual(
      h.calls.map((c) => new URL(c.url).host),
      ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'],
    )
    assert.ok((h.calls[1]?.at ?? 0) - (h.calls[0]?.at ?? 0) >= 60_000)
    assert.equal(readManifest(dir)['yahoo/a.json']?.url, `https://query2.finance.yahoo.com${CHART}`)
  })

  it('stops the run when both hosts answer 429 and leaves the fixtures hand-written', async () => {
    const manifest = handWritten('yahoo/a.json', 'yahoo/b.json')
    const dir = fixturesDir(manifest)
    const h = harness([])
    const result = await recordFixtures({ fixturesDir: dir, ...h })

    assert.equal(result.requests, 2)
    assert.deepEqual(result.recorded, [])
    assert.deepEqual(
      result.skipped.map((s) => s.path),
      ['yahoo/a.json', 'yahoo/b.json'],
    )
    assert.deepEqual(readManifest(dir), manifest)
    assert.equal(readFileSync(new URL('yahoo/a.json', dir), 'utf8'), 'hand-written')
  })

  it('keeps a 404 chart error (the unknown-symbol fixture) and rejects a 200 without a result', async () => {
    const dir = fixturesDir(handWritten('yahoo/not-found.json', 'yahoo/empty.json'))
    const notFound = '{"chart":{"result":null,"error":{"code":"Not Found"}}}'
    const h = harness([
      [404, notFound],
      [200, '{"chart":{"result":[],"error":null}}'],
      [200, 'not json'],
    ])
    const result = await recordFixtures({ fixturesDir: dir, ...h })

    assert.deepEqual(result.recorded, ['yahoo/not-found.json'])
    assert.equal(readManifest(dir)['yahoo/empty.json']?.origin, 'hand-written')
  })

  it('never exceeds its request budget', async () => {
    const dir = fixturesDir(handWritten('yahoo/a.json', 'yahoo/b.json', 'yahoo/c.json'))
    const h = harness([
      [200, CHART_BODY],
      [500, 'oops'],
      [500, 'oops'],
    ])
    const result = await recordFixtures({ fixturesDir: dir, ...h, maxRequests: 3 })

    assert.equal(result.requests, 3)
    assert.deepEqual(result.recorded, ['yahoo/a.json'])
  })

  it('sends nothing on a dry run', async () => {
    const dir = fixturesDir(handWritten('yahoo/a.json'))
    const h = harness([])
    const result = await recordFixtures({ fixturesDir: dir, ...h, dryRun: true })

    assert.equal(result.requests, 0)
    assert.equal(h.calls.length, 0)
  })
})
