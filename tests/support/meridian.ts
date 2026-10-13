/**
 * Shared harness for the lifecycle integration tests: one bootstrap per validator (mock USDC,
 * config, signer registry, relay signer), market PDAs, funded fresh wallets, the SDK's trade
 * builders sent as-is, and the R6 / R31 invariant checks.
 */
import * as anchor from '@anchor-lang/core'
import anchorPackage from '@anchor-lang/core'
import type { Program } from '@anchor-lang/core'
import { createMockSource } from '@meridian/price-providers'
import type { MarketAccounts, RestingOrder, TradeContext } from '@meridian/sdk'
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'
import { expect } from 'chai'
import { createAnchorOracleClient } from '../../services/automation/src/relay/oracle-client.js'
import { createRelayPublisher } from '../../services/automation/src/relay/index.js'
import type { CloseOutcome } from '../../services/automation/src/relay/index.js'
import type { Meridian } from '../../target/types/meridian.js'
import type { MeridianOracle } from '../../target/types/meridian_oracle.js'

// The package is CommonJS, so `BN` only comes through the default import.
const { BN } = anchorPackage

export { BN }

export const UNIT = 1_000_000n
/** Solana's packet limit for one serialized transaction (R27). */
export const MAX_TX_BYTES = 1232
/** Strikes and admin prices in these tests are whole cents. */
export const STRIKE_EXPO = -2
export const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'] as const
/** Production delays (R36); the admin fallback test shortens them and restores these. */
export const ADMIN_PROPOSE_DELAY_SECS = 900
export const ADMIN_FINALIZE_DELAY_SECS = 3600

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const MINT_SIZE = 82
const encoder = new TextEncoder()

const envProvider = anchor.AnchorProvider.env()
// Every read below is at `confirmed`, so sends must wait for `confirmed` too.
export const provider = new anchor.AnchorProvider(envProvider.connection, envProvider.wallet, {
  commitment: 'confirmed',
  preflightCommitment: 'confirmed',
})
anchor.setProvider(provider)
export const connection = provider.connection
export const meridian = anchor.workspace.meridian as Program<Meridian>
export const oracle = anchor.workspace.meridianOracle as Program<MeridianOracle>

export interface Roles {
  admin: Keypair
  automation: Keypair
  relay: Keypair
  usdcMint: PublicKey
}

/** Everything a test needs about one strike market. */
export interface TestMarket {
  ticker: string
  /** `YYYY-MM-DD`; the on-chain `trading_day` is its `YYYYMMDD` number. */
  tradingDay: string
  tradingDayNumber: number
  strike: bigint
  closeTs: number
  tickerDay: PublicKey
  accounts: MarketAccounts
}

export function tickerBytes(ticker: string): number[] {
  const bytes = new Array<number>(8).fill(0)
  encoder.encode(ticker).forEach((byte, index) => (bytes[index] = byte))
  return bytes
}

function u32Le(value: number) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

function i64Le(value: bigint) {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigInt64(0, value, true)
  return bytes
}

function pda(programId: PublicKey, seeds: Uint8Array[]) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0]
}

export function dayNumber(tradingDay: string) {
  return Number(tradingDay.replaceAll('-', ''))
}

export const configPda = pda(meridian.programId, [encoder.encode('config')])
const registryPda = pda(oracle.programId, [encoder.encode('signers')])

export function tickerDayPda(ticker: string, tradingDay: string) {
  return pda(meridian.programId, [
    encoder.encode('day'),
    Uint8Array.from(tickerBytes(ticker)),
    u32Le(dayNumber(tradingDay)),
  ])
}

export function closeRecordPda(signer: PublicKey, ticker: string, tradingDay: string) {
  return pda(oracle.programId, [
    encoder.encode('close'),
    signer.toBytes(),
    Uint8Array.from(tickerBytes(ticker)),
    u32Le(dayNumber(tradingDay)),
  ])
}

