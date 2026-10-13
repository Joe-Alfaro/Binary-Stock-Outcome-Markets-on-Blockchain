import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const repoRoot = resolve(import.meta.dirname, '..', '..')

export function git(args: string[]) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}

export function readRepoFile(path: string) {
  const full = join(repoRoot, path)
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined
}

export function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean)
}

export interface Section {
  heading: string
  level: number
  // The text under the heading, including its subsections.
  body: string
}

// Splits markdown into sections by ATX heading, ignoring headings inside fenced code blocks.
export function sections(markdown: string): Section[] {
  const lines = markdown.split('\n')
  const headings: { index: number; level: number; heading: string }[] = []
  lines.reduce((inFence, line, index) => {
    if (/^\s*(```|~~~)/.test(line)) return !inFence
    const match = !inFence && /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (match) headings.push({ index, level: match[1]!.length, heading: match[2]! })
    return inFence
  }, false)
  return headings.map((h, i) => {
    const next = headings.slice(i + 1).find((other) => other.level <= h.level)
    const end = next ? next.index : lines.length
    return { heading: h.heading, level: h.level, body: lines.slice(h.index + 1, end).join('\n') }
  })
}
