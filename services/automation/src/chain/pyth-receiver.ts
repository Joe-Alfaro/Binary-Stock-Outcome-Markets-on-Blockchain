import anchor from '@anchor-lang/core'
import { PublicKey } from '@solana/web3.js'
import type { Connection, Keypair } from '@solana/web3.js'
import type { PythUpdateAccounts } from './types.js'

const { Wallet } = anchor

/** Lands the post transactions ahead of the settle that reads them. */
const POST_PRIORITY_MICRO_LAMPORTS = 50_000

export interface PythReceiverPosterOptions {
  connection: Connection
  /** Signs and pays for the posts; the update accounts are its own. */
  authority: Keypair
  /** The receiver program, from `PYTH_RECEIVER_PROGRAM_ID`. */
  receiverProgram: string
}

/**
 * Posts each Hermes close update through the Pyth receiver program, fully verified against
 * Wormhole, and hands back the new `PriceUpdateV2` account. Pyth doesn't keep equity accounts
 * fresh on Solana, so the worker posts its own (ARCHITECTURE §5.7). The accounts stay open, since
 * `settle_market` runs in a later transaction; their rent is not reclaimed.
 */
export function createPythReceiverPoster(options: PythReceiverPosterOptions): PythUpdateAccounts {
  return {
    async accountsFor(update) {
      // Loaded only when a slot is Pyth, so a relay worker never pays for the receiver client.
      const { PythSolanaReceiver } = await import('@pythnetwork/pyth-solana-receiver')
      const receiver = new PythSolanaReceiver({
        connection: options.connection,
        wallet: new Wallet(options.authority),
        receiverProgramId: new PublicKey(options.receiverProgram),
      })
      const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false })
      await builder.addPostPriceUpdates(
        update.binary.map((bytes) => Buffer.from(bytes).toString('base64')),
      )
      const account = builder.getPriceUpdateAccount(`0x${update.feedId}`)
      await receiver.provider.sendAll(
        await builder.buildVersionedTransactions({
          computeUnitPriceMicroLamports: POST_PRIORITY_MICRO_LAMPORTS,
        }),
        { commitment: 'confirmed' },
      )
      return [account]
    },
  }
}
