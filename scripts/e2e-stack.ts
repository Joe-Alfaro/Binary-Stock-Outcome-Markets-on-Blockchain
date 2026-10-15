import { buildBuyNoTransaction, buildBuyYesTransaction } from '@meridian/sdk'
import type { MarketAccounts, TradeContext } from '@meridian/sdk'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
import type { VersionedTransaction } from '@solana/web3.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEMO_TICKER } from './demo.js'
import { assertSafeTarget } from './guard.js'
import { isEntryPoint, runMain } from './lib/cli.js'
import {
  associatedTokenAddress,
  createAtaIdempotent,
  createDemoClient,
  tokenAmountInstruction,
} from './lib/chain.js'
import { loadKeypair } from './lib/keys.js'

/**
 * The chain-side steps of `make e2e` (scripts/e2e.ts), run on its private validator:
 *
 *   tsx scripts/e2e-stack.ts deploy   checks both programs are live with the admin as upgrade
 *                                     authority (the validator loads them at genesis)
 *   tsx scripts/e2e-stack.ts market   creates the demo market, funds a maker and a trader with
 *                                     SOL and mock USDC, prepares the settled market below and
 *                                     writes E2E_STACK_FILE
 *
 * The settled market (R52) is a second demo market, on another ticker, that closes and settles
 * during this step. The demo strike sits a dollar over the replayed close, so it settles No. The
 * trader holds 7 winning No (4 bought at 30¢ against the maker's 70¢ Yes bid, 3 from a resting
 * Buy No limit) and still rests that limit's 3 Yes as an ask at 60¢.
 */

const encoder = new TextEncoder()
/** The market stays open well past a full spec run. */
const CLOSE_LEAD_SECS = 60 * 60
const WALLET_SOL = 5
const WALLET_USDC = 1_000n * 1_000_000n
/** `UpgradeableLoaderState::ProgramData`: tag (4), slot (8), Option tag (1), authority (32). */
const AUTHORITY_OFFSET = 13
/** The settled market closes this soon after creation: time for its three trades. */
const SETTLED_CLOSE_LEAD_SECS = 30
const SETTLED_TICKER = 'MSFT'

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]
  if (!value) throw new Error(`${name} is not set; run this through \`make e2e\``)
  return value
}

function pda(programId: PublicKey, ...seeds: Uint8Array[]) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

async function confirmed(connection: Connection, signature: string) {
  const latest = await connection.getLatestBlockhash('confirmed')
  const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
  if (result.value.err) throw new Error(`${signature} failed: ${JSON.stringify(result.value.err)}`)
}

async function checkDeployed(env: NodeJS.ProcessEnv, connection: Connection) {
  const admin = new PublicKey(loadKeypair(required(env, 'ADMIN_KEYPAIR')).publicKey)
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
  for (const name of ['MERIDIAN_PROGRAM_ID', 'MERIDIAN_ORACLE_PROGRAM_ID']) {
    const programId = new PublicKey(required(env, name))
    const program = await connection.getAccountInfo(programId)
    if (!program?.executable) throw new Error(`${name} ${programId.toBase58()} is not deployed`)
    const data = await connection.getAccountInfo(pda(loader, programId.toBytes()))
    const authority = data && new PublicKey(data.data.subarray(AUTHORITY_OFFSET, 45))
    if (!authority?.equals(admin)) {
      throw new Error(`${name} ${programId.toBase58()} is not upgradeable by the e2e admin`)
    }
    console.log(`${name} ${programId.toBase58()} deployed, upgrade authority ${admin.toBase58()}`)
  }
}

/** SOL from the faucet, then a USDC account holding `WALLET_USDC` minted by the admin. */
async function fundWallet(connection: Connection, admin: Keypair, usdcMint: PublicKey) {
  const wallet = Keypair.generate()
  await confirmed(
    connection,
    await connection.requestAirdrop(wallet.publicKey, WALLET_SOL * LAMPORTS_PER_SOL),
  )
  const userUsdc = associatedTokenAddress(wallet.publicKey, usdcMint)
  const tx = new Transaction().add(
    createAtaIdempotent(admin.publicKey, wallet.publicKey, usdcMint),
    tokenAmountInstruction(7, usdcMint, userUsdc, admin.publicKey, WALLET_USDC),
  )
  tx.feePayer = admin.publicKey
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash
  tx.sign(admin)
  await confirmed(connection, await connection.sendRawTransaction(tx.serialize()))
  return wallet
}

/** Every account of one demo market, from its PDAs and its vault's mint. */
async function marketAccounts(
  connection: Connection,
  programId: PublicKey,
  market: PublicKey,
): Promise<MarketAccounts> {
  const seed = (name: string) => pda(programId, encoder.encode(name), market.toBytes())
  // The vault is a USDC token account; a token account starts with its mint.
  const vault = seed('vault')
  const vaultInfo = await connection.getAccountInfo(vault)
  if (!vaultInfo) throw new Error(`Market ${market.toBase58()} has no vault`)
  return {
    programId,
    config: pda(programId, encoder.encode('config')),
    market,
    usdcMint: new PublicKey(vaultInfo.data.subarray(0, 32)),
    yesMint: seed('yes'),
    noMint: seed('no'),
    vault,
    book: seed('book'),
    yesEscrow: seed('yes_escrow'),
    usdcEscrow: seed('usdc_escrow'),
  }
}

