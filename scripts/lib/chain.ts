/**
 * The real chain clients behind the deploy, bootstrap and demo scripts. The scripts' tested logic
 * talks to the `BootstrapClient` and `DemoClient` interfaces; this file wires those to the two
 * programs through Anchor, reading the IDLs `anchor build` writes to `target/idl/` at runtime.
 */
import anchor from '@anchor-lang/core'
import type { Idl, Program as AnchorProgram } from '@anchor-lang/core'
import { createMockSource, type NormalizedPrice } from '@meridian/price-providers'
import {
  buildBuyNoTransaction,
  buildBuyYesTransaction,
  buildSellNoTransaction,
  buildSellYesTransaction,
  type MarketAccounts,
  type TradeContext,
} from '@meridian/sdk'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { BootstrapClient, ConfigParams, OracleSlotParams } from '../bootstrap.js'
import { QUOTE_PRICES, type Commitment, type DemoClient, type WalletBalances } from '../demo.js'
import { resolveCluster, type ClusterTarget } from '../guard.js'
import { loadKeypair, loadRoleKeys, type LoadedKey } from './keys.js'

// The package is CommonJS and Node can't detect all of its named exports.
const { AnchorProvider, BN, Program, Wallet } = anchor

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const MINT_SIZE = 82
const TICKER_LEN = 8
const TICKER_COUNT = 7
/** USDC base units per pair (6 decimals). */
const UNIT = 1_000_000
/** A token account's amount: a u64 after its mint and owner. */
const TOKEN_AMOUNT_OFFSET = 64
const LOCALNET_AIRDROP_SOL = 10
const WALLET_SOL = 0.2
/** Each demo wallet gets this many pairs' worth of USDC per pair the counterparty mints. */
const USDC_PER_PAIR = 2

const encoder = new TextEncoder()

interface MethodBuilder {
  accountsPartial(accounts: Record<string, PublicKey | null>): MethodBuilder
  instruction(): Promise<TransactionInstruction>
}

interface DemoMarket {
  ticker: string
  tradingDay: number
  closeTs: number
  market: PublicKey
  yesMint: PublicKey
  noMint: PublicKey
  vault: PublicKey
  book: PublicKey
  yesEscrow: PublicKey
  usdcEscrow: PublicKey
}

function loadIdl(name: string): Idl {
  return JSON.parse(readFileSync(`target/idl/${name}.json`, 'utf8')) as Idl
}

function toKeypair(key: LoadedKey) {
  return Keypair.fromSecretKey(key.secretKey)
}

/** A ticker as the programs' `[u8; 8]`: ASCII, right-padded with zero bytes. */
function tickerBytes(ticker: string): number[] {
  const bytes = new Array<number>(TICKER_LEN).fill(0)
  encoder.encode(ticker).forEach((byte, index) => (bytes[index] = byte))
  return bytes
}

function u32Le(value: number) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function i64Le(value: bigint | number) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true)
  return bytes
}

export function pda(programId: PublicKey, seeds: Uint8Array[]) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

/** The `YYYYMMDD` trading day of a timestamp in New York. */
function tradingDayOf(unixSecs: number) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(
    new Date(unixSecs * 1000),
  )
  return Number(day.replaceAll('-', ''))
}

function oracleSlot(slot: OracleSlotParams) {
  return {
    kind: slot.kind === 'MeridianRelay' ? { meridianRelay: {} } : { disabled: {} },
    relaySigner: slot.kind === 'MeridianRelay' ? new PublicKey(slot.signer) : PublicKey.default,
    feedIds: Array.from({ length: TICKER_COUNT }, () => new Array<number>(32).fill(0)),
    verifierProgram: PublicKey.default,
    minVerificationLevel: 0,
  }
}

function priceInput(update: NormalizedPrice) {
  return {
    price: new BN(update.price.toString()),
    conf: new BN(update.conf.toString()),
    expo: update.expo,
    publishTime: new BN(update.publishTime),
    session: update.session === 'regular' ? { regular: {} } : { outsideRegular: {} },
    officialClose: update.officialClose,
  }
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey) {
  return pda(ASSOCIATED_TOKEN_PROGRAM_ID, [
    owner.toBytes(),
    TOKEN_PROGRAM_ID.toBytes(),
    mint.toBytes(),
  ])
}

export function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  })
}

/** SPL Token `InitializeMint2` with no freeze authority. */
function initializeMint2(mint: PublicKey, decimals: number, authority: PublicKey) {
  const data = Buffer.alloc(67)
  data.writeUInt8(20, 0)
  data.writeUInt8(decimals, 1)
  authority.toBuffer().copy(data, 2)
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  })
}

