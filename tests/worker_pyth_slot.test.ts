/**
 * R32 end to end: slot 1 switched to Pyth by `update_config`, and the worker switched by env vars
 * alone (`ORACLE_SLOT_1=pyth` and the Pyth settings), settles a market from a receiver
 * `PriceUpdateV2` account on a real validator with both programs.
 *
 * The update account is written byte for byte in the receiver's layout, as the LiteSVM adapter
 * tests do (`programs/meridian/tests/price_adapter_pyth.rs`), from the recorded Hermes sample
 * re-timed to this market's close. A validator only takes such an account at genesis, so this
 * suite starts its own validator with one update account planted per second of the next
 * `PLANTED_SECS`, and creates the market after setup, closing at one of those seconds. Setup time
 * on a busy host then only moves the close. The validator takes the first free port block outside
 * CI's reserved ports (or the PYTH_SLOT_TEST_* ports when set).
 * Hermes is a local HTTP server answering from the same sample, and the worker's update-account
 * locator hands back the planted account instead of posting through the receiver.
 *
 * Needs `anchor build`. Runs with the other Anchor integration tests, or alone:
 *   npx mocha --node-option import=tsx --timeout 1000000 tests/worker_pyth_slot.test.ts
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer as createHttpServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import anchorPackage from '@anchor-lang/core'
import type { Program } from '@anchor-lang/core'
import type { PythCloseUpdate } from '@meridian/price-providers'
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import { expect } from 'chai'
import type { Alert, AlertSink } from '../services/automation/src/alerts/index.js'
import type { OpenMarket, PythUpdateAccounts } from '../services/automation/src/chain/index.js'
import { createHealthState } from '../services/automation/src/health.js'
import { startWorker } from '../services/automation/src/worker.js'
import type { Worker } from '../services/automation/src/worker.js'
import type { Meridian } from '../target/types/meridian.js'
import type { MeridianOracle } from '../target/types/meridian_oracle.js'

const { AnchorProvider, BN, Program: AnchorProgram, Wallet } = anchorPackage

/** Seconds after setup to the market close: room to create the markets and switch the slot. */
const CLOSE_MARGIN_SECS = 20
/** Seconds of planted update accounts, longer than Mocha's 1000 s hook timeout. */
const PLANTED_SECS = 1_200
/** Agave needs room for its TPU, TVU and repair sockets. */
const DYNAMIC_PORT_COUNT = 40

const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA'] as const
const TRADING_DAY = '2026-11-16'
const STRIKE_EXPO = -2
/** $245.00 settles Yes and $246.00 No against the sample's $245.25. */
const STRIKES = [24_500n, 24_600n]

const RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ')
const AAPL_FEED = '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688'
const PRICE_UPDATE_V2_DISCRIMINATOR = [0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]
const PRICE_UPDATE_V2_LEN = 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8 + 8 + 8 + 8 + 8
/** `VerificationLevel::Full`'s Borsh tag; `min_verification_level` 0 requires it. */
const VERIFICATION_FULL = 1

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111')
const MINT_SIZE = 82
const SECOND_MS = 1_000
const encoder = new TextEncoder()

interface HermesEntry {
  id: string
  price: { price: string; conf: string; expo: number; publish_time: number }
  ema_price: { price: string; conf: string; expo: number; publish_time: number }
  metadata: { slot: number; proof_available_time: number; prev_publish_time: number }
}

interface HermesResponse {
  binary: { encoding: string; data: string[] }
  parsed: HermesEntry[]
}

/** The recorded Hermes sample, its odd-length hand-written update data cut to whole bytes. */
function hermesSample(): HermesResponse {
  const response = JSON.parse(
    readFileSync(
      'packages/price-providers/fixtures/pyth/hermes-2026-10-09-before-close.json',
      'utf8',
    ),
  ) as HermesResponse
  response.binary.data = response.binary.data.map((hex) => hex.slice(0, hex.length & ~1))
  return response
}

