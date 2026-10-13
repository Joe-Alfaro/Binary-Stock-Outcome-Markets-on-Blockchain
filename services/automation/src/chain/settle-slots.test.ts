/**
 * R32: the worker's settle step follows each slot's kind, so switching slot 1 takes only
 * `update_config` plus env vars. The real Anchor client runs against an in-memory connection that
 * holds the program accounts and captures every sent transaction; the Pyth and Data Streams HTTP
 * providers answer from the recorded samples in `packages/price-providers/fixtures`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import anchor from '@anchor-lang/core'
import type { PythCloseUpdate } from '@meridian/price-providers'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import type { AccountInfo, Connection, TransactionInstruction } from '@solana/web3.js'
import type { OracleSlotSetting, OracleSlotSettings } from '../config.js'
import { createAnchorChainClient, loadMeridianIdl } from './anchor.js'
import { tickerBytes, tradingDayNumber, u32Le } from './codec.js'
import type { OpenMarket, PythUpdateAccounts } from './types.js'

const { AnchorProvider, BN, BorshInstructionCoder, Program, Wallet, utils } = anchor

const encoder = new TextEncoder()
const idl = loadMeridianIdl()
const PROGRAM_ID = new PublicKey(idl.address)
const ORACLE_PROGRAM_ID = Keypair.generate().publicKey
const TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA']

/** 2026-10-09 16:00 ET, the close the recorded samples are built around. */
const CLOSE_TS = 1791576000
const TRADING_DAY = '2026-10-09'
const AAPL_FEED = '49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688'
const RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ')
const VERIFIER = Keypair.generate().publicKey
const HERMES_URL = 'https://hermes.test'
const STREAMS_URL = 'https://streams.test'

const fixture = (path: string) =>
  readFileSync(
    new URL(`../../../../packages/price-providers/fixtures/${path}`, import.meta.url),
    'utf8',
  )

interface HermesFixture {
  binary: { encoding: string; data: string[] }
  parsed: { id: string }[]
}

/** The recorded Hermes sample, its odd-length hand-written update data cut to whole bytes. */
function hermes(): HermesFixture {
  const response = JSON.parse(fixture('pyth/hermes-2026-10-09-before-close.json')) as HermesFixture
  response.binary.data = response.binary.data.map((hex) => hex.slice(0, hex.length & ~1))
  return response
}

const v11 = JSON.parse(fixture('chainlink/v11-AAPL-2026-10-09-before-close.json')) as {
  feedId: string
  validFromTimestamp: number
  observationsTimestamp: number
}
const AAPL_STREAM = v11.feedId.toLowerCase().replace(/^0x/, '')
const FULL_REPORT = Buffer.from(`signed v11 report ${AAPL_STREAM} ${CLOSE_TS}`)

const PYTH: OracleSlotSetting = {
  kind: 'pyth',
  receiverProgram: RECEIVER.toBase58(),
  feedIds: { AAPL: AAPL_FEED },
  accessToken: 'pyth-token',
  hermesUrl: HERMES_URL,
}
const CHAINLINK: OracleSlotSetting = {
  kind: 'chainlink',
  verifierProgram: VERIFIER.toBase58(),
  streamIds: { AAPL: AAPL_STREAM },
  username: 'streams-user',
  secret: 'streams-secret',
  apiUrl: STREAMS_URL,
}

type ChainKind = 'disabled' | 'meridianRelay' | 'pyth' | 'chainlinkDataStreams'

/** The program each third-party kind reads through: the Pyth receiver, the Data Streams verifier. */
const VERIFIER_PROGRAMS: Partial<Record<ChainKind, PublicKey>> = {
  pyth: RECEIVER,
  chainlinkDataStreams: VERIFIER,
}

/** A dummy client, only for its coders. */
const program = new Program(
  idl,
  new AnchorProvider({} as Connection, new Wallet(Keypair.generate()), {}),
)
const accountsCoder = program.coder.accounts
const instructionCoder = new BorshInstructionCoder(program.idl)

const pda = (seeds: Uint8Array[], owner = PROGRAM_ID) =>
  PublicKey.findProgramAddressSync(seeds, owner)[0]