export function marketAccounts(
  ticker: string,
  tradingDay: string,
  strike: bigint,
  usdcMint: PublicKey,
): MarketAccounts {
  const programId = meridian.programId
  const market = pda(programId, [
    encoder.encode('market'),
    Uint8Array.from(tickerBytes(ticker)),
    u32Le(dayNumber(tradingDay)),
    i64Le(strike),
  ])
  const child = (seed: string) => pda(programId, [encoder.encode(seed), market.toBytes()])
  return {
    programId,
    config: configPda,
    market,
    usdcMint,
    yesMint: child('yes'),
    noMint: child('no'),
    vault: child('vault'),
    book: child('book'),
    yesEscrow: child('yes_escrow'),
    usdcEscrow: child('usdc_escrow'),
  }
}

export function ata(owner: PublicKey, mint: PublicKey) {
  return pda(ASSOCIATED_TOKEN_PROGRAM_ID, [
    owner.toBytes(),
    TOKEN_PROGRAM_ID.toBytes(),
    mint.toBytes(),
  ])
}

function createAtaIdempotent(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  })
}

/** SPL Token `Transfer` (3) or `MintTo` (7): opcode then a u64 amount. */
function tokenAmountIx(
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

/** Legacy transaction for harness setup (funding, minting test USDC); not a trade path. */
export async function sendLegacy(instructions: TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...instructions)
  return provider.sendAndConfirm(tx, signers)
}

export async function airdrop(to: PublicKey, sol: number) {
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL)
  const latest = await connection.getLatestBlockhash('confirmed')
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
}

/** The validator's `Clock.unix_timestamp`. */
export async function chainNow(): Promise<number> {
  const info = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed')
  if (!info) throw new Error('clock sysvar missing')
  return Number(info.data.readBigInt64LE(32))
}

/** Waits until both the validator clock and the wall clock reach `unixSecs`. */
export async function waitUntil(unixSecs: number) {
  for (;;) {
    const [chain, wall] = [await chainNow(), Math.floor(Date.now() / 1000)]
    if (chain >= unixSecs && wall >= unixSecs) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

let roles: Promise<Roles> | undefined

/**
 * Bootstraps once per validator: a mock USDC mint (admin is its authority), `initialize_config`
 * signed by the upgrade authority with separate admin, automation and relay keys, slot 0 as the
 * relay and slot 1 disabled, then the oracle registry with the relay signer registered.
 */
export function bootstrap(): Promise<Roles> {
  roles ??= (async () => {
    if (await connection.getAccountInfo(configPda)) {
      throw new Error('Config already exists: run the lifecycle tests on a fresh validator')
    }
    const admin = Keypair.generate()
    const automation = Keypair.generate()
    const relay = Keypair.generate()
    await Promise.all([admin, automation, relay].map((key) => airdrop(key.publicKey, 100)))

    const mint = Keypair.generate()
    const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE)
    const initMint = Buffer.alloc(67)
    initMint.writeUInt8(20, 0) // InitializeMint2, no freeze authority
    initMint.writeUInt8(6, 1)
    admin.publicKey.toBuffer().copy(initMint, 2)
    await sendLegacy(
      [
        SystemProgram.createAccount({
          fromPubkey: provider.wallet.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports: rent,
          programId: TOKEN_PROGRAM_ID,
        }),
        new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
          data: initMint,
        }),
      ],
      [mint],
    )

    const relaySlot = {
      kind: { meridianRelay: {} },
      relaySigner: relay.publicKey,
      feedIds: Array.from({ length: 7 }, () => new Array<number>(32).fill(0)),
      verifierProgram: PublicKey.default,
      minVerificationLevel: 0,
    }
    const disabledSlot = { ...relaySlot, kind: { disabled: {} }, relaySigner: PublicKey.default }
    await meridian.methods
      .initializeConfig({
        admin: admin.publicKey,
        automationAuthority: automation.publicKey,
        tickers: TICKERS.map(tickerBytes),
        oracleSlots: [relaySlot, disabledSlot],
        maxStalenessSecs: 300,
        maxConfBps: 100,
        adminProposeDelaySecs: ADMIN_PROPOSE_DELAY_SECS,
        adminFinalizeDelaySecs: ADMIN_FINALIZE_DELAY_SECS,
      })
      .accountsPartial({
        authority: provider.wallet.publicKey,
        usdcMint: mint.publicKey,
        program: meridian.programId,
        programData: pda(BPF_LOADER_UPGRADEABLE_ID, [meridian.programId.toBytes()]),
      })
      .rpc()

    await oracle.methods
      .initializeRegistry(admin.publicKey)
      .accountsPartial({
        authority: provider.wallet.publicKey,
        registry: registryPda,
        program: oracle.programId,
        programData: pda(BPF_LOADER_UPGRADEABLE_ID, [oracle.programId.toBytes()]),
      })
      .rpc()
    await oracle.methods
      .addSigner(relay.publicKey)
      .accountsPartial({ admin: admin.publicKey, registry: registryPda })
      .signers([admin])
      .rpc()

    return { admin, automation, relay, usdcMint: mint.publicKey }
  })()
  return roles
}

