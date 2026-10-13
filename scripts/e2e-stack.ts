import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js'
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
 *                                     SOL and mock USDC, and writes E2E_STACK_FILE
 */

const encoder = new TextEncoder()
/** The market stays open well past a full spec run. */
const CLOSE_LEAD_SECS = 60 * 60
const WALLET_SOL = 5
const WALLET_USDC = 1_000n * 1_000_000n
/** `UpgradeableLoaderState::ProgramData`: tag (4), slot (8), Option tag (1), authority (32). */
const AUTHORITY_OFFSET = 13

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

async function createStack(env: NodeJS.ProcessEnv, connection: Connection) {
  const stackFile = required(env, 'E2E_STACK_FILE')
  const client = createDemoClient(env)
  const closeTs = Math.ceil(Date.now() / 1000) + CLOSE_LEAD_SECS
  const created = await client.createDemoMarket({ ticker: DEMO_TICKER, closeTs })
  await client.confirm(created.signature, 'confirmed')

  const programId = new PublicKey(required(env, 'MERIDIAN_PROGRAM_ID'))
  const market = new PublicKey(created.market)
  const seed = (name: string) => pda(programId, encoder.encode(name), market.toBytes())
  // The vault is a USDC token account; a token account starts with its mint.
  const vault = seed('vault')
  const vaultInfo = await connection.getAccountInfo(vault)
  if (!vaultInfo) throw new Error(`Market ${market.toBase58()} has no vault`)
  const usdcMint = new PublicKey(vaultInfo.data.subarray(0, 32))

  const adminKey = loadKeypair(required(env, 'ADMIN_KEYPAIR'))
  const admin = Keypair.fromSecretKey(adminKey.secretKey)
  const maker = await fundWallet(connection, admin, usdcMint)
  const trader = await fundWallet(connection, admin, usdcMint)

  const accounts = {
    programId,
    config: pda(programId, encoder.encode('config')),
    market,
    usdcMint,
    yesMint: seed('yes'),
    noMint: seed('no'),
    vault,
    book: seed('book'),
    yesEscrow: seed('yes_escrow'),
    usdcEscrow: seed('usdc_escrow'),
  }
  const stack = {
    rpcUrl: connection.rpcEndpoint,
    ticker: DEMO_TICKER,
    market: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v.toBase58()])),
    maker: Array.from(maker.secretKey),
    trader: Array.from(trader.secretKey),
  }
  mkdirSync(dirname(stackFile), { recursive: true })
  writeFileSync(stackFile, JSON.stringify(stack, null, 2), { mode: 0o600 })
  console.log(`Demo market ${DEMO_TICKER} ${market.toBase58()}; stack file ${stackFile}`)
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
