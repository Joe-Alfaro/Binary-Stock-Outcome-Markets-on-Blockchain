import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isEntryPoint, runMain } from './lib/cli.js'

/**
 * Copies the IDLs `anchor build` writes into the automation service, which ships them because a
 * deploy has no `target/` (R65). Each copy takes its program ID from Anchor.toml's devnet entry,
 * not from the build, whose ID follows this checkout's own keypairs. The worker prefers a fresh
 * build when one exists; the automation deploy test fails when the copies drift from it.
 *
 * The program addresses inside the instructions still follow the build, so `make gates` regenerates
 * the copies from the build it tests. `--devnet` also maps those to the devnet IDs: that is what's
 * committed, and it comes out the same on every machine whatever its keypairs.
 */

export const SHIPPED_IDL_DIR = join('services', 'automation', 'idl')
const BUILT_IDL_DIR = join('target', 'idl')
const PROGRAMS = ['meridian', 'meridian_oracle'] as const

/** The `[programs.devnet]` IDs in Anchor.toml. */
export function devnetProgramIds(anchorToml: string): Record<string, string> {
  const lines = anchorToml.split('\n').map((line) => line.trim())
  const start = lines.indexOf('[programs.devnet]')
  if (start === -1) throw new Error('Anchor.toml has no [programs.devnet] section')
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('['))
  const entries = (end === -1 ? rest : rest.slice(0, end))
    .map((line) => /^(\w+)\s*=\s*"(\w+)"/.exec(line))
    .filter((match) => match !== null)
    .map(([, name, id]) => [name, id])
  return Object.fromEntries(entries)
}

export interface ShipIdlsOptions {
  /**
   * `build` keeps the build's program addresses inside the instructions, so the copies match the
   * build under test. `devnet` replaces them with the devnet IDs, for the committed copies.
   */
  addresses?: 'build' | 'devnet'
}

export function shipIdls(root = '.', { addresses = 'build' }: ShipIdlsOptions = {}): string[] {
  const ids = devnetProgramIds(readFileSync(join(root, 'Anchor.toml'), 'utf8'))
  const built = Object.fromEntries(
    PROGRAMS.map((name) => {
      if (!ids[name]) throw new Error(`Anchor.toml [programs.devnet] has no ${name}`)
      const idl = JSON.parse(readFileSync(join(root, BUILT_IDL_DIR, `${name}.json`), 'utf8')) as {
        address: string
      }
      return [name, idl]
    }),
  )
  mkdirSync(join(root, SHIPPED_IDL_DIR), { recursive: true })
  return PROGRAMS.map((name) => {
    let text = JSON.stringify({ ...built[name], address: ids[name] }, null, 2)
    if (addresses === 'devnet') {
      for (const program of PROGRAMS) {
        text = text.replaceAll(built[program]!.address, ids[program] as string)
      }
    }
    const target = join(SHIPPED_IDL_DIR, `${name}.json`)
    writeFileSync(join(root, target), `${text}\n`)
    return target
  })
}

async function main() {
  const addresses = process.argv.includes('--devnet') ? 'devnet' : 'build'
  shipIdls('.', { addresses }).forEach((file) => console.log(`wrote ${file}`))
}

if (isEntryPoint(import.meta.url)) runMain(main)
