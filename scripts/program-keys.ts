import { Keypair } from '@solana/web3.js'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProgramIds } from './deploy-devnet.js'
import { isEntryPoint, runMain } from './lib/cli.js'
import { loadKeypair } from './lib/keys.js'

/** The programs and the keypair file names `anchor build` and `anchor deploy` expect. */
export const PROGRAMS: readonly { id: keyof ProgramIds; name: string }[] = [
  { id: 'meridian', name: 'meridian' },
  { id: 'meridianOracle', name: 'meridian_oracle' },
]

export interface ProgramKeyDirs {
  /** Where the long-lived keypairs live, outside git (`keys/` is gitignored). */
  keysDir: string
  /** Where Anchor reads them (`target/deploy`). */
  deployDir: string
}

const DEFAULT_DIRS: ProgramKeyDirs = { keysDir: 'keys', deployDir: join('target', 'deploy') }

/**
 * Makes the program IDs stable: generates each program keypair once in `keysDir`, then copies it
 * over whatever `target/deploy` holds. `anchor keys sync` then points `declare_id!` and
 * Anchor.toml at these IDs. The keypairs are never committed.
 */
export function ensureProgramKeypairs(dirs: ProgramKeyDirs = DEFAULT_DIRS): ProgramIds {
  mkdirSync(dirs.keysDir, { recursive: true, mode: 0o700 })
  mkdirSync(dirs.deployDir, { recursive: true })
  const ids = {} as ProgramIds
  PROGRAMS.forEach(({ id, name }) => {
    const file = `${name}-keypair.json`
    const stored = join(dirs.keysDir, file)
    if (!existsSync(stored)) {
      const keypair = Keypair.generate()
      writeFileSync(stored, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 })
    }
    try {
      ids[id] = loadKeypair(stored).publicKey
    } catch (error) {
      throw new Error(`${stored}: ${error instanceof Error ? error.message : String(error)}`)
    }
    copyFileSync(stored, join(dirs.deployDir, file))
  })
  return ids
}

async function main() {
  const ids = ensureProgramKeypairs()
  console.log(`Program IDs: meridian ${ids.meridian}, meridian_oracle ${ids.meridianOracle}`)
}

if (isEntryPoint(import.meta.url)) runMain(main)
