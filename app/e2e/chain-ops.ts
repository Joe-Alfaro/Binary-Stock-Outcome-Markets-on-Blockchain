import { buildBuyNoTransaction, buildBuyYesTransaction } from '@meridian/sdk'
import type { MarketAccounts } from '@meridian/sdk'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'
import type { VersionedTransaction } from '@solana/web3.js'
import { decodeOrderBook } from '../src/lib/chain/layout'
import { loadStack } from './stack'
import type { StackMarket } from './stack'

/**
 * The maker's SDK trades, run with `tsx` in a child process: Playwright's loader can't load
 * `@solana/web3.js` (its `rpc-websockets` requires the ESM-only `uuid`). Prints the signature
 * once the transaction is confirmed.
 *
 *   tsx e2e/chain-ops.ts bid-yes <priceCents> <qty>   rests a Yes bid
 *   tsx e2e/chain-ops.ts ask-yes <priceCents> <qty>   mints pairs and rests their Yes as an ask
 *   tsx e2e/chain-ops.ts trader-settled               prints the trader's USDC, Yes, No and
 *                                                      resting order count in the settled market
 */
function marketAccounts(market: StackMarket): MarketAccounts {
  const entries = Object.entries(market).map(([name, value]) => [name, new PublicKey(value)])
  return Object.fromEntries(entries) as MarketAccounts
}

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')

async function tokenBalance(connection: Connection, owner: PublicKey, mint: PublicKey) {
  const [account] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )
  if (!(await connection.getAccountInfo(account))) return 0
  return Number((await connection.getTokenAccountBalance(account)).value.amount)
}

async function traderSettled(connection: Connection, owner: PublicKey, market: MarketAccounts) {
  const bookInfo = await connection.getAccountInfo(market.book)
  if (!bookInfo) throw new Error('The settled market has no book')
  const book = decodeOrderBook(Uint8Array.from(bookInfo.data))
  const seat = book.seats.findIndex((s) => s.owner.equals(owner))
  const own = [...book.bids, ...book.asks].filter((o) => seat >= 0 && o.seat === seat)
  return {
    usdc: await tokenBalance(connection, owner, market.usdcMint),
    yes: await tokenBalance(connection, owner, market.yesMint),
    no: await tokenBalance(connection, owner, market.noMint),
    restingOrders: own.length,
  }
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
  if (op === 'trader-settled') {
    const trader = Keypair.fromSecretKey(Uint8Array.from(stack.trader))
    const state = await traderSettled(
      connection,
      trader.publicKey,
      marketAccounts(stack.settled.market),
    )
    console.log(JSON.stringify(state))
    return
  }
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const ctx = {
    owner: maker.publicKey,
    market: marketAccounts(stack.market),
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