/** SPL Token `MintTo` (opcode 7) or `Transfer` (opcode 3): both take an amount after the opcode. */
export function tokenAmountInstruction(
  opcode: 3 | 7,
  from: PublicKey,
  to: PublicKey,
  authority: PublicKey,
  amount: bigint,
) {
  const data = Buffer.alloc(9)
  data.writeUInt8(opcode, 0)
  data.writeBigUInt64LE(amount, 1)
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: false, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  })
}

/** Connection, keys and programs shared by both clients. Keys and IDLs load on first use. */
function createChain(env: NodeJS.ProcessEnv) {
  const target: ClusterTarget = resolveCluster(env)
  const connection = new Connection(target.rpcUrl, 'confirmed')
  const pending = new Map<string, { blockhash: string; lastValidBlockHeight: number }>()

  let roles: { admin: Keypair; automation: Keypair; relaySigners: Keypair[] } | undefined
  const keys = () => {
    if (!roles) {
      const loaded = loadRoleKeys(env)
      roles = {
        admin: toKeypair(loaded.admin),
        automation: toKeypair(loaded.automation),
        relaySigners: loaded.relaySigners.map(toKeypair),
      }
    }
    return roles
  }

  /** The upgrade authority `anchor deploy` used: ANCHOR_WALLET or the Solana CLI default. */
  let deployerKey: Keypair | undefined
  const deployer = () =>
    (deployerKey ??= toKeypair(
      loadKeypair(env.ANCHOR_WALLET || `${homedir()}/.config/solana/id.json`),
    ))

  const programs = new Map<string, AnchorProgram>()
  const program = (name: 'meridian' | 'meridian_oracle') => {
    let loaded = programs.get(name)
    if (!loaded) {
      const provider = new AnchorProvider(connection, new Wallet(keys().admin), {
        commitment: 'confirmed',
      })
      loaded = new Program(loadIdl(name), provider)
      programs.set(name, loaded)
    }
    return loaded
  }

  const method = (
    name: 'meridian' | 'meridian_oracle',
    instruction: string,
    ...args: unknown[]
  ) => {
    const methods = program(name).methods as unknown as Record<
      string,
      (...a: unknown[]) => MethodBuilder
    >
    const build = methods[instruction]
    if (!build) throw new Error(`${name} has no ${instruction} instruction; rebuild the programs`)
    return build(...args)
  }

  /** `Program` camel-cases the IDL's instruction names. */
  const hasInstruction = (name: 'meridian' | 'meridian_oracle', instruction: string) =>
    program(name).idl.instructions.some((ix) => ix.name === instruction)

  const programData = (programId: PublicKey) =>
    pda(BPF_LOADER_UPGRADEABLE_ID, [programId.toBytes()])

  async function send(instructions: TransactionInstruction[], signers: Keypair[]) {
    const [feePayer] = signers
    if (!feePayer) throw new Error('A transaction needs a fee payer')
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = new Transaction({ feePayer: feePayer.publicKey, blockhash, lastValidBlockHeight })
    tx.add(...instructions).sign(...signers)
    const signature = await connection.sendRawTransaction(tx.serialize())
    pending.set(signature, { blockhash, lastValidBlockHeight })
    return signature
  }

  /** Signs and sends a transaction an SDK builder compiled. */
  async function sendVersioned(
    build: (blockhash: string) => VersionedTransaction,
    signer: Keypair,
  ) {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    const tx = build(blockhash)
    tx.sign([signer])
    const signature = await connection.sendRawTransaction(tx.serialize())
    pending.set(signature, { blockhash, lastValidBlockHeight })
    return signature
  }

  async function confirm(signature: string, commitment: Commitment) {
    const block = pending.get(signature)
    if (!block) throw new Error(`Unknown transaction ${signature}`)
    const result = await connection.confirmTransaction({ signature, ...block }, commitment)
    if (result.value.err) {
      throw new Error(`Transaction ${signature} failed: ${JSON.stringify(result.value.err)}`)
    }
  }

  async function sendAndConfirm(instructions: TransactionInstruction[], signers: Keypair[]) {
    const signature = await send(instructions, signers)
    await confirm(signature, 'confirmed')
    return signature
  }

  /** On localnet, airdrops SOL to every role key so nothing needs funding by hand. */
  let funded = false
  async function fundOnLocalnet() {
    if (funded || target.cluster !== 'localnet') return
    const { admin, automation, relaySigners } = keys()
    for (const key of [admin, automation, ...relaySigners]) {
      if ((await connection.getBalance(key.publicKey)) >= LAMPORTS_PER_SOL) continue
      const signature = await connection.requestAirdrop(
        key.publicKey,
        LOCALNET_AIRDROP_SOL * LAMPORTS_PER_SOL,
      )
      const latest = await connection.getLatestBlockhash('confirmed')
      await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
    }
    funded = true
  }

  async function configUsdcMint() {
    const meridian = program('meridian')
    const info = await connection.getAccountInfo(
      pda(meridian.programId, [encoder.encode('config')]),
    )
    if (!info) throw new Error('Config is not initialized; run the bootstrap first')
    const config = meridian.coder.accounts.decode('config', info.data) as { usdcMint: PublicKey }
    return config.usdcMint
  }

  return {
    target,
    connection,
    keys,
    deployer,
    program,
    method,
    hasInstruction,
    programData,
    send,
    sendVersioned,
    confirm,
    sendAndConfirm,
    fundOnLocalnet,
    configUsdcMint,
  }
}

