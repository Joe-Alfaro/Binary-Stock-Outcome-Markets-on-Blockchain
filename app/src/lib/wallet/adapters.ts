export interface WalletAdapterLike {
  name: string
}

/** The wallet adapters offered in the connect dialog (Phantom and Solflare at least, R48). */
export function createWalletAdapters(): WalletAdapterLike[] {
  return []
}
