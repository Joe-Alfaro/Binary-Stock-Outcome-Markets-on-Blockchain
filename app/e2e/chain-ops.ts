import { buildBuyNoTransaction, buildBuyYesTransaction } from '@meridian/sdk'
import type { MarketAccounts } from '@meridian/sdk'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import type { VersionedTransaction } from '@solana/web3.js'
import { loadStack } from './stack'
import type { E2eStack } from './stack'

/**
 * The maker's SDK trades, run with `tsx` in a child process: Playwright's loader can't load
 * `@solana/web3.js` (its `rpc-websockets` requires the ESM-only `uuid`). Prints the signature
 * once the transaction is confirmed.
 *
 *   tsx e2e/chain-ops.ts bid-yes <priceCents> <qty>   rests a Yes bid
 *   tsx e2e/chain-ops.ts ask-yes <priceCents> <qty>   mints pairs and rests their Yes as an ask
 */
function marketAccounts(stack: E2eStack): MarketAccounts {
  const entries = Object.entries(stack.market).map(([name, value]) => [name, new PublicKey(value)])
  return Object.fromEntries(entries) as MarketAccounts
}

async function sendSigned(connection: Connection, tx: VersionedTransaction, signer: Keypair) {
  tx.sign([signer])
  const signature = await connection.sendTransaction(tx)
  const latest = await connection.getLatestBlockhash('confirmed')
  const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
  if (result.value.err) throw new Error(`${signature} failed: ${JSON.stringify(result.value.err)}`)
  return signature
}

async function main() {
  const [op, price, quantity] = process.argv.slice(2)
  const priceCents = Number(price)
  const qty = Number(quantity)
  const stack = loadStack()
  const connection = new Connection(stack.rpcUrl, 'confirmed')
  const maker = Keypair.fromSecretKey(Uint8Array.from(stack.maker))
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const ctx = {
    owner: maker.publicKey,
    market: marketAccounts(stack),
    holdings: { yes: 0, no: 0 },
    walletYesBaseUnits: 0n,
    recentBlockhash: blockhash,
  }
  if (op === 'bid-yes') {
    const tx = buildBuyYesTransaction(ctx, { kind: 'Limit', priceCents, qty })
    console.log(await sendSigned(connection, tx, maker))
    return
  }
  if (op === 'ask-yes') {
    const tx = buildBuyNoTransaction(ctx, { kind: 'Limit', noPriceCents: 100 - priceCents, qty })
    console.log(await sendSigned(connection, tx, maker))
    return
  }
  throw new Error(`Unknown operation ${op}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