/** The bootstrap client: mock mint, `initialize_config`, signer registry and relay signers. */
export function createBootstrapClient(env: NodeJS.ProcessEnv): BootstrapClient {
  const chain = createChain(env)

  return {
    getGenesisHash: () => chain.connection.getGenesisHash(),

    async createMockUsdcMint(decimals) {
      await chain.fundOnLocalnet()
      const { admin } = chain.keys()
      const mint = Keypair.generate()
      const lamports = await chain.connection.getMinimumBalanceForRentExemption(MINT_SIZE)
      const signature = await chain.sendAndConfirm(
        [
          SystemProgram.createAccount({
            fromPubkey: admin.publicKey,
            newAccountPubkey: mint.publicKey,
            space: MINT_SIZE,
            lamports,
            programId: TOKEN_PROGRAM_ID,
          }),
          // The admin is the mint authority, so the demo can fund its trader.
          initializeMint2(mint.publicKey, decimals, admin.publicKey),
        ],
        [admin, mint],
      )
      return { mint: mint.publicKey.toBase58(), signature }
    },

    async setDemoMode(enabled) {
      const { admin } = chain.keys()
      const ix = await chain
        .method('meridian', 'setDemoMode', enabled)
        .accountsPartial({ admin: admin.publicKey })
        .instruction()
      return chain.sendAndConfirm([ix], [admin])
    },

    async initializeConfig(params: ConfigParams) {
      await chain.fundOnLocalnet()
      const deployer = chain.deployer()
      const programId = chain.program('meridian').programId
      const ix = await chain
        .method('meridian', 'initializeConfig', {
          admin: new PublicKey(params.admin),
          automationAuthority: new PublicKey(params.automationAuthority),
          tickers: params.tickers.map(tickerBytes),
          oracleSlots: params.oracleSlots.map(oracleSlot),
          maxStalenessSecs: params.maxStalenessSecs,
          maxConfBps: params.maxConfBps,
          adminProposeDelaySecs: params.adminProposeDelaySecs,
          adminFinalizeDelaySecs: params.adminFinalizeDelaySecs,
        })
        .accountsPartial({
          authority: deployer.publicKey,
          usdcMint: new PublicKey(params.usdcMint),
          program: programId,
          programData: chain.programData(programId),
        })
        .instruction()
      return chain.sendAndConfirm([ix], [deployer])
    },

    async registerRelaySigner(signer) {
      const { admin } = chain.keys()
      const oracle = chain.program('meridian_oracle')
      const registry = pda(oracle.programId, [encoder.encode('signers')])
      if (!(await chain.connection.getAccountInfo(registry))) {
        const deployer = chain.deployer()
        const init = await chain
          .method('meridian_oracle', 'initializeRegistry', admin.publicKey)
          .accountsPartial({
            authority: deployer.publicKey,
            registry,
            program: oracle.programId,
            programData: chain.programData(oracle.programId),
          })
          .instruction()
        await chain.sendAndConfirm([init], [deployer])
      }
      const add = await chain
        .method('meridian_oracle', 'addSigner', new PublicKey(signer))
        .accountsPartial({ admin: admin.publicKey, registry })
        .instruction()
      return chain.sendAndConfirm([add], [admin])
    },
  }
}