/** Admin turns on demo mode when the program has an instruction for it (R44). */
export async function enableDemoMode(admin: Keypair) {
  const methods = meridian.methods as unknown as Record<string, DemoModeBuilder | undefined>
  const setDemoMode = methods.setDemoMode
  if (!setDemoMode) return false
  await setDemoMode(true).accountsPartial({ admin: admin.publicKey }).signers([admin]).rpc()
  return true
}

type DemoModeBuilder = (on: boolean) => {
  accountsPartial(accounts: Record<string, PublicKey>): {
    signers(signers: Keypair[]): { rpc(): Promise<string> }
  }
}

/** Admin creates one strike market (demo-style custom times: open now, close at `closeTs`). */
export async function createMarket(params: {
  ticker: string
  tradingDay: string
  strike: bigint
  closeTs: number
  openTs: number
}): Promise<TestMarket> {
  const { admin, usdcMint } = await bootstrap()
  const accounts = marketAccounts(params.ticker, params.tradingDay, params.strike, usdcMint)
  const tickerDay = tickerDayPda(params.ticker, params.tradingDay)
  await meridian.methods
    .createStrikeMarket({
      ticker: tickerBytes(params.ticker),
      tradingDay: dayNumber(params.tradingDay),
      strike: new BN(params.strike.toString()),
      strikeExpo: STRIKE_EXPO,
      closeTs: new BN(params.closeTs),
      mintOpenTs: new BN(params.openTs),
      tradingOpenTs: new BN(params.openTs),
    })
    .accountsPartial({
      authority: admin.publicKey,
      tickerDay,
      market: accounts.market,
      usdcMint,
    })
    .signers([admin])
    .rpc()
  return {
    ...params,
    tradingDayNumber: dayNumber(params.tradingDay),
    tickerDay,
    accounts,
  }
}

export async function tokenBalance(account: PublicKey): Promise<bigint> {
  const info = await connection.getAccountInfo(account, 'confirmed')
  if (!info) return 0n
  return BigInt((await connection.getTokenAccountBalance(account, 'confirmed')).value.amount)
}

export async function accountExists(address: PublicKey) {
  return (await connection.getAccountInfo(address, 'confirmed')) !== null
}

export interface Balances {
  usdc: bigint
  yes: bigint
  no: bigint
}

export async function balances(owner: PublicKey, market: TestMarket): Promise<Balances> {
  const m = market.accounts
  const [usdc, yes, no] = await Promise.all([
    tokenBalance(ata(owner, m.usdcMint)),
    tokenBalance(ata(owner, m.yesMint)),
    tokenBalance(ata(owner, m.noMint)),
  ])
  return { usdc, yes, no }
}

/**
 * A brand-new wallet with SOL, and only the token accounts its holdings need: USDC minted by
 * the admin, Yes or No moved from `source`. It has no `OpenOrders` seat.
 */