const CONFIG = pda([encoder.encode('config')])
const TICKER_DAY = pda([
  encoder.encode('day'),
  tickerBytes('AAPL'),
  u32Le(tradingDayNumber(TRADING_DAY)),
])
const MARKET = Keypair.generate().publicKey

const zeros = (length: number) => new Array<number>(length).fill(0)
const hexBytes = (hex: string) => [...Buffer.from(hex, 'hex')]

function oracleSlot(kind: ChainKind, relaySigner: PublicKey) {
  const feedIds = TICKERS.map(() => zeros(32))
  if (kind === 'pyth') feedIds[0] = hexBytes(AAPL_FEED)
  if (kind === 'chainlinkDataStreams') feedIds[0] = hexBytes(AAPL_STREAM)
  return {
    kind: { [kind]: {} },
    relaySigner: kind === 'meridianRelay' ? relaySigner : PublicKey.default,
    feedIds,
    verifierProgram: VERIFIER_PROGRAMS[kind] ?? PublicKey.default,
    minVerificationLevel: 0,
  }
}

interface FetchCall {
  url: URL
  headers: Headers
}

/** A connection holding the config, market and ticker-day, capturing every sent transaction. */
class FakeConnection {
  readonly rpcEndpoint = 'http://fake.test'
  readonly accounts = new Map<string, AccountInfo<Buffer>>()
  readonly sent: Transaction[] = []
  /** Runs on each send, to apply what the program would. */
  onSend: (tx: Transaction) => Promise<void> = async () => {}

  put(address: PublicKey, data: Buffer, owner = PROGRAM_ID) {
    this.accounts.set(address.toBase58(), {
      data,
      owner,
      lamports: 1_000_000,
      executable: false,
      rentEpoch: 0,
    })
  }

  async getAccountInfo(address: PublicKey) {
    return this.accounts.get(address.toBase58()) ?? null
  }

  async getAccountInfoAndContext(address: PublicKey) {
    return { context: { slot: 1 }, value: await this.getAccountInfo(address) }
  }

  async getMultipleAccountsInfo(addresses: PublicKey[]) {
    return Promise.all(addresses.map((address) => this.getAccountInfo(address)))
  }

  async getMultipleAccountsInfoAndContext(addresses: PublicKey[]) {
    return { context: { slot: 1 }, value: await this.getMultipleAccountsInfo(addresses) }
  }

  async getLatestBlockhash() {
    return { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1_000 }
  }

  async sendRawTransaction(raw: Uint8Array) {
    const tx = Transaction.from(raw)
    this.sent.push(tx)
    await this.onSend(tx)
    return utils.bytes.bs58.encode(tx.signature ?? new Uint8Array(64))
  }

  async confirmTransaction() {
    return { context: { slot: 1 }, value: { err: null } }
  }
}

interface SetupOptions {
  /** Kinds of the on-chain `Config` slots, as `update_config` left them. */
  chain: [ChainKind, ChainKind]
  /** `ORACLE_SLOT_1` / `ORACLE_SLOT_2`; omitted means the client's defaults. */
  settings?: OracleSlotSettings
  /** The ticker-day is already final, as after the first strike settled. */
  final?: boolean
  /** Answers each Pyth or Data Streams request. */
  route?: (url: URL) => Response
  /** The `PriceUpdateV2` accounts the locator hands back. */
  pythAccounts?: PublicKey[]
}

async function encodeTickerDay(final: boolean, slotIndex = 0) {
  return accountsCoder.encode('tickerDay', {
    ticker: [...tickerBytes('AAPL')],
    tradingDay: tradingDayNumber(TRADING_DAY),
    closeTs: new BN(CLOSE_TS),
    status: final ? { final: {} } : { open: {} },
    settlePrice: new BN(final ? 24_525_000 : 0),
    settleExpo: final ? -5 : 0,
    settleSource: final ? { [slotIndex === 0 ? 'oracleSlot0' : 'oracleSlot1']: {} } : { none: {} },
    pendingAdminPrice: new BN(0),
    pendingAdminAt: new BN(0),
    bump: 255,
    settleNumerator: new BN(final ? 24_525_000 : 0),
    settleDenominator: new BN(final ? 1 : 0),
  })
}