/** The sample's AAPL entry, published exactly at `closeTs` (shape 2). */
function aaplAt(closeTs: number): HermesEntry {
  const entry = hermesSample().parsed.find((candidate) => candidate.id === AAPL_FEED)
  if (!entry) throw new Error('the Hermes sample has no AAPL update')
  return {
    ...entry,
    price: { ...entry.price, publish_time: closeTs },
    ema_price: { ...entry.ema_price, publish_time: closeTs },
    metadata: { ...entry.metadata, prev_publish_time: closeTs - 1 },
  }
}

function le(bytes: number, write: (view: DataView) => void): number[] {
  const buffer = new ArrayBuffer(bytes)
  write(new DataView(buffer))
  return [...new Uint8Array(buffer)]
}

/** Borsh bytes of a receiver `PriceUpdateV2` account, zero-padded to `LEN` like the receiver's. */
function priceUpdateV2(entry: HermesEntry): Buffer {
  const data = [
    ...PRICE_UPDATE_V2_DISCRIMINATOR,
    ...Keypair.generate().publicKey.toBytes(), // write_authority
    VERIFICATION_FULL,
    ...Buffer.from(entry.id, 'hex'),
    ...le(8, (view) => view.setBigInt64(0, BigInt(entry.price.price), true)),
    ...le(8, (view) => view.setBigUint64(0, BigInt(entry.price.conf), true)),
    ...le(4, (view) => view.setInt32(0, entry.price.expo, true)),
    ...le(8, (view) => view.setBigInt64(0, BigInt(entry.price.publish_time), true)),
    ...le(8, (view) => view.setBigInt64(0, BigInt(entry.metadata.prev_publish_time), true)),
    ...le(8, (view) => view.setBigInt64(0, BigInt(entry.ema_price.price), true)),
    ...le(8, (view) => view.setBigUint64(0, BigInt(entry.ema_price.conf), true)),
    ...le(8, (view) => view.setBigUint64(0, BigInt(entry.metadata.slot), true)),
  ]
  const padded = Buffer.alloc(PRICE_UPDATE_V2_LEN)
  Buffer.from(data).copy(padded)
  return padded
}

function tickerBytes(ticker: string): number[] {
  const bytes = new Array<number>(8).fill(0)
  encoder.encode(ticker).forEach((byte, index) => (bytes[index] = byte))
  return bytes
}

function u32Le(value: number) {
  return Uint8Array.from(le(4, (view) => view.setUint32(0, value, true)))
}

function i64Le(value: bigint) {
  return Uint8Array.from(le(8, (view) => view.setBigInt64(0, value, true)))
}

const dayNumber = (tradingDay: string) => Number(tradingDay.replaceAll('-', ''))
const pda = (programId: PublicKey, seeds: Uint8Array[]) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0]
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const secretJson = (keypair: Keypair) => JSON.stringify([...keypair.secretKey])

function builtIdl(name: 'meridian' | 'meridian_oracle') {
  const path = `target/idl/${name}.json`
  if (!existsSync(path) || !existsSync(`target/deploy/${name}.so`)) {
    throw new Error(`no ${name} build: run anchor build first`)
  }
  return JSON.parse(readFileSync(path, 'utf8')) as { address: string }
}

/** Whether any process holds a TCP or UDP port in `low..high`. */
function portsBusy(low: number, high: number) {
  // The output, not the status: lsof exits 1 when any one selector matches nothing.
  const { stdout } = spawnSync('lsof', ['-nP', `-iTCP:${low}-${high}`, `-iUDP:${low}-${high}`], {
    encoding: 'utf8',
  })
  return stdout.trim() !== ''
}

/** The first block of `size` free ports from `low`, stepping by `size`, below `high`. */
function freeBlock(what: string, low: number, high: number, size: number) {
  for (let start = low; start + size - 1 <= high; start += size) {
    if (!portsBusy(start, start + size - 1)) return start
  }
  throw new Error(`no free ${what} ports in ${low}-${high}; set the PYTH_SLOT_TEST_* ports`)
}

