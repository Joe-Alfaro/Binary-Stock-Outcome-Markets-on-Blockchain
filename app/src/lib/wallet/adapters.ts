import type { SignerWalletAdapter } from '@solana/wallet-adapter-base'
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base'
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom'
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare'
import { E2E_TEST_WALLET_NAME, E2eTestWalletAdapter } from './e2e-test-wallet'

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

/**
 * True only for `make e2e`. Next.js inlines both variables, so a production build drops the
 * test wallet even when the flag is set.
 */
function e2eTestWalletEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_E2E_TEST_WALLET === 'true'
}

/** The wallet adapters offered in the connect dialog (Phantom and Solflare at least, R48). */
export function createWalletAdapters(): WalletAdapterEntry[] {
  const entries: WalletAdapterEntry[] = [
    { name: 'Phantom', create: () => new PhantomWalletAdapter() },
    {
      name: 'Solflare',
      create: () => new SolflareWalletAdapter({ network: WalletAdapterNetwork.Devnet }),
    },
  ]
  if (e2eTestWalletEnabled()) {
    entries.push({ name: E2E_TEST_WALLET_NAME, create: () => new E2eTestWalletAdapter() })
  }
  return entries
}