async function setup(options: SetupOptions) {
  const connection = new FakeConnection()
  const authority = Keypair.generate()
  const relay = Keypair.generate()
  connection.put(
    CONFIG,
    await accountsCoder.encode('config', {
      admin: Keypair.generate().publicKey,
      automationAuthority: authority.publicKey,
      usdcMint: Keypair.generate().publicKey,
      tickers: TICKERS.map((ticker) => [...tickerBytes(ticker)]),
      oracleSlots: options.chain.map((kind) => oracleSlot(kind, relay.publicKey)),
      maxStalenessSecs: 300,
      maxConfBps: 100,
      adminProposeDelaySecs: 900,
      adminFinalizeDelaySecs: 3600,
      paused: false,
      demoMode: false,
      bump: 255,
    }),
  )
  connection.put(
    MARKET,
    await accountsCoder.encode('market', {
      ticker: [...tickerBytes('AAPL')],
      tradingDay: tradingDayNumber(TRADING_DAY),
      strike: new BN(24_500),
      strikeExpo: -2,
      closeTs: new BN(CLOSE_TS),
      mintOpenTs: new BN(CLOSE_TS - 23_400),
      tradingOpenTs: new BN(CLOSE_TS - 23_400),
      tickerDay: TICKER_DAY,
      yesMint: Keypair.generate().publicKey,
      noMint: Keypair.generate().publicKey,
      vault: Keypair.generate().publicKey,
      book: Keypair.generate().publicKey,
      collateral: new BN(0),
      pairsOutstanding: new BN(0),
      status: { open: {} },
      outcome: null,
      settlePrice: new BN(0),
      settleSource: { none: {} },
      demo: false,
      createdAt: new BN(CLOSE_TS - 30_000),
      bump: 255,
      reserved: zeros(64),
    }),
  )
  connection.put(TICKER_DAY, await encodeTickerDay(options.final ?? false))
  const relayCloseRecord = pda(
    [
      encoder.encode('close'),
      relay.publicKey.toBytes(),
      tickerBytes('AAPL'),
      u32Le(tradingDayNumber(TRADING_DAY)),
    ],
    ORACLE_PROGRAM_ID,
  )
  // The relay has published its close, so a relay slot has a price.
  connection.put(relayCloseRecord, Buffer.alloc(64), ORACLE_PROGRAM_ID)
  // The program makes the ticker-day final from the first settle.
  connection.onSend = async (tx) => {
    const slotIndex = decodeSettle(tx).args.slot
    connection.put(TICKER_DAY, await encodeTickerDay(true, slotIndex))
  }

  const fetches: FetchCall[] = []
  const fetchStub = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
    fetches.push({ url, headers })
    return (options.route ?? (() => new Response('no route', { status: 500 })))(url)
  }

  const located: { update: PythCloseUpdate; market: OpenMarket }[] = []
  const pythUpdates: PythUpdateAccounts = {
    async accountsFor(update, market) {
      located.push({ update, market })
      return options.pythAccounts ?? []
    },
  }

  const chain = createAnchorChainClient({
    connection: connection as unknown as Connection,
    authority,
    idl,
    oracleProgramId: ORACLE_PROGRAM_ID,
    retry: { attempts: 1, baseDelayMs: 0 },
    ...(options.settings ? { slotSettings: options.settings } : {}),
    pythUpdates,
    fetch: fetchStub as typeof fetch,
    now: () => 1_791_576_090_000,
  })
  const market: OpenMarket = {
    address: MARKET.toBase58(),
    ticker: 'AAPL',
    tradingDay: TRADING_DAY,
    strike: 245n,
    closeTs: CLOSE_TS,
  }
  return { chain, connection, market, fetches, located, relayCloseRecord }
}

interface DecodedSettle {
  name: string
  args: { slot: number; reports?: Uint8Array[] }
  /** The instruction's accounts in IDL order, then any remaining accounts. */
  keys: PublicKey[]
}

function meridianInstruction(tx: Transaction): TransactionInstruction {
  const ix = tx.instructions.find((candidate) => candidate.programId.equals(PROGRAM_ID))
  assert.ok(ix, 'the transaction calls the meridian program')
  return ix
}

function decodeSettle(tx: Transaction): DecodedSettle {
  const ix = meridianInstruction(tx)
  const decoded = instructionCoder.decode(Buffer.from(ix.data))
  assert.ok(decoded, 'a meridian instruction')
  return {
    name: decoded.name,
    args: decoded.data as DecodedSettle['args'],
    keys: ix.keys.map((meta) => meta.pubkey),
  }
}

