'use client'

import { WalletButton } from './WalletButton'

/** Shown on wallet-only pages until a wallet is connected. */
export function ConnectPrompt({ what }: { what: string }) {
  return (
    <div className="card connect-prompt">
      <p>Connect your wallet to see {what}.</p>
      <WalletButton />
    </div>
  )
}
