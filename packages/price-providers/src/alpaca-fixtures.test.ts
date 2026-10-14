// R67, D67: every Alpaca fixture is small, has a provenance entry, and carries no credentials.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { describe, it } from 'node:test'

const FIXTURES = new URL('../fixtures/', import.meta.url)
const README = new URL('../../../README.md', import.meta.url)
const MAX_BYTES = 200 * 1024

interface Provenance {
  origin: string
  url?: string
  capturedAt?: string
  recordFrom?: string
  note?: string
  sha256: string
}

const ALPACA_URL = /^(https:\/\/data\.alpaca\.markets\/v2\/stocks\/|wss:\/\/stream\.data\.alpaca\.markets\/v2\/)/
const CREDENTIAL_PARAM = /key|secret|token|apca/i

const files = readdirSync(new URL('alpaca/', FIXTURES)).map((name) => `alpaca/${name}`)
const manifest = JSON.parse(readFileSync(new URL('provenance.json', FIXTURES), 'utf8')) as Record<
  string,
  Provenance
>

function checkUrl(path: string, url: string | undefined) {
  assert.match(url ?? '', ALPACA_URL, `${path} needs the Alpaca request it came from`)
  const parsed = new URL(url ?? '')
  parsed.searchParams.forEach((_value, name) =>
    assert.doesNotMatch(name, CREDENTIAL_PARAM, `${path} URL carries a credential (${name})`),
  )
  assert.equal(parsed.username + parsed.password, '', `${path} URL carries credentials`)
}

describe('Alpaca fixture provenance (R67, D67)', () => {
  it('has Alpaca fixtures', () => {
    assert.ok(files.length >= 8)
  })

  files.forEach((path) => {
    it(`${path} is under 200 KB, has provenance and no credentials`, () => {
      const body = readFileSync(new URL(path, FIXTURES), 'utf8')
      assert.ok(statSync(new URL(path, FIXTURES)).size < MAX_BYTES, `${path} is over 200 KB`)
      const entry = manifest[path]
      assert.ok(entry, `${path} has no provenance entry`)
      if (entry.origin === 'recorded') {
        checkUrl(path, entry.url)
        assert.ok(Number.isFinite(Date.parse(entry.capturedAt ?? '')), `${path} capturedAt`)
      } else if (entry.origin === 'hand-written') {
        checkUrl(path, entry.recordFrom)
        assert.match(entry.note ?? '', /by hand|hand-written/i, `${path} note says hand-written`)
      } else {
        assert.fail(`${path} origin must be recorded or hand-written, got ${entry.origin}`)
      }
      assert.equal(
        createHash('sha256').update(body).digest('hex'),
        entry.sha256,
        `${path} changed since its provenance entry was written`,
      )
      assert.doesNotMatch(body, /APCA-API-(KEY-ID|SECRET-KEY)/i, `${path} holds auth headers`)
      assert.doesNotMatch(body, /\b[PA]K[A-Z0-9]{16,}\b/, `${path} holds something like a key id`)
    })
  })

  it('the websocket transcripts hold placeholders, not credentials, in the auth message', () => {
    files
      .filter((path) => path.includes('stream-'))
      .forEach((path) => {
        const recording = JSON.parse(readFileSync(new URL(path, FIXTURES), 'utf8')) as {
          transcript: { dir: string; message: Record<string, unknown> }[]
        }
        const auth = recording.transcript.find(
          (entry) => entry.dir === 'client' && entry.message.action === 'auth',
        )
        assert.deepEqual(auth?.message, {
          action: 'auth',
          key: '<ALPACA_API_KEY>',
          secret: '<ALPACA_API_SECRET>',
        })
      })
  })
})

describe('README on the Alpaca feeds (R67)', () => {
  const readme = readFileSync(README, 'utf8')

  it('says which feed backs each value and the free-plan limitation', () => {
    assert.match(readme, /Alpaca/)
    assert.match(readme, /\bSIP\b/)
    assert.match(readme, /\bIEX\b/)
    assert.match(readme, /15 minutes/)
    assert.match(readme, /ALPACA_API_KEY/)
    assert.match(readme, /ALPACA_API_SECRET/)
  })
})