/**
 * The demo client. The admin creates the market; a funded counterparty mints pairs and quotes
 * each trade path; a fresh trader takes each quote with the SDK builder the web app uses; relay
 * signer 1 publishes the replayed recorded close, and the automation key settles.
 */
export function createDemoClient(env: NodeJS.ProcessEnv): DemoClient {
  const chain = createChain(env)
  const source = createMockSource()
  const markets = new Map<string, DemoMarket>()
  const trader = Keypair.generate()
  const counterparty = Keypair.generate()
  let walletsFunded = false

  const marketInfo = (market: string) => {
    const info = markets.get(market)
    if (!info) throw new Error(`Unknown demo market ${market}`)
    return info
  }

  const walletAccounts = async (info: DemoMarket, owner: PublicKey) => {
    const usdcMint = await chain.configUsdcMint()
    return {
      usdcMint,
      userUsdc: associatedTokenAddress(owner, usdcMint),
      userYes: associatedTokenAddress(owner, info.yesMint),
      userNo: associatedTokenAddress(owner, info.noMint),
    }
  }

  /** SOL for fees, and token accounts and `usdcAmount` USDC, for both demo wallets. */
  async function fundWallets(info: DemoMarket, usdcAmount: bigint) {
    if (walletsFunded) return
    const { admin } = chain.keys()
    const usdcMint = await chain.configUsdcMint()
    const mintInfo = await chain.connection.getAccountInfo(usdcMint)
    // A mint's authority is a COption<Pubkey> at the start of its data.
    const adminIsMintAuthority =
      mintInfo !== null &&
      mintInfo.data.readUInt32LE(0) === 1 &&
      new PublicKey(mintInfo.data.subarray(4, 36)).equals(admin.publicKey)
    const fundUsdc = (owner: PublicKey) =>
      adminIsMintAuthority
        ? tokenAmountInstruction(
            7,
            usdcMint,
            associatedTokenAddress(owner, usdcMint),
            admin.publicKey,
            usdcAmount,
          )
        : tokenAmountInstruction(
            3,
            associatedTokenAddress(admin.publicKey, usdcMint),
            associatedTokenAddress(owner, usdcMint),
            admin.publicKey,
            usdcAmount,
          )
    const fund = (owner: PublicKey) => [
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: owner,
        lamports: WALLET_SOL * LAMPORTS_PER_SOL,
      }),
      createAtaIdempotent(admin.publicKey, owner, usdcMint),
      createAtaIdempotent(admin.publicKey, owner, info.yesMint),
      createAtaIdempotent(admin.publicKey, owner, info.noMint),
      fundUsdc(owner),
    ]
    await chain.sendAndConfirm(
      [...fund(trader.publicKey), ...fund(counterparty.publicKey)],
      [admin],
    )
    walletsFunded = true
  }

  /** A wallet's USDC, Yes and No in base units; a missing token account holds nothing. */
  async function walletBalances(info: DemoMarket, owner: PublicKey): Promise<WalletBalances> {
    const { userUsdc, userYes, userNo } = await walletAccounts(info, owner)
    const accounts = await chain.connection.getMultipleAccountsInfo([userUsdc, userYes, userNo])
    const [usdc, yes, no] = accounts.map((account) =>
      account ? account.data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET) : 0n,
    ) as [bigint, bigint, bigint]
    return { usdc, yes, no }
  }

  const marketAccounts = async (info: DemoMarket): Promise<MarketAccounts> => ({
    programId: chain.program('meridian').programId,
    config: pda(chain.program('meridian').programId, [encoder.encode('config')]),
    market: info.market,
    usdcMint: await chain.configUsdcMint(),
    yesMint: info.yesMint,
    noMint: info.noMint,
    vault: info.vault,
    book: info.book,
    yesEscrow: info.yesEscrow,
    usdcEscrow: info.usdcEscrow,
  })

  /** What the SDK builders need for the trader, read just before the trade, as the app does. */
  async function traderContext(info: DemoMarket) {
    const held = await walletBalances(info, trader.publicKey)
    const market = await marketAccounts(info)
    return (recentBlockhash: string): TradeContext => ({
      owner: trader.publicKey,
      market,
      // The trader never leaves an order resting, so its wallet is all it holds.
      holdings: { yes: Number(held.yes / BigInt(UNIT)), no: Number(held.no / BigInt(UNIT)) },
      walletYesBaseUnits: held.yes,
      recentBlockhash,
    })
  }

  const placeOrderIx = async (
    info: DemoMarket,
    owner: Keypair,
    side: 'bid' | 'ask',
    price: number,
    quantity: number,
  ) => {
    const { userUsdc, userYes } = await walletAccounts(info, owner.publicKey)
    return chain
      .method('meridian', 'placeOrder', { [side]: {} }, { limit: {} }, price, new BN(quantity))
      .accountsPartial({
        owner: owner.publicKey,
        market: info.market,
        book: info.book,
        userUsdc,
        userYes,
      })
      .instruction()
  }

  const recordedClose = async (ticker: string, closeTs: number) => {
    const inputs = await source.prepareClose(ticker, closeTs)
    if (!inputs || inputs.updates.length === 0) {
      throw new Error(`The mock source has no recorded close for ${ticker}`)
    }
    return inputs.updates
  }

  return {
    getGenesisHash: () => chain.connection.getGenesisHash(),
    confirm: (signature, commitment) => chain.confirm(signature, commitment),

    async createDemoMarket({ ticker, closeTs }) {
      await chain.fundOnLocalnet()
      const { admin } = chain.keys()
      const meridian = chain.program('meridian')
      if (chain.hasInstruction('meridian', 'setDemoMode')) {
        const demoMode = await chain
          .method('meridian', 'setDemoMode', true)
          .accountsPartial({ admin: admin.publicKey })
          .instruction()
        await chain.sendAndConfirm([demoMode], [admin])
      }

      // Strike one dollar over the recorded close, so the replayed close settles No and the No
      // the trader keeps pays out.
      const [first] = await recordedClose(ticker, closeTs)
      const expo = first?.expo ?? 0
      const strike = (first?.price ?? 0n) + 10n ** BigInt(-expo)
      const tradingDay = tradingDayOf(closeTs)
      const market = pda(meridian.programId, [
        encoder.encode('market'),
        Uint8Array.from(tickerBytes(ticker)),
        u32Le(tradingDay),
        i64Le(strike),
      ])
      const opensAt = Math.floor(Date.now() / 1000) - 60
      const ix = await chain
        .method('meridian', 'createStrikeMarket', {
          ticker: tickerBytes(ticker),
          tradingDay,
          strike: new BN(strike.toString()),
          strikeExpo: expo,
          closeTs: new BN(closeTs),
          mintOpenTs: new BN(opensAt),
          tradingOpenTs: new BN(opensAt),
        })
        .accountsPartial({
          authority: admin.publicKey,
          market,
          usdcMint: await chain.configUsdcMint(),
        })
        .instruction()
      const signature = await chain.send([ix], [admin])
      markets.set(market.toBase58(), {
        ticker,
        tradingDay,
        closeTs,
        market,
        yesMint: pda(meridian.programId, [encoder.encode('yes'), market.toBytes()]),
        noMint: pda(meridian.programId, [encoder.encode('no'), market.toBytes()]),
        vault: pda(meridian.programId, [encoder.encode('vault'), market.toBytes()]),
        book: pda(meridian.programId, [encoder.encode('book'), market.toBytes()]),
        yesEscrow: pda(meridian.programId, [encoder.encode('yes_escrow'), market.toBytes()]),
        usdcEscrow: pda(meridian.programId, [encoder.encode('usdc_escrow'), market.toBytes()]),
      })
      return { market: market.toBase58(), signature }
    },

    async mintPair(market, quantity) {
      const info = marketInfo(market)
      await fundWallets(info, BigInt(quantity * USDC_PER_PAIR * UNIT))
      const { userUsdc, userYes, userNo } = await walletAccounts(info, counterparty.publicKey)
      const ix = await chain
        .method('meridian', 'mintPair', new BN(quantity))
        .accountsPartial({
          user: counterparty.publicKey,
          market: info.market,
          yesMint: info.yesMint,
          noMint: info.noMint,
          vault: info.vault,
          userUsdc,
          userYes,
          userNo,
        })
        .instruction()
      return chain.send([ix], [counterparty])
    },

    async quote(market, path, quantity) {
      const info = marketInfo(market)
      // The counterparty sells Yes to Buy Yes and Sell No, and buys Yes from Sell Yes and Buy No.
      const side = path === 'buy-yes' || path === 'sell-no' ? 'ask' : 'bid'
      const ix = await placeOrderIx(info, counterparty, side, QUOTE_PRICES[path], quantity)
      return chain.send([ix], [counterparty])
    },

    async trade(market, path, quantity) {
      const info = marketInfo(market)
      const context = await traderContext(info)
      const price = QUOTE_PRICES[path]
      // Each order crosses the counterparty's quote at its price, so it fills in full.
      const build = {
        'buy-yes': (blockhash: string) =>
          buildBuyYesTransaction(context(blockhash), {
            kind: 'Limit',
            priceCents: price,
            qty: quantity,
          }),
        'sell-yes': (blockhash: string) =>
          buildSellYesTransaction(context(blockhash), {
            kind: 'Limit',
            priceCents: price,
            qty: quantity,
          }),
        'buy-no': (blockhash: string) =>
          buildBuyNoTransaction(context(blockhash), {
            kind: 'Limit',
            noPriceCents: 100 - price,
            qty: quantity,
          }),
        'sell-no': (blockhash: string) =>
          buildSellNoTransaction(context(blockhash), { noPriceCents: 100 - price, qty: quantity }),
      }[path]
      return chain.sendVersioned(build, trader)
    },

    async balances(market) {
      const info = marketInfo(market)
      return {
        trader: await walletBalances(info, trader.publicKey),
        counterparty: await walletBalances(info, counterparty.publicKey),
      }
    },

    async publishRelayClose(market) {
      const info = marketInfo(market)
      const [relay] = chain.keys().relaySigners
      if (!relay) throw new Error('RELAY_SIGNER_1_KEYPAIR is not set')
      const oracle = chain.program('meridian_oracle')
      const updates = await recordedClose(info.ticker, info.closeTs)
      console.log(
        `Relay: replayed recorded close for ${info.ticker}, re-stamped to close_ts ${info.closeTs}`,
      )

      // The program rejects prices published in the future.
      const latest = Math.max(...updates.map((update) => update.publishTime))
      const waitMs = (latest + 2) * 1000 - Date.now()
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs))

      const signer = relay.publicKey.toBytes()
      const ticker = Uint8Array.from(tickerBytes(info.ticker))
      const priceUpdate = (update: NormalizedPrice) =>
        pda(oracle.programId, [encoder.encode('price'), signer, ticker, i64Le(update.publishTime)])
      for (const update of updates) {
        const ix = await chain
          .method('meridian_oracle', 'publishPrice', tickerBytes(info.ticker), priceInput(update))
          .accountsPartial({ signer: relay.publicKey, priceUpdate: priceUpdate(update) })
          .instruction()
        await chain.sendAndConfirm([ix], [relay])
      }
      const [first, second] = updates as [NormalizedPrice, NormalizedPrice | undefined]
      const close = await chain
        .method(
          'meridian_oracle',
          'publishClose',
          tickerBytes(info.ticker),
          info.tradingDay,
          new BN(info.closeTs),
        )
        .accountsPartial({
          signer: relay.publicKey,
          closeRecord: pda(oracle.programId, [
            encoder.encode('close'),
            signer,
            ticker,
            u32Le(info.tradingDay),
          ]),
          firstUpdate: priceUpdate(first),
          secondUpdate: second ? priceUpdate(second) : null,
        })
        .instruction()
      return chain.send([close], [relay])
    },

    async settle(market) {
      const info = marketInfo(market)
      const { automation, relaySigners } = chain.keys()
      const relay = relaySigners[0] as Keypair
      const meridian = chain.program('meridian')
      const oracle = chain.program('meridian_oracle')
      const ticker = Uint8Array.from(tickerBytes(info.ticker))
      const ix = await chain
        .method('meridian', 'settleMarket', 0)
        .accountsPartial({
          caller: automation.publicKey,
          market: info.market,
          tickerDay: pda(meridian.programId, [
            encoder.encode('day'),
            ticker,
            u32Le(info.tradingDay),
          ]),
          closeRecord: pda(oracle.programId, [
            encoder.encode('close'),
            relay.publicKey.toBytes(),
            ticker,
            u32Le(info.tradingDay),
          ]),
        })
        .instruction()
      return chain.send([ix], [automation])
    },

    async redeem(market) {
      const info = marketInfo(market)
      const { userUsdc, userYes, userNo } = await walletAccounts(info, trader.publicKey)
      const balance = async (account: PublicKey) =>
        new BN((await chain.connection.getTokenAccountBalance(account)).value.amount)
      const ix = await chain
        .method('meridian', 'redeem', await balance(userYes), await balance(userNo))
        .accountsPartial({
          user: trader.publicKey,
          market: info.market,
          yesMint: info.yesMint,
          noMint: info.noMint,
          vault: info.vault,
          userUsdc,
          userYes,
          userNo,
        })
        .instruction()
      return chain.send([ix], [trader])
    },

    async chainNow() {
      throw new Error('not implemented')
    },
  }
}
