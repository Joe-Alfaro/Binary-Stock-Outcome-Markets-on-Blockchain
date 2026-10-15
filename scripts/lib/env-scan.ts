const NAME = '[A-Z][A-Z0-9_]*'
/** Dot reads on `process.env` or an injected `env`, with or without optional chaining. */
const DOT_READ = new RegExp(`\\b(?:process\\.)?env\\??\\.(${NAME})\\b`, 'g')
/** Bracket reads with a string literal key. */
const BRACKET_READ = new RegExp(
  `\\b(?:process\\.)?env\\??\\.?\\[\\s*['"\`](${NAME})['"\`]\\s*\\]`,
  'g',
)
/**
 * Destructuring from `process.env` or an injected `env`, including renamed and defaulted bindings
 * and a destructured parameter, optionally typed, that defaults to either. `= env.x` destructures
 * something else and doesn't match.
 */
const DESTRUCTURE =
  /\{([^{}]*)\}\s*(?::[^={}]*)?=\s*\b(?:process\.)?env\b(?!\s*\??\.\s*[\w[]|\s*\[)/g

/** `$NAME` or `${NAME…}`, which also matches a read nested in another's default. */
const SHELL_REF = new RegExp(`\\$(?:(${NAME})\\b|\\{#?(${NAME})\\b)`, 'g')
/** `NAME=…`, alone or after `export`, `local`, `readonly` or `declare`, or as a command prefix. */
const SHELL_ASSIGN = new RegExp(`(?:^|[\\s;&|(])(${NAME})\\+?=`, 'gm')
const SHELL_FOR = new RegExp(`\\bfor\\s+(${NAME})\\s+in\\b`, 'g')
/** `read [-flags] NAME…`. */
const SHELL_READ_BUILTIN = new RegExp(`\\bread(?:\\s+-\\w+)*((?:\\s+${NAME})+)`, 'g')

const SECRET_NAME = /SECRET|TOKEN|KEYPAIR|PRIVATE|PASSWORD|PASSPHRASE|API_KEY|MNEMONIC|SEED/
const BASE58_KEY = /^[1-9A-HJ-NP-Za-km-z]{64,}$/
const BYTE_ARRAY = /^\[\s*\d{1,3}(\s*,\s*\d{1,3}){31,}\s*\]$/
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/
const URL_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i
const URL_KEY_PARAM = /[?&](api[-_]?key|key|token|secret|access[-_]?token|auth)=[^&\s]+/i

/** Names of the environment variables a source file reads, in dot, bracket or destructured form. */
export function findEnvReads(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(DOT_READ)) names.add(match[1] as string)
  for (const match of source.matchAll(BRACKET_READ)) names.add(match[1] as string)
  for (const match of source.matchAll(DESTRUCTURE)) {
    ;(match[1] as string).split(',').forEach((part) => {
      const name = part.split(':')[0]?.split('=')[0]?.trim() ?? ''
      if (new RegExp(`^${NAME}$`).test(name)) names.add(name)
    })
  }
  return [...names]
}

/**
 * Names of the environment variables a shell script reads: `$NAME`, `${NAME}` and
 * `${NAME:-default}`, leaving out positional and special parameters and the script's own
 * variables (assigned, `local`, `export NAME=…`, `for NAME in`, `read NAME`).
 */
export function findShellEnvReads(source: string): string[] {
  const code = source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  const own = new Set<string>()
  for (const match of code.matchAll(SHELL_ASSIGN)) own.add(match[1] as string)
  for (const match of code.matchAll(SHELL_FOR)) own.add(match[1] as string)
  for (const match of code.matchAll(SHELL_READ_BUILTIN)) {
    ;(match[1] as string)
      .trim()
      .split(/\s+/)
      .forEach((name) => own.add(name))
  }
  const names = new Set<string>()
  for (const match of code.matchAll(SHELL_REF)) {
    const name = (match[1] ?? match[2]) as string
    if (!own.has(name)) names.add(name)
  }
  return [...names]
}

/** Variable names and values in a .env file, ignoring comments and blank lines. */
export function parseEnvFile(content: string): Map<string, string> {
  const entries = new Map<string, string>()
  content.split('\n').forEach((raw) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    const separator = line.indexOf('=')
    if (separator < 0) return
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim())
  })
  return entries
}

/** True when a .env value looks like a secret that must not be committed. */
export function looksSecret(name: string, value: string): boolean {
  if (value === '') return false
  if (SECRET_NAME.test(name)) return true
  return [BASE58_KEY, BYTE_ARRAY, PEM, URL_CREDENTIALS, URL_KEY_PARAM].some((pattern) =>
    pattern.test(value),
  )
}
