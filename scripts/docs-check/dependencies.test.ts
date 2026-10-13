// R63: every direct dependency is named in a README dependency table with a one-line reason.
// The list comes from the manifests, so a new dependency fails here until it is documented.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readRepoFile, sections, trackedFiles } from './repo.js'

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]

interface PackageJson {
  name?: string
  workspaces?: string[]
  [field: string]: unknown
}

function readJson(path: string) {
  const text = readRepoFile(path)
  assert.ok(text, `${path} is missing`)
  return JSON.parse(text) as PackageJson
}

function npmDependencies() {
  const root = readJson('package.json')
  const manifests = [
    { path: 'package.json', json: root },
    ...(root.workspaces ?? []).map((dir) => ({
      path: `${dir}/package.json`,
      json: readJson(`${dir}/package.json`),
    })),
  ]
  const internal = new Set(manifests.map((m) => m.json.name).filter(Boolean))
  return manifests.flatMap(({ path, json }) =>
    dependencyFields.flatMap((field) =>
      Object.keys((json[field] as Record<string, string> | undefined) ?? {})
        .filter((name) => !internal.has(name))
        .map((name) => ({ name, manifest: path })),
    ),
  )
}

// Reads keys from `[dependencies]` and `[workspace.dependencies]` tables, plus `[dependencies.<name>]`.
function cargoDependencies() {
  const manifests = trackedFiles().filter((f) => f === 'Cargo.toml' || f.endsWith('/Cargo.toml'))
  return manifests.flatMap((path) => {
    const lines = (readRepoFile(path) ?? '').split('\n')
    const found: string[] = []
    lines.reduce<string | undefined>((table, raw) => {
      const line = raw.replace(/#.*$/, '').trim()
      const header = /^\[([^\]]+)\]$/.exec(line)
      if (header) {
        const name = header[1]!.trim()
        const inline = /^(?:workspace\.)?dependencies\.(.+)$/.exec(name)
        if (inline) found.push(inline[1]!.replace(/"/g, ''))
        return name
      }
      const key = /^([A-Za-z0-9_-]+|"[^"]+")\s*=/.exec(line)
      if (key && (table === 'dependencies' || table === 'workspace.dependencies')) {
        found.push(key[1]!.replace(/"/g, ''))
      }
      return table
    }, undefined)
    return found.map((name) => ({ name, manifest: path }))
  })
}

// Maps each name in the first cell of a README dependency table row to the row's reason.
function documentedDependencies(readme: string) {
  const rows = sections(readme)
    .filter((s) => /dependenc/i.test(s.heading))
    .flatMap((s) => s.body.split('\n'))
    .filter((line) => /^\s*\|/.test(line) && !/^\s*\|[\s:|-]+\|\s*$/.test(line))
  const entries = rows.flatMap((row) => {
    const cells = row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())
    const reason = cells.slice(1).filter(Boolean).at(-1) ?? ''
    return cells[0]!
      .split(/,|;|\band\b/)
      .map((n) => n.replace(/[`*]/g, '').trim())
      .filter(Boolean)
      .map((name) => [name, reason] as const)
  })
  return new Map(entries)
}

describe('dependency justification (R63)', () => {
  const required = [...npmDependencies(), ...cargoDependencies()]

  it('finds the direct dependencies in the manifests', () => {
    const names = required.map((d) => d.name)
    assert.ok(names.includes('next'), 'expected app/package.json to depend on next')
    assert.ok(names.includes('anchor-lang'), 'expected a Cargo.toml to depend on anchor-lang')
    assert.ok(!names.includes('@meridian/sdk'), 'workspace packages are not external dependencies')
  })

  it('names every direct dependency in a README dependency table with a one-line reason', () => {
    const readme = readRepoFile('README.md')
    assert.ok(readme, 'README.md is missing from the repo root')
    const documented = documentedDependencies(readme)
    const undocumented = [
      ...new Set(
        required
          .filter((d) => (documented.get(d.name) ?? '').split(/\s+/).filter(Boolean).length < 3)
          .map((d) => `${d.name} (${d.manifest})`),
      ),
    ]
    assert.deepEqual(undocumented, [], 'add a row with a reason of at least three words for each')
  })
})
