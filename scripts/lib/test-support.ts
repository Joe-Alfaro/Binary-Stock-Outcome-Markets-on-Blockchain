import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BootstrapClient, ConfigParams } from '../bootstrap.js'
import { MAINNET_GENESIS_HASH } from '../guard.js'

export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
export const TESTNET_GENESIS_HASH = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY'
export { MAINNET_GENESIS_HASH }

/** Repository root, so file checks work from any working directory. */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url))

export const MOCK_MINT = Keypair.generate().publicKey.toBase58()

/** Writes a solana-keygen style keypair file to a temp directory, never the repo. */
export function writeKeypairFile(keypair: Keypair = Keypair.generate()) {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-keys-'))
  const path = join(dir, 'key.json')
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)))
  return { keypair, path }
}

export function base58Secret(keypair: Keypair) {
  return bs58.encode(keypair.secretKey)
}

/** Four distinct role keys as env values: admin and automation as files, relay signers as base58. */
export function roleKeyEnv() {
  const admin = writeKeypairFile()
  const automation = writeKeypairFile()
  const relay1 = Keypair.generate()
  const relay2 = Keypair.generate()
  return {
    env: {
      ADMIN_KEYPAIR: admin.path,
      AUTOMATION_KEYPAIR: automation.path,
      RELAY_SIGNER_1_KEYPAIR: base58Secret(relay1),
      RELAY_SIGNER_2_KEYPAIR: base58Secret(relay2),
    },
    publicKeys: {
      admin: admin.keypair.publicKey.toBase58(),
      automation: automation.keypair.publicKey.toBase58(),
      relay1: relay1.publicKey.toBase58(),
      relay2: relay2.publicKey.toBase58(),
    },
  }
}

/** Records every call in order, so tests can check ordering and that nothing ran. */
export class CallLog {
  readonly calls: string[] = []
  record(name: string) {
    this.calls.push(name)
  }
  indexOf(name: string) {
    return this.calls.findIndex((call) => call === name || call.startsWith(`${name}:`))
  }
}

/** A bootstrap chain client that records calls and never touches a network. */
export function fakeBootstrapClient(genesisHash = DEVNET_GENESIS_HASH) {
  const log = new CallLog()
  const configs: ConfigParams[] = []
  const signers: string[] = []
  const mintDecimals: number[] = []
  const demoModes: boolean[] = []
  const client: BootstrapClient = {
    async getGenesisHash() {
      log.record('getGenesisHash')
      return genesisHash
    },
    async createMockUsdcMint(decimals) {
      log.record('createMockUsdcMint')
      mintDecimals.push(decimals)
      return { mint: MOCK_MINT, signature: 'sig-mint' }
    },
    async initializeConfig(params) {
      log.record('initializeConfig')
      configs.push(params)
      return 'sig-config'
    },
    async registerRelaySigner(signer) {
      log.record(`registerRelaySigner:${signer}`)
      signers.push(signer)
      return `sig-signer-${signers.length}`
    },
    async setDemoMode(enabled) {
      log.record(`setDemoMode:${enabled}`)
      demoModes.push(enabled)
      return 'sig-demo-mode'
    },
  }
  return { client, log, configs, signers, mintDecimals, demoModes }
}
