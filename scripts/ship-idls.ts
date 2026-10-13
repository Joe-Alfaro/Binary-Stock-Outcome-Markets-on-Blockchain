import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isEntryPoint, runMain } from './lib/cli.js'

/**
 * Copies the IDLs `anchor build` writes into the automation service, which ships them because a
 * deploy has no `target/` (R65). Each copy takes its program ID from Anchor.toml's devnet entry,
 * not from the build, whose ID follows this checkout's own keypairs. The worker prefers a fresh
 * build when one exists; the automation deploy test fails when the copies drift from it.
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

export function shipIdls(root = '.'): string[] {
  const ids = devnetProgramIds(readFileSync(join(root, 'Anchor.toml'), 'utf8'))
  mkdirSync(join(root, SHIPPED_IDL_DIR), { recursive: true })
  return PROGRAMS.map((name) => {
    const address = ids[name]
    if (!address) throw new Error(`Anchor.toml [programs.devnet] has no ${name}`)
    const built = JSON.parse(readFileSync(join(root, BUILT_IDL_DIR, `${name}.json`), 'utf8')) as {
      address: string
    }
    const target = join(SHIPPED_IDL_DIR, `${name}.json`)
    writeFileSync(join(root, target), `${JSON.stringify({ ...built, address }, null, 2)}\n`)
    return target
  })
}

async function main() {
  shipIdls().forEach((file) => console.log(`wrote ${file}`))
}

if (isEntryPoint(import.meta.url)) runMain(main)
