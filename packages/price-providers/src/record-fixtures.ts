/**
 * `npm run record-fixtures`: replaces the hand-written Yahoo fixtures with real captures of the
 * request each one's provenance entry names (`recordFrom`), and marks them `recorded`.
 *
 * Polite by design, because the chart API rate-limits hard: at most `maxRequests` requests per
 * run, at least 60 s apart, a browser User-Agent, query1 first and query2 as the fallback, and the
 * run stops at the first fixture both hosts refuse. Bodies are written byte for byte, so the
 * committed SHA-256 is the SHA-256 of what the endpoint returned.
 *
 *   npm run record-fixtures                          # every hand-written fixture
 *   npm run record-fixtures -- yahoo/AAPL-2026-10-09-1m.json
 *   npm run record-fixtures -- --dry-run             # print the plan, send nothing
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface ProvenanceEntry {
  origin: 'recorded' | 'hand-written'
  url?: string
  capturedAt?: string
  recordFrom?: string
  sha256: string
  note?: string
}

export type Manifest = Record<string, ProvenanceEntry>

export interface RecordOptions {
  fixturesDir: URL
  /** Fixture paths (`yahoo/<file>`) to record; defaults to every hand-written one. */
  only?: string[]
  maxRequests?: number
  minGapMs?: number
  dryRun?: boolean
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  /** Milliseconds since the epoch. */
  now?: () => number
  log?: (line: string) => void
}

export interface RecordResult {
  recorded: string[]
  /** Fixtures not recorded, with the reason. */
  skipped: { path: string; reason: string }[]
  requests: number
}

const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'] as const
const CHART_API = /^https:\/\/query[12]\.finance\.yahoo\.com(\/v8\/finance\/chart\/.+)$/

// Same headers as the live source: the chart API answers 429 without a browser User-Agent.
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/141.0.0.0 Safari/537.36',
  Accept: 'application/json',
}

const DEFAULT_MAX_REQUESTS = 6
const DEFAULT_MIN_GAP_MS = 60_000
const TIMEOUT_MS = 15_000

export function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A chart body worth keeping: a result (200), or a chart error such as an unknown symbol (404). */
function isChartBody(status: number, bytes: Uint8Array) {
  if (status !== 200 && status !== 404) return false
  try {
    const chart = (JSON.parse(Buffer.from(bytes).toString('utf8')) as { chart?: unknown }).chart
    if (typeof chart !== 'object' || chart === null) return false
    const { result, error } = chart as { result?: unknown; error?: unknown }
    return status === 200 ? Array.isArray(result) && result.length > 0 : Boolean(error)
  } catch {
    return false
  }
}

export async function recordFixtures(options: RecordOptions): Promise<RecordResult> {
  const fetchFn = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)))
  const now = options.now ?? Date.now
  const log = options.log ?? console.log
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS
  const minGapMs = options.minGapMs ?? DEFAULT_MIN_GAP_MS
  const manifestUrl = new URL('provenance.json', options.fixturesDir)
  const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8')) as Manifest

  const targets = options.only ?? Object.keys(manifest).filter((p) => !!manifest[p]?.recordFrom)
  const result: RecordResult = { recorded: [], skipped: [], requests: 0 }
  let lastRequestAt: number | undefined
  let refused = false

  async function request(url: string) {
    if (lastRequestAt !== undefined) {
      const wait = lastRequestAt + minGapMs - now()
      if (wait > 0) await sleep(wait)
    }
    lastRequestAt = now()
    result.requests += 1
    log(`GET ${url}`)
    const response = await fetchFn(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) }
  }

  for (const path of targets) {
    const entry = manifest[path]
    const match = CHART_API.exec(entry?.recordFrom ?? entry?.url ?? '')
    if (!entry || !match) {
      result.skipped.push({ path, reason: 'no chart API request in its provenance entry' })
      continue
    }
    if (refused) {
      result.skipped.push({ path, reason: 'the chart API is rate-limiting; run again later' })
      continue
    }
    const urls = HOSTS.map((host) => `https://${host}${match[1]}`)
    if (options.dryRun) {
      log(`${path}: would request ${urls.join(', then ')}`)
      continue
    }
    let reason = 'every host refused'
    let saved = false
    for (const url of urls) {
      if (result.requests >= maxRequests) {
        reason = `request budget of ${maxRequests} used up`
        break
      }
      let response: { status: number; bytes: Uint8Array }
      try {
        response = await request(url)
      } catch (error) {
        reason = `request failed: ${String(error)}`
        continue
      }
      if (!isChartBody(response.status, response.bytes)) {
        reason = `HTTP ${response.status} without a chart body`
        continue
      }
      writeFileSync(new URL(path, options.fixturesDir), response.bytes)
      manifest[path] = {
        origin: 'recorded',
        url,
        capturedAt: new Date(now()).toISOString(),
        sha256: sha256(response.bytes),
      }
      writeFileSync(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`)
      result.recorded.push(path)
      log(`${path}: recorded (HTTP ${response.status}, ${response.bytes.length} bytes)`)
      saved = true
      break
    }
    if (!saved) {
      result.skipped.push({ path, reason })
      log(`${path}: not recorded (${reason})`)
      if (/HTTP 429/.test(reason) || /budget/.test(reason)) refused = true
    }
  }
  return result
}

function parseArgs(argv: string[]) {
  const only = argv.filter((arg) => !arg.startsWith('--'))
  return { dryRun: argv.includes('--dry-run'), only: only.length > 0 ? only : undefined }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { dryRun, only } = parseArgs(process.argv.slice(2))
  const outcome = await recordFixtures({
    fixturesDir: new URL('../fixtures/', import.meta.url),
    dryRun,
    only,
  })
  for (const { path, reason } of outcome.skipped) console.log(`skipped ${path}: ${reason}`)
  if (!dryRun) {
    console.log(
      `${outcome.recorded.length} recorded in ${outcome.requests} requests. Tests that hard-code ` +
        'values from the hand-written files (for example the $245.27 AAPL close) need updating.',
    )
  }
  if (outcome.skipped.length > 0) process.exitCode = 1
}
