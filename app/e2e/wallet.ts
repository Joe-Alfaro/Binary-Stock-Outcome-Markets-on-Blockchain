import { createPrivateKey, sign } from 'node:crypto'
import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'
import bs58 from 'bs58'

/** The adapter the app offers when `NEXT_PUBLIC_E2E_TEST_WALLET=true` (never in production). */
export const TEST_WALLET = 'E2E test wallet'

export interface TestWallet {
  /** How many times the app asked the wallet to sign. */
  signatures(): number
}

// PKCS#8 prefix for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

/** Reads a compact-u16 length; returns it and the bytes it took. */
function compactU16(bytes: Buffer): [number, number] {
  let value = 0
  let size = 0
  let byte = 0x80
  while (byte & 0x80) {
    byte = bytes[size] ?? 0
    value |= (byte & 0x7f) << (7 * size)
    size += 1
  }
  return [value, size]
}

/**
 * Signs a serialized transaction (legacy or v0) as its fee payer, signature slot 0. Uses Node's
 * Ed25519 because Playwright's loader can't load `@solana/web3.js`.
 */
function signAsFeePayer(txBase64: string, secret: Uint8Array): string {
  const tx = Buffer.from(txBase64, 'base64')
  const [count, size] = compactU16(tx)
  const message = tx.subarray(size + count * 64)
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secret.subarray(0, 32))]),
    format: 'der',
    type: 'pkcs8',
  })
  sign(null, message, key).copy(tx, size)
  return tx.toString('base64')
}

/**
 * Exposes the signing bridge the app's test adapter calls. The key stays in the test process;
 * the page only gets the address and signed bytes.
 */
export async function installTestWallet(page: Page, secretKey: number[]): Promise<TestWallet> {
  const secret = Uint8Array.from(secretKey)
  let count = 0
  await page.exposeFunction('meridianE2eWalletPublicKey', () => bs58.encode(secret.subarray(32)))
  await page.exposeFunction('meridianE2eWalletSign', (txBase64: string) => {
    count += 1
    return signAsFeePayer(txBase64, secret)
  })
  return { signatures: () => count }
}

/** Connects the test wallet through the header's wallet picker. */
export async function connectTestWallet(page: Page) {
  const header = page.getByRole('banner')
  await header.getByRole('button', { name: /connect wallet/i }).click()
  await header.getByRole('button', { name: TEST_WALLET }).click()
  await expect(header.getByRole('button', { name: /disconnect/i })).toBeVisible()
}