/**
 * The validator's ports: the PYTH_SLOT_TEST_* ones when set, otherwise the first free blocks
 * clear of CI's (8899-8900, 9900, 9600-9650), Agave's default gossip 8000 and `make dev`'s 8913.
 * The RPC WebSocket takes the RPC port + 1 and the faucet the one after.
 */
function validatorPorts(env: NodeJS.ProcessEnv) {
  if (env.PYTH_SLOT_TEST_RPC_PORT) {
    const rpc = Number(env.PYTH_SLOT_TEST_RPC_PORT)
    const gossip = Number(env.PYTH_SLOT_TEST_GOSSIP_PORT || 9255)
    return {
      rpc,
      faucet: Number(env.PYTH_SLOT_TEST_FAUCET_PORT || rpc + 2),
      gossip,
      range:
        env.PYTH_SLOT_TEST_DYNAMIC_PORT_RANGE || `${gossip + 1}-${gossip + DYNAMIC_PORT_COUNT}`,
    }
  }
  const rpc = freeBlock('RPC', 8965, 8998, 3)
  const gossip = freeBlock('gossip', 9255, 9590, DYNAMIC_PORT_COUNT + 1)
  return {
    rpc,
    faucet: rpc + 2,
    gossip,
    range: `${gossip + 1}-${gossip + DYNAMIC_PORT_COUNT}`,
  }
}

/** The JSON `--account-dir` takes for a receiver-owned `PriceUpdateV2` at `address`. */
function plantedAccount(address: PublicKey, entry: HermesEntry) {
  const data = priceUpdateV2(entry)
  return JSON.stringify({
    pubkey: address.toBase58(),
    account: {
      lamports: LAMPORTS_PER_SOL,
      data: [data.toString('base64'), 'base64'],
      owner: RECEIVER.toBase58(),
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  })
}

/** Polls `check` every second until it returns a value, failing after `timeoutMs`. */
async function eventually<T>(
  what: string,
  timeoutMs: number,
  check: () => Promise<T | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check().catch(() => null)
    if (value !== null) return value
    if (Date.now() > deadline) expect.fail(`${what} within ${timeoutMs / SECOND_MS} s`)
    await sleep(SECOND_MS)
  }
}

interface HermesRequest {
  path: string
  ids: string[]
  authorization: string | undefined
  query: string[]
}

