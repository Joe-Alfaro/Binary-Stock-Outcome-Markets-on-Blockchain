import type { SignerWalletAdapter } from '@solana/wallet-adapter-base'
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare'

export interface WalletAdapterLike {
  name: string
}

/**
 * A wallet the app offers. The adapter is created on first use: a constructed adapter polls the
 * page until the extension shows up, which isn't wanted before the user picks a wallet.
 */
export interface WalletAdapterEntry extends WalletAdapterLike {
  create(): SignerWalletAdapter
}

/** The wallet adapters offered in the connect dialog (Phantom and Solflare at least, R48). */
export function createWalletAdapters(): WalletAdapterEntry[] {
  return [
    { name: 'Phantom', create: () => new PhantomWalletAdapter() },
    {
      name: 'Solflare',
      create: () => new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet }),
    },
  ]
}
