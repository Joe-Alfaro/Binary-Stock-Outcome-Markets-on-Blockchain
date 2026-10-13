import { Keypair } from '@solana/web3.js'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { SHIPPED_IDL_DIR, shipIdls } from './ship-idls.js'

const DEVNET = {
  meridian: Keypair.generate().publicKey.toBase58(),
  meridian_oracle: Keypair.generate().publicKey.toBase58(),
}

/** A checkout whose `anchor build` used this machine's own program IDs (`anchor keys sync`). */
function checkout() {
  const root = mkdtempSync(join(tmpdir(), 'meridian-ship-idls-'))
  const local = {
    meridian: Keypair.generate().publicKey.toBase58(),
    meridian_oracle: Keypair.generate().publicKey.toBase58(),
  }
  writeFileSync(
    join(root, 'Anchor.toml'),
    [
      '[programs.localnet]',
      `meridian = "${local.meridian}"`,
      `meridian_oracle = "${local.meridian_oracle}"`,
      '',
      '[programs.devnet]',
      `meridian = "${DEVNET.meridian}"`,
      `meridian_oracle = "${DEVNET.meridian_oracle}"`,
      '',
    ].join('\n'),
  )
  mkdirSync(join(root, 'target', 'idl'), { recursive: true })
  // Each IDL embeds both program addresses inside its instructions, as the real ones do.
  const idl = (self: string, other: string) => ({
    address: self,
    instructions: [
      {
        name: 'settle_market',
        accounts: [
          { name: 'program', address: self },
          { name: 'oracle_program', address: other },
        ],
      },
    ],
    accounts: [{ name: 'Config' }],
    types: [{ name: 'Config' }],
  })
  const built = {
    meridian: idl(local.meridian, local.meridian_oracle),
    meridian_oracle: idl(local.meridian_oracle, local.meridian),
  }
  for (const [name, content] of Object.entries(built)) {
    writeFileSync(join(root, 'target', 'idl', `${name}.json`), JSON.stringify(content))
  }
  return { root, local, built }
}

function shipped(root: string, name: string) {
  return JSON.parse(readFileSync(join(root, SHIPPED_IDL_DIR, `${name}.json`), 'utf8')) as {
    address: string
    instructions: unknown
    accounts: unknown
    types: unknown
  }
}

describe('shipIdls (R65)', () => {
  it('by default copies the interface of the build being tested, with the devnet address on top', () => {
    const { root, built } = checkout()
    shipIdls(root)
    for (const name of ['meridian', 'meridian_oracle'] as const) {
      const copy = shipped(root, name)
      assert.equal(copy.address, DEVNET[name])
      assert.deepEqual(copy.instructions, built[name].instructions)
      assert.deepEqual(copy.accounts, built[name].accounts)
      assert.deepEqual(copy.types, built[name].types)
    }
  })

  it('with devnet addresses replaces every build program ID, so the committed copies match on any machine', () => {
    const first = checkout()
    const second = checkout()
    shipIdls(first.root, { addresses: 'devnet' })
    shipIdls(second.root, { addresses: 'devnet' })
    for (const name of ['meridian', 'meridian_oracle'] as const) {
      const text = readFileSync(join(first.root, SHIPPED_IDL_DIR, `${name}.json`), 'utf8')
      assert.ok(!text.includes(first.local.meridian), `${name} still has the build meridian ID`)
      assert.ok(
        !text.includes(first.local.meridian_oracle),
        `${name} still has the build oracle ID`,
      )
      assert.equal(text, readFileSync(join(second.root, SHIPPED_IDL_DIR, `${name}.json`), 'utf8'))
    }
    const meridian = shipped(first.root, 'meridian')
    assert.equal(meridian.address, DEVNET.meridian)
    assert.deepEqual(meridian.instructions, [
      {
        name: 'settle_market',
        accounts: [
          { name: 'program', address: DEVNET.meridian },
          { name: 'oracle_program', address: DEVNET.meridian_oracle },
        ],
      },
    ])
  })
})