function toBase58(accounts: MarketAccounts) {
  return Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v.toBase58()]))
}

/** Signs an SDK-built transaction with its one wallet, sends it and waits for confirmation. */
async function sendSdk(
  connection: Connection,
  build: (blockhash: string) => VersionedTransaction,
  signer: Keypair,
) {
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  const tx = build(blockhash)
  tx.sign([signer])
  await confirmed(connection, await connection.sendRawTransaction(tx.serialize()))
}

/** The settled market described at the top: closes, settles No, and returns its accounts. */
async function createSettledMarket(
  connection: Connection,
  client: ReturnType<typeof createDemoClient>,
  programId: PublicKey,
  wallets: { maker: Keypair; trader: Keypair },
) {
  const closeTs = Math.ceil(Date.now() / 1000) + SETTLED_CLOSE_LEAD_SECS
  const created = await client.createDemoMarket({ ticker: SETTLED_TICKER, closeTs })
  await client.confirm(created.signature, 'confirmed')
  const accounts = await marketAccounts(connection, programId, new PublicKey(created.market))
  const context =
    (owner: Keypair, no: number) =>
    (recentBlockhash: string): TradeContext => ({
      owner: owner.publicKey,
      market: accounts,
      holdings: { yes: 0, no },
      walletYesBaseUnits: 0n,
      recentBlockhash,
    })
  const { maker, trader } = wallets
  await sendSdk(
    connection,
    (b) => buildBuyYesTransaction(context(maker, 0)(b), { kind: 'Limit', priceCents: 70, qty: 4 }),
    maker,
  )
  await sendSdk(
    connection,
    (b) =>
      buildBuyNoTransaction(context(trader, 0)(b), { kind: 'Market', noPriceCents: 30, qty: 4 }),
    trader,
  )
  await sendSdk(
    connection,
    (b) =>
      buildBuyNoTransaction(context(trader, 4)(b), { kind: 'Limit', noPriceCents: 40, qty: 3 }),
    trader,
  )

  const waitMs = (closeTs + 1) * 1000 - Date.now()
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))
  await client.confirm(await client.publishRelayClose(created.market), 'confirmed')
  await client.confirm(await client.settle(created.market), 'confirmed')
  console.log(`Settled market ${SETTLED_TICKER} ${created.market}`)
  return { ticker: SETTLED_TICKER, market: toBase58(accounts) }
}

async function createStack(env: NodeJS.ProcessEnv, connection: Connection) {
  const stackFile = required(env, 'E2E_STACK_FILE')
  const client = createDemoClient(env)
  const closeTs = Math.ceil(Date.now() / 1000) + CLOSE_LEAD_SECS
  const created = await client.createDemoMarket({ ticker: DEMO_TICKER, closeTs })
  await client.confirm(created.signature, 'confirmed')

  const programId = new PublicKey(required(env, 'MERIDIAN_PROGRAM_ID'))
  const accounts = await marketAccounts(connection, programId, new PublicKey(created.market))

  const adminKey = loadKeypair(required(env, 'ADMIN_KEYPAIR'))
  const admin = Keypair.fromSecretKey(adminKey.secretKey)
  const maker = await fundWallet(connection, admin, accounts.usdcMint)
  const trader = await fundWallet(connection, admin, accounts.usdcMint)
  const settled = await createSettledMarket(connection, client, programId, { maker, trader })

  const stack = {
    rpcUrl: connection.rpcEndpoint,
    ticker: DEMO_TICKER,
    market: toBase58(accounts),
    settled,
    maker: Array.from(maker.secretKey),
    trader: Array.from(trader.secretKey),
    admin: Array.from(admin.secretKey),
  }
  mkdirSync(dirname(stackFile), { recursive: true })
  writeFileSync(stackFile, JSON.stringify(stack, null, 2), { mode: 0o600 })
  console.log(`Demo market ${DEMO_TICKER} ${created.market}; stack file ${stackFile}`)
}

async function main() {
  const [command] = process.argv.slice(2)
  const env = process.env
  const connection = new Connection(required(env, 'SOLANA_RPC_URL'), 'confirmed')
  const target = await assertSafeTarget(env, connection)
  if (target.cluster !== 'localnet') throw new Error('The e2e stack runs on localnet only')
  if (command === 'deploy') return checkDeployed(env, connection)
  if (command === 'market') return createStack(env, connection)
  throw new Error(`Usage: tsx scripts/e2e-stack.ts deploy|market (got ${command})`)
}

if (isEntryPoint(import.meta.url)) runMain(main)
