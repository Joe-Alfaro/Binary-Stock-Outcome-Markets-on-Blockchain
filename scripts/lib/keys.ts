import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

export type ReadFile = (path: string) => string

export interface LoadedKey {
  /** Base58 public key. */
  publicKey: string
  /** 64-byte secret key (seed followed by public key), as solana-keygen writes it. */
  secretKey: Uint8Array
}

export interface RoleKeys {
  admin: LoadedKey
  automation: LoadedKey
  relaySigners: LoadedKey[]
}

const readUtf8: ReadFile = (path) => readFileSync(path, 'utf8')

const SECRET_KEY_BYTES = 64
const BASE58_SECRET = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/
const KEYPAIR_FILE_NAME = /(^|\/)(id\.json|[^/]*-keypair\.json|keys\/[^/]+\.json)$/

/** Parses solana-keygen JSON: an array of 64 bytes. Returns null for anything else. */
function parseKeypairJson(content: string): Uint8Array | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  const isBytes =
    Array.isArray(parsed) &&
    parsed.length === SECRET_KEY_BYTES &&
    parsed.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  return isBytes ? Uint8Array.from(parsed as number[]) : null
}

function toLoadedKey(secretKey: Uint8Array): LoadedKey {
  // fromSecretKey checks that the public half matches the seed.
  const keypair = Keypair.fromSecretKey(secretKey)
  return { publicKey: keypair.publicKey.toBase58(), secretKey: keypair.secretKey }
}

/** Loads a keypair from a file path (solana-keygen JSON) or a base58-encoded secret key. */
export function loadKeypair(value: string, readFile: ReadFile = readUtf8): LoadedKey {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error('Keypair value is empty')
  if (BASE58_SECRET.test(trimmed)) {
    const decoded = bs58.decode(trimmed)
    if (decoded.length === SECRET_KEY_BYTES) return toLoadedKey(decoded)
  }
  const path = trimmed.replace(/^~(?=\/)/, homedir())
  const secretKey = parseKeypairJson(readFile(path))
  if (secretKey === null) throw new Error(`${path} is not a keypair file (64-byte JSON array)`)
  return toLoadedKey(secretKey)
}

function loadRole(env: NodeJS.ProcessEnv, name: string, readFile: ReadFile): LoadedKey {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set`)
  try {
    return loadKeypair(value, readFile)
  } catch (error) {
    throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Loads ADMIN_KEYPAIR, AUTOMATION_KEYPAIR, RELAY_SIGNER_1_KEYPAIR and the optional
 * RELAY_SIGNER_2_KEYPAIR, and fails unless every key is distinct.
 */
export function loadRoleKeys(env: NodeJS.ProcessEnv, readFile: ReadFile = readUtf8): RoleKeys {
  const roles: [string, LoadedKey][] = [
    ['ADMIN_KEYPAIR', loadRole(env, 'ADMIN_KEYPAIR', readFile)],
    ['AUTOMATION_KEYPAIR', loadRole(env, 'AUTOMATION_KEYPAIR', readFile)],
    ['RELAY_SIGNER_1_KEYPAIR', loadRole(env, 'RELAY_SIGNER_1_KEYPAIR', readFile)],
  ]
  if (env.RELAY_SIGNER_2_KEYPAIR) {
    roles.push(['RELAY_SIGNER_2_KEYPAIR', loadRole(env, 'RELAY_SIGNER_2_KEYPAIR', readFile)])
  }

  const owners = new Map<string, string>()
  roles.forEach(([name, key]) => {
    const owner = owners.get(key.publicKey)
    if (owner) throw new Error(`${owner} and ${name} must be distinct keypairs`)
    owners.set(key.publicKey, name)
  })

  const [admin, automation, ...relaySigners] = roles.map(([, key]) => key) as [
    LoadedKey,
    LoadedKey,
    ...LoadedKey[],
  ]
  return { admin, automation, relaySigners }
}

/** Returns the paths that look like keypair files, by name or by content. */
export function findKeypairFiles(paths: string[], readFile: ReadFile = readUtf8): string[] {
  return paths.filter((path) => {
    if (KEYPAIR_FILE_NAME.test(path)) return true
    if (!path.endsWith('.json')) return false
    try {
      return parseKeypairJson(readFile(path)) !== null
    } catch {
      // Tracked but deleted in the working tree.
      return false
    }
  })
}