/** The single settle instruction the client sent. */
function onlySettle(connection: FakeConnection): DecodedSettle {
  assert.equal(connection.sent.length, 1, 'one settle transaction')
  return decodeSettle(connection.sent[0] as Transaction)
}

const hermesRoute = (response: unknown) => (url: URL) =>
  url.origin === HERMES_URL
    ? new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
    : new Response('unexpected host', { status: 500 })

const reportRoute = (url: URL) =>
  url.origin === STREAMS_URL
    ? new Response(
        JSON.stringify({
          report: {
            feedID: v11.feedId,
            validFromTimestamp: v11.validFromTimestamp,
            observationsTimestamp: v11.observationsTimestamp,
            fullReport: `0x${FULL_REPORT.toString('hex')}`,
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    : new Response('unexpected host', { status: 500 })

const notFound = () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })

const same = (a: PublicKey | undefined, b: PublicKey) => a?.toBase58() === b.toBase58()

describe('settle step by slot kind (R32)', () => {
  it('relay: settle_market with the slot relay CloseRecord, by default and from ORACLE_SLOT_1=relay', async () => {
    for (const settings of [
      undefined,
      { slot1: { kind: 'relay' }, slot2: { kind: 'disabled' } } satisfies OracleSlotSettings,
    ]) {
      const { chain, connection, market, fetches, located, relayCloseRecord } = await setup({
        chain: ['meridianRelay', 'disabled'],
        ...(settings ? { settings } : {}),
      })

      const result = await chain.settleMarket(market, 1)

      const settle = onlySettle(connection)
      assert.equal(settle.name, 'settleMarket')
      assert.equal(settle.args.slot, 0)
      assert.ok(same(settle.keys[4], relayCloseRecord), 'close_record is the relay CloseRecord')
      assert.equal(settle.keys.length, 5, 'no remaining accounts')
      assert.deepEqual(fetches, [], 'no third-party HTTP request')
      assert.deepEqual(located, [])
      assert.equal(result.status, 'settled')
    }
  })

  it('pyth: reads the Hermes update at close_ts, locates its PriceUpdateV2 accounts and settles from them', async () => {
    const [first, second] = [Keypair.generate().publicKey, Keypair.generate().publicKey]
    const response = hermes()
    const { chain, connection, market, fetches, located } = await setup({
      chain: ['pyth', 'disabled'],
      settings: { slot1: PYTH, slot2: { kind: 'disabled' } },
      route: hermesRoute(response),
      pythAccounts: [first, second],
    })

    const result = await chain.settleMarket(market, 1)

    assert.equal(fetches.length, 1, 'one Hermes request')
    const [request] = fetches
    assert.equal(request?.url.pathname, `/v2/updates/price/${CLOSE_TS}`)
    assert.deepEqual(
      request?.url.searchParams.getAll('ids[]').map((id) => id.toLowerCase().replace(/^0x/, '')),
      [AAPL_FEED],
    )
    assert.equal(located.length, 1, 'the update accounts are located once')
    const call = located[0]
    assert.ok(call)
    const { update, market: forMarket } = call
    assert.equal(update.ticker, 'AAPL')
    assert.equal(update.closeTs, CLOSE_TS)
    assert.equal(update.feedId, AAPL_FEED)
    assert.deepEqual(
      update.binary.map((bytes) => Buffer.from(bytes).toString('hex')),
      response.binary.data,
    )
    assert.equal(forMarket.address, market.address)

    const settle = onlySettle(connection)
    assert.equal(settle.name, 'settleMarket')
    assert.equal(settle.args.slot, 0)
    assert.ok(same(settle.keys[4], first), 'close_record is the first PriceUpdateV2 account')
    assert.deepEqual(
      settle.keys.slice(5).map((key) => key.toBase58()),
      [second.toBase58()],
      'the other update accounts follow as remaining accounts',
    )
    assert.deepEqual(result, {
      status: 'settled',
      price: { price: 24_525_000n, expo: -5 },
      source: 1,
    })
  })

  it('pyth: no Hermes update at close_ts yet means no price, and nothing is sent', async () => {
    const { chain, connection, market, located } = await setup({
      chain: ['pyth', 'disabled'],
      settings: { slot1: PYTH, slot2: { kind: 'disabled' } },
      route: notFound,
      pythAccounts: [Keypair.generate().publicKey],
    })

    assert.deepEqual(await chain.settleMarket(market, 1), { status: 'no_price' })
    assert.equal(connection.sent.length, 0)
    assert.equal(located.length, 0)
  })

  it('chainlink: settle_market_with_reports with the signed fullReport bytes and the slot verifier', async () => {
    const { chain, connection, market, fetches, located, relayCloseRecord } = await setup({
      chain: ['chainlinkDataStreams', 'disabled'],
      settings: { slot1: CHAINLINK, slot2: { kind: 'disabled' } },
      route: reportRoute,
    })

    const result = await chain.settleMarket(market, 1)

    assert.equal(fetches.length, 1, 'one Data Streams request')
    const [request] = fetches
    assert.equal(request?.url.pathname, '/api/v1/reports')
    assert.equal(request?.url.searchParams.get('feedID')?.toLowerCase(), `0x${AAPL_STREAM}`)
    assert.equal(request?.url.searchParams.get('timestamp'), String(CLOSE_TS))
    assert.equal(request?.headers.get('authorization'), 'streams-user')
    assert.ok(request?.headers.get('x-authorization-signature-sha256'), 'the request is signed')
    assert.deepEqual(located, [])

    const settle = onlySettle(connection)
    assert.equal(settle.name, 'settleMarketWithReports')
    assert.equal(settle.args.slot, 0)
    assert.deepEqual(
      (settle.args.reports ?? []).map((bytes) => Buffer.from(bytes).toString('hex')),
      [FULL_REPORT.toString('hex')],
    )
    assert.ok(same(settle.keys[4], VERIFIER), 'verifier_program is the slot verifier')
    assert.ok(
      !settle.keys.some((key) => same(key, relayCloseRecord)),
      'no relay CloseRecord is passed',
    )
    assert.equal(result.status, 'settled')
  })

  it('chainlink: no report at close_ts yet means no price, and nothing is sent', async () => {
    const { chain, connection, market } = await setup({
      chain: ['chainlinkDataStreams', 'disabled'],
      settings: { slot1: CHAINLINK, slot2: { kind: 'disabled' } },
      route: notFound,
    })

    assert.deepEqual(await chain.settleMarket(market, 1), { status: 'no_price' })
    assert.equal(connection.sent.length, 0)
  })

  it('settles slot 2 by its own kind: Pyth on slot 2 beside the relay on slot 1', async () => {
    const update = Keypair.generate().publicKey
    const { chain, connection, market, located } = await setup({
      chain: ['meridianRelay', 'pyth'],
      settings: { slot1: { kind: 'relay' }, slot2: PYTH },
      route: hermesRoute(hermes()),
      pythAccounts: [update],
    })

    await chain.settleMarket(market, 2)

    assert.equal(located.length, 1)
    const settle = onlySettle(connection)
    assert.equal(settle.name, 'settleMarket')
    assert.equal(settle.args.slot, 1)
    assert.ok(same(settle.keys[4], update), 'close_record is the PriceUpdateV2 account')
  })

  it('a final ticker-day settles the next strike without fetching or posting third-party inputs', async () => {
    for (const [kind, setting] of [
      ['pyth', PYTH],
      ['chainlinkDataStreams', CHAINLINK],
    ] as const) {
      const { chain, connection, market, fetches, located } = await setup({
        chain: [kind, 'disabled'],
        settings: { slot1: setting, slot2: { kind: 'disabled' } },
        final: true,
        route: kind === 'pyth' ? hermesRoute(hermes()) : reportRoute,
        pythAccounts: [Keypair.generate().publicKey],
      })

      const result = await chain.settleMarket(market, 1)

      assert.equal(connection.sent.length, 1, `${kind}: one settle transaction`)
      assert.deepEqual(fetches, [], `${kind}: no HTTP request once the price is final`)
      assert.deepEqual(located, [], `${kind}: nothing located or posted`)
      assert.deepEqual(result, {
        status: 'settled',
        price: { price: 24_525_000n, expo: -5 },
        source: 1,
      })
    }
  })
})
