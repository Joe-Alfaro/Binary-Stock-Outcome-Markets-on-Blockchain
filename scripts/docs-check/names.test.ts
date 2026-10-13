// R64: no client, program or contact name appears in tracked files, commit messages or branch names.
// The names are never written into the repo. They are read from the file named by
// MERIDIAN_FORBIDDEN_NAMES_FILE, one per line, which lives outside the repo.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { git, readRepoFile, trackedFiles } from './repo.js'

const namesFile = process.env.MERIDIAN_FORBIDDEN_NAMES_FILE
const skip = namesFile
  ? false
  : 'MERIDIAN_FORBIDDEN_NAMES_FILE is not set; set it to a file of forbidden names, one per line'

function forbiddenNames() {
  return readFileSync(namesFile!, 'utf8')
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean)
}

// Returns "<where>: name #<line>" for each name found. Hits cite the line in the names file so
// test output never prints a name.
function scan(where: string, text: string, names: string[]) {
  const lower = text.toLowerCase()
  return names.flatMap((n, i) =>
    lower.includes(n.toLowerCase()) ? [`${where}: name #${i + 1}`] : [],
  )
}

describe('no company or program names (R64)', { skip }, () => {
  const names = namesFile ? forbiddenNames() : []

  it('reads at least one name from the names file', () => {
    assert.ok(names.length > 0, `${namesFile} lists no names`)
  })

  it('finds no name in tracked file paths or contents', () => {
    const hits = trackedFiles().flatMap((path) => [
      ...scan(`path ${path}`, path, names),
      ...scan(path, readRepoFile(path) ?? '', names),
    ])
    assert.deepEqual(hits, [])
  })

  it('finds no name in commit messages', () => {
    const hits = git(['log', '--format=%H%n%B%x00', 'HEAD'])
      .split('\0')
      .flatMap((entry) => {
        const [sha = '', ...message] = entry.trim().split('\n')
        return scan(`commit ${sha.slice(0, 10)}`, message.join('\n'), names)
      })
    assert.deepEqual(hits, [])
  })

  it('finds no name in branch names', () => {
    const hits = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
      .split('\n')
      .filter(Boolean)
      .flatMap((branch) => scan(`branch ${branch}`, branch, names))
    assert.deepEqual(hits, [])
  })
})
