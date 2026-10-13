import { Keypair } from '@solana/web3.js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { findKeypairFiles, loadKeypair, loadRoleKeys } from './keys.js'
import { REPO_ROOT, base58Secret, roleKeyEnv, writeKeypairFile } from './test-support.js'

// R43: keys load from a file path or a base58 env var.
describe('loadKeypair (R43)', () => {
  it('loads a solana-keygen JSON file from a path', () => {
    const { keypair, path } = writeKeypairFile()
    const loaded = loadKeypair(path)
    assert.equal(loaded.publicKey, keypair.publicKey.toBase58())
    assert.deepEqual(Array.from(loaded.secretKey), Array.from(keypair.secretKey))
  })

  it('loads a base58-encoded secret key', () => {
    const keypair = Keypair.generate()
    assert.equal(loadKeypair(base58Secret(keypair)).publicKey, keypair.publicKey.toBase58())
  })

  it('rejects an empty value, a missing file and a malformed key file', () => {
    // A real rejection, not the stub's placeholder error.
    const realError = (error: unknown) =>
      error instanceof Error && !/not implemented/.test(error.message)
    assert.throws(() => loadKeypair(''), realError)
    assert.throws(() => loadKeypair('/nonexistent/meridian/key.json'), realError)
    assert.throws(() => loadKeypair('/fake/key.json', () => '[1,2,3]'), realError)
  })
})

// R43: admin, automation and relay-signer keys must be distinct, or the scripts fail.
describe('loadRoleKeys (R43)', () => {
  it('loads all four roles when they are distinct', () => {
    const { env, publicKeys } = roleKeyEnv()
    const keys = loadRoleKeys(env)
    assert.equal(keys.admin.publicKey, publicKeys.admin)
    assert.equal(keys.automation.publicKey, publicKeys.automation)
    assert.deepEqual(
      keys.relaySigners.map((key) => key.publicKey),
      [publicKeys.relay1, publicKeys.relay2],
    )
  })

  it('treats RELAY_SIGNER_2_KEYPAIR as optional', () => {
    const { env } = roleKeyEnv()
    assert.equal(loadRoleKeys({ ...env, RELAY_SIGNER_2_KEYPAIR: '' }).relaySigners.length, 1)
  })

  it('names the missing variable', () => {
    const { env } = roleKeyEnv()
    assert.throws(
      () => loadRoleKeys({ ...env, AUTOMATION_KEYPAIR: undefined }),
      /AUTOMATION_KEYPAIR/,
    )
  })

  it('fails when admin and automation are the same key', () => {
    const { env } = roleKeyEnv()
    assert.throws(
      () => loadRoleKeys({ ...env, AUTOMATION_KEYPAIR: env.ADMIN_KEYPAIR }),
      /distinct/i,
    )
  })

  it('fails when a relay signer reuses the admin key, even in another format', () => {
    const admin = writeKeypairFile()
    const { env } = roleKeyEnv()
    assert.throws(
      () =>
        loadRoleKeys({
          ...env,
          ADMIN_KEYPAIR: admin.path,
          RELAY_SIGNER_1_KEYPAIR: base58Secret(admin.keypair),
        }),
      /distinct/i,
    )
  })

  it('fails when both relay signers are the same key', () => {
    const { env } = roleKeyEnv()
    assert.throws(
      () => loadRoleKeys({ ...env, RELAY_SIGNER_2_KEYPAIR: env.RELAY_SIGNER_1_KEYPAIR }),
      /distinct/i,
    )
  })
})

// R43: a repo check confirms no keypair files are tracked.
describe('findKeypairFiles (R43)', () => {
  const keypairJson = JSON.stringify(Array.from(Keypair.generate().secretKey))

  it('flags keypair files by name and by content', () => {
    const files: Record<string, string> = {
      'target/deploy/meridian-keypair.json': keypairJson,
      'keys/admin.json': keypairJson,
      'id.json': keypairJson,
      'fixtures/innocent-name.json': keypairJson,
      'packages/sdk/src/index.ts': 'export {}',
      'packages/price-providers/fixtures/yahoo/AAPL.json': '{"chart":{}}',
      'fixtures/numbers.json': '[1,2,3]',
    }
    const found = findKeypairFiles(Object.keys(files), (path) => files[path] ?? '')
    assert.deepEqual(found.sort(), [
      'fixtures/innocent-name.json',
      'id.json',
      'keys/admin.json',
      'target/deploy/meridian-keypair.json',
    ])
  })

  it('finds no keypair files tracked in this repository', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    const readFromRepo = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8')
    assert.deepEqual(findKeypairFiles(tracked, readFromRepo), [])
  })

  it('has .gitignore rules that exclude keypair files', () => {
    const paths = ['target/deploy/meridian-keypair.json', 'keys/admin.json', 'id.json', '.env']
    const ignored = execFileSync('git', ['check-ignore', '--no-index', ...paths], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
    assert.deepEqual(ignored.sort(), [...paths].sort())
  })
})
