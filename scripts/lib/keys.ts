/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation lands */
import { readFileSync } from 'node:fs'

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

/** Loads a keypair from a file path (solana-keygen JSON) or a base58-encoded secret key. */
export function loadKeypair(_value: string, _readFile: ReadFile = readUtf8): LoadedKey {
  throw new Error('not implemented')
}

/**
 * Loads ADMIN_KEYPAIR, AUTOMATION_KEYPAIR, RELAY_SIGNER_1_KEYPAIR and the optional
 * RELAY_SIGNER_2_KEYPAIR, and fails unless every key is distinct.
 */
export function loadRoleKeys(_env: NodeJS.ProcessEnv, _readFile: ReadFile = readUtf8): RoleKeys {
  throw new Error('not implemented')
}

/** Returns the paths that look like keypair files, by name or by content. */
export function findKeypairFiles(_paths: string[], _readFile: ReadFile = readUtf8): string[] {
  throw new Error('not implemented')
}
