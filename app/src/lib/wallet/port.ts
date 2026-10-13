import type { SignerWalletAdapter } from '@solana/wallet-adapter-base'
import { Transaction, VersionedTransaction } from '@solana/web3.js'
import type { SignedTx, Unsubscribe, UnsignedTx, WalletOption, WalletPort } from '../chain'
import { ChainError } from '../chain'
import type { WalletAdapterEntry } from './adapters'

const STORAGE_KEY = 'meridian.wallet'

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

/** `WalletPort` over the Solana wallet adapters. Remembers the last wallet for reconnecting. */
export class AdapterWalletPort implements WalletPort {
  readonly wallets: readonly WalletOption[]
  private readonly entries: readonly WalletAdapterEntry[]
  private readonly created = new Map<string, SignerWalletAdapter>()
  private active: SignerWalletAdapter | null = null
  private listeners = new Set<() => void>()

  constructor(entries: readonly WalletAdapterEntry[]) {
    this.entries = entries
    this.wallets = entries.map((entry) => ({ name: entry.name }))
  }

  private notify = () => this.listeners.forEach((listener) => listener())

  private adapter(name: string): SignerWalletAdapter | null {
    const existing = this.created.get(name)
    if (existing) return existing
    const entry = this.entries.find((e) => e.name === name)
    if (!entry) return null
    const adapter = entry.create()
    adapter.on('connect', this.notify)
    adapter.on('disconnect', this.notify)
    this.created.set(name, adapter)
    return adapter
  }

  getPublicKey(): string | null {
    return this.active?.publicKey?.toBase58() ?? null
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(walletName: string): Promise<void> {
    const adapter = this.adapter(walletName)
    if (!adapter) throw new ChainError('Unknown', `Unknown wallet: ${walletName}`)
    if (this.active && this.active !== adapter) await this.active.disconnect()
    this.active = adapter
    await adapter.connect()
    storage()?.setItem(STORAGE_KEY, walletName)
    this.notify()
  }

  /** Reconnects the wallet used last time, without a prompt when the wallet already trusts us. */
  async reconnect(): Promise<void> {
    const name = storage()?.getItem(STORAGE_KEY)
    const adapter = name ? this.adapter(name) : null
    if (!adapter) return
    this.active = adapter
    await adapter.autoConnect().catch(() => {
      this.active = null
    })
    this.notify()
  }

  async disconnect(): Promise<void> {
    const adapter = this.active
    this.active = null
    storage()?.removeItem(STORAGE_KEY)
    await adapter?.disconnect()
    this.notify()
  }

  async signTransaction(tx: UnsignedTx): Promise<SignedTx> {
    if (!this.active?.connected) throw new ChainError('Unknown', 'Connect a wallet first.')
    const raw = tx.raw
    if (raw instanceof VersionedTransaction || raw instanceof Transaction) {
      return { raw: await this.active.signTransaction(raw) }
    }
    throw new ChainError('Unknown', 'Unsupported transaction type.')
  }
}
