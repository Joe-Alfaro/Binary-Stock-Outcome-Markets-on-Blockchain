const MAINNET_PATTERN = /mainnet/i

/** True when a cluster name or RPC URL points at mainnet-beta. */
export function isMainnet(clusterOrUrl: string) {
  return MAINNET_PATTERN.test(clusterOrUrl)
}

/** Throws when a cluster name or RPC URL points at mainnet-beta. Scripts call this first. */
export function assertNotMainnet(clusterOrUrl: string) {
  if (isMainnet(clusterOrUrl)) {
    throw new Error(`Refusing to run against mainnet: ${clusterOrUrl}`)
  }
}
