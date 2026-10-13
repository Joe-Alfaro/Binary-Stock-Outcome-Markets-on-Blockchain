import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createWalletAdapters } from '../../src/lib/wallet/adapters'

/**
 * The e2e test wallet (R22, R56 harness). Playwright exposes two functions on `window` and the
 * adapter signs through them, so no secret key ever reaches the browser bundle:
 *
 * - `meridianE2eWalletPublicKey(): Promise<string>`: the wallet's base58 address.
 * - `meridianE2eWalletSign(txBase64: string): Promise<string>`: the serialized transaction,
 *   signed by the wallet, as base64.
 */
const TEST_WALLET = 'E2E test wallet'

interface Bridge {
  meridianE2eWalletPublicKey?: () => Promise<string>
  meridianE2eWalletSign?: (txBase64: string) => Promise<string>
}

const bridgeWindow = window as unknown as Bridge
const savedEnv = { ...process.env }

afterEach(() => {
  process.env = { ...savedEnv }
  delete bridgeWindow.meridianE2eWalletPublicKey
  delete bridgeWindow.meridianE2eWalletSign
})

function setEnv(values: Record<string, string>) {
  Object.assign(process.env, values)
}

function names() {
  return createWalletAdapters().map((entry) => entry.name)
}

function unsignedTransfer(payer: Keypair) {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

describe('e2e test wallet adapter (R22, R56)', () => {
  it('is not offered unless NEXT_PUBLIC_E2E_TEST_WALLET is set', () => {
    delete process.env.NEXT_PUBLIC_E2E_TEST_WALLET
    assert.deepEqual(names(), ['Phantom', 'Solflare'])
  })

  it('is offered in development when NEXT_PUBLIC_E2E_TEST_WALLET=true', () => {
    setEnv({ NODE_ENV: 'development', NEXT_PUBLIC_E2E_TEST_WALLET: 'true' })
    assert.ok(names().includes(TEST_WALLET), names().join(', '))
    assert.ok(names().includes('Phantom') && names().includes('Solflare'))
  })

  it('is never offered in a production build, even with the flag set', () => {
    setEnv({ NODE_ENV: 'production', NEXT_PUBLIC_E2E_TEST_WALLET: 'true' })
    assert.deepEqual(names(), ['Phantom', 'Solflare'])
  })

  it('connects to the bridged key and signs each transaction through the bridge once', async () => {
    setEnv({ NODE_ENV: 'development', NEXT_PUBLIC_E2E_TEST_WALLET: 'true' })
    const keypair = Keypair.generate()
    let signs = 0
    bridgeWindow.meridianE2eWalletPublicKey = async () => keypair.publicKey.toBase58()
    bridgeWindow.meridianE2eWalletSign = async (txBase64) => {
      signs += 1
      const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, 'base64'))
      tx.sign([keypair])
      return Buffer.from(tx.serialize()).toString('base64')
    }

    const entry = createWalletAdapters().find((candidate) => candidate.name === TEST_WALLET)
    assert.ok(entry, 'no test wallet entry')
    const adapter = entry.create()
    await adapter.connect()
    assert.equal(adapter.connected, true)
    assert.equal(adapter.publicKey?.toBase58(), keypair.publicKey.toBase58())

    const signed = await adapter.signTransaction(unsignedTransfer(keypair))
    assert.equal(signs, 1)
    assert.ok(signed instanceof VersionedTransaction)
    assert.equal(signed.signatures.length, 1)
    assert.ok(
      signed.signatures[0]?.some((byte) => byte !== 0),
      'transaction is not signed',
    )
  })
})