export async function freshWallet(
  market: TestMarket,
  holdings: { usdc?: bigint; yes?: bigint; no?: bigint; source?: Keypair } = {},
): Promise<Keypair> {
  const { admin } = await bootstrap()
  const wallet = Keypair.generate()
  await airdrop(wallet.publicKey, 2)
  const m = market.accounts
  const instructions: TransactionInstruction[] = []
  if (holdings.usdc) {
    instructions.push(
      createAtaIdempotent(admin.publicKey, wallet.publicKey, m.usdcMint),
      tokenAmountIx(
        7,
        m.usdcMint,
        ata(wallet.publicKey, m.usdcMint),
        admin.publicKey,
        holdings.usdc,
      ),
    )
  }
  const signers = [admin]
  for (const [mint, amount] of [
    [m.yesMint, holdings.yes],
    [m.noMint, holdings.no],
  ] as const) {
    if (!amount) continue
    if (!holdings.source) throw new Error('moving Yes or No needs a source wallet')
    instructions.push(
      createAtaIdempotent(admin.publicKey, wallet.publicKey, mint),
      tokenAmountIx(
        3,
        ata(holdings.source.publicKey, mint),
        ata(wallet.publicKey, mint),
        holdings.source.publicKey,
        amount,
      ),
    )
    if (!signers.includes(holdings.source)) signers.push(holdings.source)
  }
  if (instructions.length > 0) {
    await sendLegacy(
      instructions,
      signers.filter((s) => !s.publicKey.equals(provider.wallet.publicKey)),
    )
  }
  return wallet
}

function collateralAccounts(user: PublicKey, market: TestMarket) {
  const m = market.accounts
  return {
    user,
    market: m.market,
    yesMint: m.yesMint,
    noMint: m.noMint,
    vault: m.vault,
    userUsdc: ata(user, m.usdcMint),
    userYes: ata(user, m.yesMint),
    userNo: ata(user, m.noMint),
  }
}

/** `mint_pair(n)` with the wallet's Yes and No accounts created in the same transaction. */
export async function mintPair(user: Keypair, market: TestMarket, n: number) {
  const m = market.accounts
  return meridian.methods
    .mintPair(new BN(n))
    .accountsPartial(collateralAccounts(user.publicKey, market))
    .preInstructions([
      createAtaIdempotent(user.publicKey, user.publicKey, m.yesMint),
      createAtaIdempotent(user.publicKey, user.publicKey, m.noMint),
    ])
    .signers([user])
    .rpc()
}

export async function settleFunds(user: Keypair, market: TestMarket) {
  const m = market.accounts
  return meridian.methods
    .settleFunds()
    .accountsPartial({
      owner: user.publicKey,
      market: m.market,
      book: m.book,
      userYes: ata(user.publicKey, m.yesMint),
      userUsdc: ata(user.publicKey, m.usdcMint),
    })
    .signers([user])
    .rpc()
}

/**
 * `redeem` needs the wallet's USDC, Yes and No accounts to exist, and a wallet that only ever
 * bought one side lacks the other, so the client creates them idempotently first. The SDK has no
 * redeem builder yet, so this harness does what a client must.
 */
export async function redeem(user: Keypair, market: TestMarket, yes: bigint, no: bigint) {
  const m = market.accounts
  return meridian.methods
    .redeem(new BN(yes.toString()), new BN(no.toString()))
    .accountsPartial(collateralAccounts(user.publicKey, market))
    .preInstructions(
      [m.usdcMint, m.yesMint, m.noMint].map((mint) =>
        createAtaIdempotent(user.publicKey, user.publicKey, mint),
      ),
    )
    .signers([user])
    .rpc()
}

/** Redeems every Yes and No the wallet holds; returns the USDC it received. */
export async function redeemAll(user: Keypair, market: TestMarket): Promise<bigint> {
  const before = await balances(user.publicKey, market)
  await redeem(user, market, before.yes, before.no)
  const after = await balances(user.publicKey, market)
  expect(after.yes, 'Yes left after redeem').to.equal(0n)
  expect(after.no, 'No left after redeem').to.equal(0n)
  return after.usdc - before.usdc
}

/** The context the SDK builders need, from the wallet's live balances. */
export async function tradeContext(owner: PublicKey, market: TestMarket): Promise<TradeContext> {
  const held = await balances(owner, market)
  const { blockhash } = await connection.getLatestBlockhash('confirmed')
  return {
    owner,
    market: market.accounts,
    holdings: { yes: Number(held.yes / UNIT), no: Number(held.no / UNIT) },
    walletYesBaseUnits: held.yes,
    recentBlockhash: blockhash,
  }
}

