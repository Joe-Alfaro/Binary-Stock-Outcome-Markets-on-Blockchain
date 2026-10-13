import type { ClusterTarget } from '../guard.js'

/** Solana Explorer link for a transaction on the given cluster. */
export function explorerTxUrl(signature: string, target: ClusterTarget): string {
  const base = `https://explorer.solana.com/tx/${signature}`
  if (target.cluster === 'localnet') {
    return `${base}?cluster=custom&customUrl=${encodeURIComponent(target.rpcUrl)}`
  }
  return `${base}?cluster=${target.cluster}`
}
