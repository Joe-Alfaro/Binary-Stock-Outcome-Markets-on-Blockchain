import type { Idl } from '@anchor-lang/core'
import type { Connection, Keypair } from '@solana/web3.js'
import type { ChainClient } from './types.js'

export interface AnchorChainClientOptions {
  connection: Connection
  /**
   * The automation authority: signs and pays for `create_strike_market`, `settle_market` and
   * `finalize_admin_settle`.
   */
  authority: Keypair
  /** The `meridian` IDL; its `address` is the program ID. */
  idl: Idl
}

/**
 * `ChainClient` backed by the deployed `meridian` program. Oracle slot kinds and relay signers
 * come from the on-chain `Config`.
 */
export function createAnchorChainClient(options: AnchorChainClientOptions): ChainClient {
  void options
  // Stub for the lifecycle integration tests; the implementation worker replaces it.
  throw new Error('createAnchorChainClient is not implemented')
}