/**
 * Signs an SDK-built transaction with the wallet alone and sends it. Asserts R27: exactly one
 * signature and at most 1232 bytes. Failures carry the program logs.
 */
export async function sendSdkTransaction(tx: VersionedTransaction, wallet: Keypair) {
  expect(tx.message.header.numRequiredSignatures, 'required signatures').to.equal(1)
  expect(tx.message.staticAccountKeys[0]?.equals(wallet.publicKey), 'fee payer').to.equal(true)
  tx.sign([wallet])
  const bytes = tx.serialize()
  expect(bytes.length, 'serialized size').to.be.at.most(MAX_TX_BYTES)
  try {
    const signature = await connection.sendRawTransaction(bytes)
    const latest = await connection.getLatestBlockhash('confirmed')
    const result = await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
    if (result.value.err) {
      const details = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      throw new Error(
        `transaction failed: ${JSON.stringify(result.value.err)}\n${(details?.meta?.logMessages ?? []).join('\n')}`,
      )
    }
    return signature
  } catch (error) {
    if (error instanceof SendTransactionError) {
      const logs = await error.getLogs(connection).catch(() => [])
      throw new Error(`${error.message}\n${(logs ?? []).join('\n')}`)
    }
    throw error
  }
}

/** Zero-copy `OrderBook` layout (`state/orderbook.rs`), the same offsets the app decodes. */
const BOOK_SIDE_CAPACITY = 32
const SEAT_CAPACITY = 32
const ORDER_SIZE = 24
const SEAT_SIZE = 48
const BIDS_OFFSET = 8 + 32 * 3 + 8 + 8
const ASKS_OFFSET = BIDS_OFFSET + BOOK_SIDE_CAPACITY * ORDER_SIZE
const SEATS_OFFSET = ASKS_OFFSET + BOOK_SIDE_CAPACITY * ORDER_SIZE

/** The wallet's resting orders and seat, read from the book account. */
export async function walletBook(owner: PublicKey, market: TestMarket) {
  const info = await connection.getAccountInfo(market.accounts.book, 'confirmed')
  if (!info) throw new Error('no book account')
  const data = Buffer.from(info.data)
  const seatIndex = Array.from({ length: SEAT_CAPACITY }, (_, i) => i).find((i) =>
    data
      .subarray(SEATS_OFFSET + i * SEAT_SIZE, SEATS_OFFSET + i * SEAT_SIZE + 32)
      .equals(owner.toBuffer()),
  )
  if (seatIndex === undefined) return { restingOrders: [] as RestingOrder[], seat: null }
  const seatAt = SEATS_OFFSET + seatIndex * SEAT_SIZE
  const side = (offset: number, name: RestingOrder['side']) =>
    Array.from({ length: BOOK_SIDE_CAPACITY }, (_, i) => offset + i * ORDER_SIZE)
      .map((at) => ({
        orderId: data.readBigUInt64LE(at),
        qty: Number(data.readBigUInt64LE(at + 8)),
        priceCents: data.readUInt8(at + 16),
        seat: data.readUInt8(at + 17),
      }))
      .filter((o) => o.qty > 0 && o.seat === seatIndex)
      .map(({ orderId, qty, priceCents }) => ({ orderId, side: name, priceCents, qty }))
  return {
    restingOrders: [...side(BIDS_OFFSET, 'Bid'), ...side(ASKS_OFFSET, 'Ask')],
    seat: {
      freeYesBaseUnits: data.readBigUInt64LE(seatAt + 32),
      freeUsdcBaseUnits: data.readBigUInt64LE(seatAt + 40),
    },
  }
}

export async function fetchMarket(market: TestMarket) {
  return meridian.account.market.fetch(market.accounts.market, 'confirmed')
}

export async function fetchTickerDay(market: TestMarket) {
  return meridian.account.tickerDay.fetch(market.tickerDay, 'confirmed')
}

async function supply(mint: PublicKey) {
  return BigInt((await connection.getTokenSupply(mint, 'confirmed')).value.amount)
}

/**
 * R6 after a mint, merge or redeem: the vault holds exactly `expectedVault`, the internal
 * counter agrees, and token supply matches. Before settlement collateral is exactly
 * `pairs_outstanding × UNIT` and both supplies equal it; after, collateral covers the winners.
 */
