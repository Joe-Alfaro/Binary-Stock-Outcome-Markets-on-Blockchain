import type {
  TransactionOrVersionedTransaction,
  WalletName,
  WalletReadyState as ReadyState,
} from '@solana/wallet-adapter-base'
import {
  BaseSignerWalletAdapter,
  WalletNotConnectedError,
  WalletNotReadyError,
  WalletReadyState,
} from '@solana/wallet-adapter-base'
import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'

export const E2E_TEST_WALLET_NAME = 'E2E test wallet' as WalletName<'E2E test wallet'>

/**
 * The signing bridge Playwright exposes on `window` (`app/e2e/wallet.ts`). The secret key stays
 * in the test process: the page only sees the address and the signed bytes.
 */
interface E2eBridge {
  meridianE2eWalletPublicKey?: () => Promise<string>
  meridianE2eWalletSign?: (txBase64: string) => Promise<string>
}

function bridge(): E2eBridge {
  return typeof window === 'undefined' ? {} : (window as unknown as E2eBridge)
}

function toBase64(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64(text: string) {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

/**
 * A wallet for the e2e specs only. `createWalletAdapters` offers it when
 * `NEXT_PUBLIC_E2E_TEST_WALLET=true` outside production builds.
 */
export class E2eTestWalletAdapter extends BaseSignerWalletAdapter<'E2E test wallet'> {
  name = E2E_TEST_WALLET_NAME
  url = 'https://localhost/e2e'
  icon = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4='
  readonly supportedTransactionVersions = new Set(['legacy', 0] as const)

  private key: PublicKey | null = null
  private pending = false

  get publicKey() {
    return this.key
  }

  get connecting() {
    return this.pending
  }

  get readyState(): ReadyState {
    return bridge().meridianE2eWalletPublicKey
      ? WalletReadyState.Installed
      : WalletReadyState.NotDetected
  }

  async connect(): Promise<void> {
    const getKey = bridge().meridianE2eWalletPublicKey
    if (!getKey) throw new WalletNotReadyError('The e2e wallet bridge is not installed')
    this.pending = true
    try {
      this.key = new PublicKey(await getKey())
      this.emit('connect', this.key)
    } finally {
      this.pending = false
    }
  }

  async disconnect(): Promise<void> {
    this.key = null
    this.emit('disconnect')
  }

  async signTransaction<
    T extends TransactionOrVersionedTransaction<this['supportedTransactionVersions']>,
  >(transaction: T): Promise<T> {
    const sign = bridge().meridianE2eWalletSign
    if (!this.key || !sign) throw new WalletNotConnectedError()
    if (transaction instanceof VersionedTransaction) {
      const signed = await sign(toBase64(transaction.serialize()))
      return VersionedTransaction.deserialize(fromBase64(signed)) as T
    }
    const legacy = transaction as Transaction
    const unsigned = legacy.serialize({ requireAllSignatures: false, verifySignatures: false })
    return Transaction.from(fromBase64(await sign(toBase64(unsigned)))) as T
  }
}