/** A Hermes stand-in that answers every price request with the AAPL update at `closeTs`. */
function startHermes(
  closeTs: number,
): Promise<{ server: Server; url: string; requests: HermesRequest[] }> {
  const requests: HermesRequest[] = []
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({
      path: url.pathname,
      ids: url.searchParams.getAll('ids[]'),
      authorization: req.headers.authorization,
      query: [...url.searchParams.values()],
    })
    if (!url.pathname.startsWith('/v2/updates/price/')) {
      res.writeHead(404).end()
      return
    }
    const body: HermesResponse = { binary: hermesSample().binary, parsed: [aaplAt(closeTs)] }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}`, requests })
    })
  })
}

function recordingSink(): AlertSink & { sent: Alert[] } {
  const sent: Alert[] = []
  return {
    name: 'recording',
    sent,
    async send(alert) {
      sent.push(alert)
    },
  }
}

describe('worker settles through a Pyth slot switched by update_config and env vars (R32)', () => {
  const ledger = mkdtempSync(join(tmpdir(), 'pyth-slot-ledger-'))
  const upgradeAuthority = Keypair.generate()
  const admin = Keypair.generate()
  const automation = Keypair.generate()
  const relay = Keypair.generate()
  /** The planted update account published at each second, keyed by that unix time. */
  const planted = new Map<number, PublicKey>()
  let closeTs = 0
  const located: { update: PythCloseUpdate; market: OpenMarket }[] = []
  const pythUpdates: PythUpdateAccounts = {
    async accountsFor(update, market) {
      located.push({ update, market })
      const account = planted.get(update.closeTs)
      if (!account) throw new Error(`no planted update account at ${update.closeTs}`)
      return [account]
    },
  }

  let rpcUrl = ''
  let validator: ChildProcess | undefined
  let hermes: Awaited<ReturnType<typeof startHermes>> | undefined
  let worker: Worker | undefined
  let connection: Connection
  let meridian: Program<Meridian>
  const marketAddresses: PublicKey[] = []
  let tickerDay: PublicKey

  before(async () => {
    const meridianId = builtIdl('meridian').address
    const oracleIdl = builtIdl('meridian_oracle')
    const ports = validatorPorts(process.env)
    rpcUrl = `http://127.0.0.1:${ports.rpc}`

    const accountDir = join(ledger, 'price-updates')
    mkdirSync(accountDir)
    const firstPlanted = Math.floor(Date.now() / 1000) + CLOSE_MARGIN_SECS
    for (let publishTs = firstPlanted; publishTs < firstPlanted + PLANTED_SECS; publishTs++) {
      const address = Keypair.generate().publicKey
      planted.set(publishTs, address)
      writeFileSync(
        join(accountDir, `${publishTs}.json`),
        plantedAccount(address, aaplAt(publishTs)),
      )
    }
    const validatorOutput = openSync(join(ledger, 'validator.out'), 'w')
    validator = spawn(
      'solana-test-validator',
      [
        '--ledger',
        join(ledger, 'ledger'),
        '--reset',
        '--quiet',
        '--bind-address',
        '127.0.0.1',
        '--rpc-port',
        String(ports.rpc),
        '--faucet-port',
        String(ports.faucet),
        '--gossip-port',
        String(ports.gossip),
        '--dynamic-port-range',
        ports.range,
        '--upgradeable-program',
        meridianId,
        'target/deploy/meridian.so',
        upgradeAuthority.publicKey.toBase58(),
        '--upgradeable-program',
        oracleIdl.address,
        'target/deploy/meridian_oracle.so',
        upgradeAuthority.publicKey.toBase58(),
        '--account-dir',
        accountDir,
      ],
      { stdio: ['ignore', validatorOutput, validatorOutput] },
    )

    connection = new Connection(rpcUrl, 'confirmed')
    const deadline = Date.now() + 60_000
    while (
      !(await connection.getAccountInfo(new PublicKey(meridianId)).catch(() => null))?.executable
    ) {
      if (validator.exitCode !== null || Date.now() > deadline) {
        const output = readFileSync(join(ledger, 'validator.out'), 'utf8').trim().split('\n')
        expect.fail(
          `the validator on ${rpcUrl} did not answer within 60 s` +
            ` (exit ${validator.exitCode}):\n${output.slice(-15).join('\n')}`,
        )
      }
      await sleep(SECOND_MS)
    }
    const provider = new AnchorProvider(connection, new Wallet(upgradeAuthority), {
      commitment: 'confirmed',
      preflightCommitment: 'confirmed',
    })
    meridian = new AnchorProgram(
      JSON.parse(readFileSync('target/idl/meridian.json', 'utf8')) as Meridian,
      provider,
    )
    const oracle: Program<MeridianOracle> = new AnchorProgram(
      JSON.parse(readFileSync('target/idl/meridian_oracle.json', 'utf8')) as MeridianOracle,
      provider,
    )
    for (const key of [upgradeAuthority, admin, automation, relay]) {
      const signature = await connection.requestAirdrop(key.publicKey, 100 * LAMPORTS_PER_SOL)
      const latest = await connection.getLatestBlockhash('confirmed')
      await connection.confirmTransaction({ signature, ...latest }, 'confirmed')
    }

    // Mock USDC, admin as mint authority.
    const mint = Keypair.generate()
    const initMint = Buffer.alloc(67)
    initMint.writeUInt8(20, 0) // InitializeMint2, no freeze authority
    initMint.writeUInt8(6, 1)
    admin.publicKey.toBuffer().copy(initMint, 2)
    await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: upgradeAuthority.publicKey,
          newAccountPubkey: mint.publicKey,
          space: MINT_SIZE,
          lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
          programId: TOKEN_PROGRAM_ID,
        }),
        new TransactionInstruction({
          programId: TOKEN_PROGRAM_ID,
          keys: [{ pubkey: mint.publicKey, isSigner: false, isWritable: true }],
          data: initMint,
        }),
      ),
      [mint],
    )

    // Bootstrapped as every deployment is: slot 1 the relay, slot 2 disabled.
    const zeroFeeds = TICKERS.map(() => new Array<number>(32).fill(0))
    const relaySlot = {
      kind: { meridianRelay: {} },
      relaySigner: relay.publicKey,
      feedIds: zeroFeeds,
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
        adminProposeDelaySecs: 900,
        adminFinalizeDelaySecs: 3600,
      })
      .accountsPartial({
        authority: upgradeAuthority.publicKey,
        usdcMint: mint.publicKey,
        program: meridian.programId,
        programData: pda(BPF_LOADER_UPGRADEABLE_ID, [meridian.programId.toBytes()]),
      })
      .rpc()
    const registry = pda(oracle.programId, [encoder.encode('signers')])
    await oracle.methods
      .initializeRegistry(admin.publicKey)
      .accountsPartial({
        authority: upgradeAuthority.publicKey,
        registry,
        program: oracle.programId,
        programData: pda(BPF_LOADER_UPGRADEABLE_ID, [oracle.programId.toBytes()]),
      })
      .rpc()
    await oracle.methods
      .addSigner(relay.publicKey)
      .accountsPartial({ admin: admin.publicKey, registry })
      .signers([admin])
      .rpc()
    // Markets here close seconds after creation, which needs demo mode (R44).
    await meridian.methods
      .setDemoMode(true)
      .accountsPartial({ admin: admin.publicKey })
      .signers([admin])
      .rpc()

    const day = u32Le(dayNumber(TRADING_DAY))
    const ticker = Uint8Array.from(tickerBytes('AAPL'))
    tickerDay = pda(meridian.programId, [encoder.encode('day'), ticker, day])
    // The close is set only now that setup is done, at a second with a planted update.
    const now = Math.floor(Date.now() / 1000)
    const openTs = now - 60
    closeTs = Math.max(now + CLOSE_MARGIN_SECS, firstPlanted)
    if (!planted.has(closeTs)) {
      expect.fail(`setup outlasted the ${PLANTED_SECS} s of planted update accounts`)
    }
    for (const strike of STRIKES) {
      const market = pda(meridian.programId, [encoder.encode('market'), ticker, day, i64Le(strike)])
      await meridian.methods
        .createStrikeMarket({
          ticker: tickerBytes('AAPL'),
          tradingDay: dayNumber(TRADING_DAY),
          strike: new BN(strike.toString()),
          strikeExpo: STRIKE_EXPO,
          closeTs: new BN(closeTs),
          mintOpenTs: new BN(openTs),
          tradingOpenTs: new BN(openTs),
        })
        .accountsPartial({
          authority: admin.publicKey,
          tickerDay,
          market,
          usdcMint: mint.publicKey,
        })
        .signers([admin])
        .rpc()
      marketAddresses.push(market)
    }

    // The switch: slot 1 becomes Pyth through update_config alone.
    const aaplFeeds = TICKERS.map((name) =>
      name === 'AAPL' ? [...Buffer.from(AAPL_FEED, 'hex')] : new Array<number>(32).fill(0),
    )
    await meridian.methods
      .updateConfig({
        automationAuthority: null,
        oracleSlots: [
          {
            kind: { pyth: {} },
            relaySigner: PublicKey.default,
            feedIds: aaplFeeds,
            verifierProgram: RECEIVER,
            minVerificationLevel: 0,
          },
          disabledSlot,
        ],
        maxStalenessSecs: null,
        maxConfBps: null,
        adminProposeDelaySecs: null,
        adminFinalizeDelaySecs: null,
      })
      .accountsPartial({ admin: admin.publicKey })
      .signers([admin])
      .rpc()

    hermes = await startHermes(closeTs)
  })

  after(async () => {
    worker?.stop()
    await worker?.done
    await new Promise((resolve) => (hermes ? hermes.server.close(resolve) : resolve(undefined)))
    if (validator && validator.exitCode === null) {
      const exited = new Promise((resolve) => validator?.once('exit', resolve))
      validator.kill('SIGTERM')
      await Promise.race([exited, sleep(10 * SECOND_MS)])
      if (validator.exitCode === null) validator.kill('SIGKILL')
    }
    rmSync(ledger, { recursive: true, force: true })
  })

  it('settles every strike from the planted PriceUpdateV2 account, configured only through env vars', async () => {
    const sink = recordingSink()
    const env: NodeJS.ProcessEnv = {
      SOLANA_RPC_URL: rpcUrl,
      AUTOMATION_KEYPAIR: secretJson(automation),
      RELAY_SIGNER_1_KEYPAIR: secretJson(relay),
      RELAY_1_SOURCE: 'mock',
      MERIDIAN_PROGRAM_ID: meridian.programId.toBase58(),
      MERIDIAN_ORACLE_PROGRAM_ID: builtIdl('meridian_oracle').address,
      ORACLE_SLOT_1: 'pyth',
      ORACLE_SLOT_2: 'disabled',
      PYTH_RECEIVER_PROGRAM_ID: RECEIVER.toBase58(),
      PYTH_FEED_IDS: `AAPL=${AAPL_FEED}`,
      PYTH_ACCESS_TOKEN: 'pyth-test-token',
      PYTH_HERMES_URL: hermes?.url,
    }
    worker = startWorker(createHealthState(), env, {
      log: () => {},
      alertSinks: [sink],
      pythUpdates,
    })

    await eventually(
      'the market close on the validator clock',
      (CLOSE_MARGIN_SECS + 60) * SECOND_MS,
      async () => {
        const clock = await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'confirmed')
        const chainNow = clock ? Number(clock.data.readBigInt64LE(32)) : 0
        return chainNow >= closeTs && Date.now() / 1000 >= closeTs ? true : null
      },
    )
    const states = await eventually('every strike settled', 120_000, async () => {
      const markets = await Promise.all(
        marketAddresses.map((address) => meridian.account.market.fetch(address, 'confirmed')),
      )
      return markets.every((market) => 'settled' in market.status) ? markets : null
    })

    // $245.25 from the Pyth update: Yes at $245.00, No at $246.00.
    expect(states.map((state) => state.outcome !== null && 'yes' in state.outcome)).to.deep.equal([
      true,
      false,
    ])
    const day = await meridian.account.tickerDay.fetch(tickerDay, 'confirmed')
    expect('oracleSlot0' in day.settleSource, 'settled from slot 1, not the admin').to.equal(true)
    expect(day.settlePrice.toString(), 'the Pyth price, not a relay close').to.equal('24525000')
    expect(day.settleExpo).to.equal(-5)

    // The worker read Hermes at close_ts for the AAPL feed, with the access token.
    const requests = hermes?.requests ?? []
    const atClose = requests.filter((request) => request.path === `/v2/updates/price/${closeTs}`)
    expect(atClose.length, 'a Hermes request at close_ts').to.be.greaterThan(0)
    atClose.forEach((request) => {
      expect(request.ids.map((id) => id.toLowerCase().replace(/^0x/, ''))).to.deep.equal([
        AAPL_FEED,
      ])
      const sent =
        request.authorization === 'Bearer pyth-test-token' ||
        request.query.includes('pyth-test-token')
      expect(sent, 'the access token is sent').to.equal(true)
    })
    // And located the update accounts for that update, signed data included.
    expect(located.length, 'update accounts located').to.be.greaterThan(0)
    const [first] = located
    expect(first?.update.ticker).to.equal('AAPL')
    expect(first?.update.closeTs).to.equal(closeTs)
    expect(first?.update.feedId).to.equal(AAPL_FEED)
    expect(first?.update.binary.map((bytes) => Buffer.from(bytes).toString('hex'))).to.deep.equal(
      hermesSample().binary.data,
    )
    expect(sink.sent.map((alert) => alert.kind)).to.not.include.members([
      'settlement_first_alert',
      'settlement_second_alert',
    ])
  })
})