export async function expectVault(market: TestMarket, expectedVault: bigint) {
  const m = market.accounts
  const [state, vault, yesSupply, noSupply] = await Promise.all([
    fetchMarket(market),
    tokenBalance(m.vault),
    supply(m.yesMint),
    supply(m.noMint),
  ])
  const collateral = BigInt(state.collateral.toString())
  const pairs = BigInt(state.pairsOutstanding.toString())
  expect(vault, 'vault balance').to.equal(expectedVault)
  expect(collateral, 'collateral counter').to.equal(expectedVault)
  if ('open' in state.status) {
    expect(collateral, 'collateral == pairs_outstanding × UNIT').to.equal(pairs * UNIT)
    expect(yesSupply, 'Yes supply').to.equal(pairs * UNIT)
    expect(noSupply, 'No supply').to.equal(pairs * UNIT)
    return
  }
  const winningSupply = state.outcome && 'yes' in state.outcome ? yesSupply : noSupply
  expect(collateral >= winningSupply, 'collateral covers the winning supply').to.equal(true)
}

/** Relay signer publishes the canonical close through the real relay publisher and client. */
export async function publishRelayClose(market: TestMarket): Promise<CloseOutcome> {
  const { relay } = await bootstrap()
  const publisher = createRelayPublisher({
    oracle: createAnchorOracleClient({ connection, signer: relay, idl: oracle.idl }),
    source: createMockSource(),
    tickers: [market.ticker],
    clock: {
      now: () => Math.floor(Date.now() / 1000),
      sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    },
    log: () => {},
    demo: true,
  })
  return publisher.publishClose(market.ticker, market.tradingDay, market.closeTs)
}

/** Permissionless `settle_market` from slot 0, called here by the automation key. */
export async function settleMarket(market: TestMarket, slot = 0) {
  const { automation, relay } = await bootstrap()
  return meridian.methods
    .settleMarket(slot)
    .accountsPartial({
      caller: automation.publicKey,
      tickerDay: market.tickerDay,
      market: market.accounts.market,
      closeRecord: closeRecordPda(relay.publicKey, market.ticker, market.tradingDay),
    })
    .signers([automation])
    .rpc()
}

/**
 * R31 across every strike of one ticker-day: one stored price, and Yes for every strike at or
 * below it, No above.
 */
export async function expectOnePriceMonotone(markets: TestMarket[]) {
  const states = await Promise.all(markets.map(fetchMarket))
  const day = await fetchTickerDay(markets[0] as TestMarket)
  expect('final' in day.status, 'ticker-day final').to.equal(true)
  const exact = (strike: bigint) =>
    // price × 10^settle_expo ≥ strike × 10^STRIKE_EXPO, as exact integers.
    BigInt(day.settleNumerator.toString()) *
      10n ** BigInt(Math.max(0, day.settleExpo - STRIKE_EXPO)) >=
    strike *
      BigInt(day.settleDenominator.toString()) *
      10n ** BigInt(Math.max(0, STRIKE_EXPO - day.settleExpo))
  states.forEach((state, index) => {
    const market = markets[index] as TestMarket
    expect('settled' in state.status, `${market.strike} settled`).to.equal(true)
    expect(state.settlePrice.toString(), `${market.strike} price`).to.equal(
      day.settlePrice.toString(),
    )
    const wins = state.outcome !== null && 'yes' in state.outcome
    expect(wins, `${market.strike} outcome`).to.equal(exact(market.strike))
  })
  const sorted = [...markets].sort((a, b) => Number(a.strike - b.strike))
  const outcomes = await Promise.all(sorted.map(fetchMarket))
  const yes = outcomes.map((state) => state.outcome !== null && 'yes' in state.outcome)
  // Monotone: once a strike loses, every higher strike loses.
  yes.forEach((win, index) => {
    if (index > 0 && win) expect(yes[index - 1], 'monotone in strike').to.equal(true)
  })
}

export function expectError(promise: Promise<unknown>, code: string) {
  return promise.then(
    () => expect.fail(`expected ${code}`),
    (error: unknown) => expect(String(error)).to.contain(code),
  )
}
