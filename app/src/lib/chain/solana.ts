import type { Holdings, ProgramEvent, YesBook } from '@meridian/sdk'
import { assertNotMainnet } from '@meridian/sdk'
import type { AccountInfo, GetProgramAccountsFilter } from '@solana/web3.js'
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js'
import type {
  CloseOutContext,
  MarketAccounts,
  RestingOrder,
  TradeBuilders,
  TradeContext,
} from './builders'
import { ChainError, toChainError } from './errors'
import type { MarketAccount, OrderBookAccount, RestingOrder as BookOrder } from './layout'
import {
  bytesToBase64,
  base58ToBytes,
  decodeConfigUsdcMint,
  decodeLatestPrice,
  decodeMarket,
  decodeOrderBook,
  DISCRIMINATORS,
  eventFromCpiData,
  eventsFromLogs,
  scaled,
  tickerBytes,
  toYesBook,
  UNIT,
} from './layout'
import { TICKERS } from './types'
import type {
  CancelOrderRequest,
  ChainClient,
  Commitment,
  Confirmation,
  ContractSummary,
  LatestPrice,
  MarketOwner,
  OpenOrder,
  SignedTx,
  Ticker,
  TradeIntent,
  Unsubscribe,
  UnsignedTx,
} from './types'

export interface SolanaChainConfig {
  rpcUrl: string
  wsUrl?: string
  programId: string
  oracleProgramId: string
  /** Public key of the relay signer whose latest-price accounts the app reads. */
  relaySigner: string
  /** The SDK transaction builders. Without them, building a transaction rejects. */
  builders?: TradeBuilders
  /** Polling interval for the account-subscription fallback (R22). Defaults to 1 s. */
  pollIntervalMs?: number
  /** Current time in Unix seconds, for the Open/Closed status. Defaults to the system clock. */
  now?: () => number
}

const COMMITMENT = 'confirmed' as const
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')
/** A healthy subscription that misses this many polled changes is treated as failed. */
const WATCHDOG_INTERVAL_MS = 5000
/** Signatures scanned per address for history. */
const SIGNATURE_LIMIT = 500
/** A latest-price fallback poll keeps the display fresh if the websocket drops quietly. */
const PRICE_POLL_MS = 30_000

const encoder = new TextEncoder()
const seed = (text: string) => encoder.encode(text)

function sameData(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()],
    ATA_PROGRAM_ID,
  )[0]
}

/**
 * Watches one account with `accountSubscribe` at `confirmed`. A watchdog re-reads the account
 * every few seconds; if the account changed and the subscription never reported it, the
 * subscription is treated as failed and `onError` fires once, so the caller can poll (R22).
 */
function watchAccount(
  connection: Connection,
  address: PublicKey,
  onData: (data: Uint8Array) => void,
  onError: (error: unknown) => void,
): Unsubscribe {
  let lastSeen: Uint8Array | null = null
  let failed = false
  let stopped = false
  let subscriptionId: number | null = null

  const fail = (error: unknown) => {
    if (failed || stopped) return
    failed = true
    onError(error)
  }

  try {
    subscriptionId = connection.onAccountChange(
      address,
      (info: AccountInfo<Buffer>) => {
        lastSeen = Uint8Array.from(info.data)
        onData(lastSeen)
      },
      { commitment: COMMITMENT },
    )
  } catch (error) {
    queueMicrotask(() => fail(error))
  }

  let missed = 0
  const watchdog = setInterval(() => {
    connection
      .getAccountInfo(address, COMMITMENT)
      .then((info) => {
        const polled = info ? Uint8Array.from(info.data) : null
        if (lastSeen !== null && !sameData(polled, lastSeen)) missed += 1
        else missed = 0
        if (lastSeen === null) lastSeen = polled
        if (missed >= 2) fail(new Error('account subscription missed updates'))
      })
      .catch(() => {})
  }, WATCHDOG_INTERVAL_MS)

  return () => {
    stopped = true
    clearInterval(watchdog)
    if (subscriptionId !== null)
      connection.removeAccountChangeListener(subscriptionId).catch(() => {})
  }
}

/** The `ChainClient` backed by an RPC connection, at `confirmed` commitment (R55). */
class SolanaChainClient implements ChainClient {
  readonly commitment: Commitment = COMMITMENT
  private connectionInstance: Connection | null = null
  private readonly programId: PublicKey
  private readonly oracleProgramId: PublicKey
  private readonly relaySigner: PublicKey
  private usdcMintPromise: Promise<PublicKey> | null = null
  private readonly lastValidHeights = new WeakMap<object, number>()

  constructor(private readonly config: SolanaChainConfig) {
    assertNotMainnet(config.rpcUrl)
    this.programId = new PublicKey(config.programId)
    this.oracleProgramId = new PublicKey(config.oracleProgramId)
    this.relaySigner = new PublicKey(config.relaySigner)
  }

  /** Created on first use, so constructing the client opens no sockets. */
  private get connection(): Connection {
    if (!this.connectionInstance) {
      this.connectionInstance = new Connection(this.config.rpcUrl, {
        commitment: COMMITMENT,
        wsEndpoint: this.config.wsUrl,
      })
    }
    return this.connectionInstance
  }

  private now(): number {
    return this.config.now?.() ?? Math.floor(Date.now() / 1000)
  }

  private pda(seeds: Uint8Array[], programId = this.programId): PublicKey {
    return PublicKey.findProgramAddressSync(seeds, programId)[0]
  }

  private latestPriceAddress(ticker: Ticker): PublicKey {
    return this.pda(
      [seed('latest'), this.relaySigner.toBytes(), tickerBytes(ticker)],
      this.oracleProgramId,
    )
  }

  private bookAddress(market: PublicKey): PublicKey {
    return this.pda([seed('book'), market.toBytes()])
  }

  private usdcMint(): Promise<PublicKey> {
    if (!this.usdcMintPromise) {
      const config = this.pda([seed('config')])
      this.usdcMintPromise = this.connection.getAccountInfo(config).then((info) => {
        if (!info) throw new ChainError('Unknown', 'The program config account is missing.')
        return decodeConfigUsdcMint(Uint8Array.from(info.data))
      })
      this.usdcMintPromise.catch(() => {
        this.usdcMintPromise = null
      })
    }
    return this.usdcMintPromise
  }

  private async marketAccount(market: PublicKey): Promise<MarketAccount> {
    const info = await this.connection.getAccountInfo(market)
    if (!info) throw new ChainError('Unknown', `Market ${market.toBase58()} not found.`)
    return decodeMarket(Uint8Array.from(info.data))
  }

  private async bookAccount(book: PublicKey): Promise<OrderBookAccount> {
    const info = await this.connection.getAccountInfo(book)
    if (!info) throw new ChainError('Unknown', `Order book ${book.toBase58()} not found.`)
    return decodeOrderBook(Uint8Array.from(info.data))
  }

  private async tokenBalance(account: PublicKey): Promise<bigint> {
    const info = await this.connection.getAccountInfo(account)
    // SPL token account: mint (32), owner (32), amount (u64 LE).
    if (!info || info.data.length < 72) return 0n
    return new DataView(info.data.buffer, info.data.byteOffset + 64, 8).getBigUint64(0, true)
  }

  private toLatestPrice(data: Uint8Array): LatestPrice | null {
    const decoded = decodeLatestPrice(data)
    const ticker = TICKERS.find((t) => t === decoded.ticker)
    if (!ticker) return null
    return { ticker, price: decoded.price, publishTs: decoded.publishTs }
  }

  async getLatestPrices(): Promise<LatestPrice[]> {
    const infos = await this.connection.getMultipleAccountsInfo(
      TICKERS.map((ticker) => this.latestPriceAddress(ticker)),
    )
    return infos
      .map((info) => (info ? this.toLatestPrice(Uint8Array.from(info.data)) : null))
      .filter((price): price is LatestPrice => price !== null)
  }

  subscribeLatestPrices(onPrice: (price: LatestPrice) => void): Unsubscribe {
    const emit = (data: Uint8Array) => {
      const price = this.toLatestPrice(data)
      if (price) onPrice(price)
    }
    const subscriptions = TICKERS.map((ticker) =>
      watchAccount(this.connection, this.latestPriceAddress(ticker), emit, () => {}),
    )
    const poll = setInterval(() => {
      this.getLatestPrices()
        .then((prices) => prices.forEach(onPrice))
        .catch(() => {})
    }, PRICE_POLL_MS)
    return () => {
      clearInterval(poll)
      subscriptions.forEach((unsubscribe) => unsubscribe())
    }
  }

  async listMarkets(ticker?: Ticker): Promise<ContractSummary[]> {
    const filters: GetProgramAccountsFilter[] = [
      {
        memcmp: {
          offset: 0,
          bytes: bytesToBase64(Uint8Array.from(DISCRIMINATORS.Market)),
          encoding: 'base64',
        },
      },
    ]
    if (ticker) {
      filters.push({
        memcmp: { offset: 8, bytes: bytesToBase64(tickerBytes(ticker)), encoding: 'base64' },
      })
    }
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      commitment: COMMITMENT,
      filters,
    })
    const markets = accounts.flatMap(({ pubkey, account }) => {
      try {
        return [{ address: pubkey, market: decodeMarket(Uint8Array.from(account.data)) }]
      } catch {
        return []
      }
    })
    const books = await this.connection.getMultipleAccountsInfo(markets.map((m) => m.market.book))
    const nowTs = this.now()
    return markets.flatMap(({ address, market }, i): ContractSummary[] => {
      const known = TICKERS.find((t) => t === market.ticker)
      if (!known) return []
      const bookInfo = books[i]
      const book = bookInfo ? toYesBook(decodeOrderBook(Uint8Array.from(bookInfo.data))) : null
      return [summarize(address, known, market, book, nowTs)]
    })
  }

  async getBook(market: string): Promise<YesBook> {
    return toYesBook(await this.bookAccount(this.bookAddress(new PublicKey(market))))
  }

  subscribeBook(
    market: string,
    onBook: (book: YesBook) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe {
    return watchAccount(
      this.connection,
      this.bookAddress(new PublicKey(market)),
      (data) => onBook(toYesBook(decodeOrderBook(data))),
      onError,
    )
  }

  async getUsdcBalance(owner: string): Promise<number> {
    const mint = await this.usdcMint()
    return Number(await this.tokenBalance(ata(new PublicKey(owner), mint)))
  }

  /** Base-unit balances of one owner in one market: wallet Yes and No, plus book escrow. */
  private async balances(owner: PublicKey, marketAddress: PublicKey) {
    const market = await this.marketAccount(marketAddress)
    const [walletYes, walletNo, book] = await Promise.all([
      this.tokenBalance(ata(owner, market.yesMint)),
      this.tokenBalance(ata(owner, market.noMint)),
      this.bookAccount(market.book),
    ])
    const seatIndex = book.seats.findIndex((s) => s.owner.equals(owner))
    const seat = book.seats[seatIndex]
    const ownAsks = book.asks.filter((o) => o.seat === seatIndex)
    const ownBids = book.bids.filter((o) => o.seat === seatIndex)
    const lockedYes = BigInt(ownAsks.reduce((sum, o) => sum + o.qty, 0)) * BigInt(UNIT)
    const resting =
      (side: RestingOrder['side']) =>
      (o: BookOrder): RestingOrder => ({
        orderId: o.orderId,
        side,
        priceCents: o.priceCents,
        qty: o.qty,
      })
    return {
      market,
      book,
      walletYes,
      walletNo,
      bookYes: (seat?.freeYes ?? 0n) + lockedYes,
      seat: seat ? { freeYesBaseUnits: seat.freeYes, freeUsdcBaseUnits: seat.freeUsdc } : null,
      restingOrders:
        seatIndex < 0 ? [] : [...ownBids.map(resting('Bid')), ...ownAsks.map(resting('Ask'))],
    }
  }

  async getHoldings(owner: string, market: string): Promise<Holdings> {
    const b = await this.balances(new PublicKey(owner), new PublicKey(market))
    return {
      yes: Number(b.walletYes + b.bookYes) / UNIT,
      no: Number(b.walletNo) / UNIT,
    }
  }

  /**
   * Events from the owner's transactions, plus every transaction on the markets they touched, so
   * maker fills in other wallets' transactions and `MarketSettled` are included (R53).
   */
  async getEvents(owner: string): Promise<ProgramEvent[]> {
    const ownerKey = new PublicKey(owner)
    const own = await this.eventsFor(ownerKey)
    const markets = new Set(own.map((e) => e.market))
    const marketEvents = await Promise.all(
      [...markets].map((m) => this.eventsFor(new PublicKey(m))),
    )
    const seen = new Set<string>()
    return [...own, ...marketEvents.flat()]
      .filter((event) => {
        const key = JSON.stringify(event)
        if (seen.has(key)) return false
        seen.add(key)
        if (event.kind === 'MarketSettled') return true
        if (event.kind === 'OrderFilled') return event.maker === owner || event.taker === owner
        return event.owner === owner
      })
      .sort((a, b) => a.ts - b.ts)
  }

  private async eventsFor(address: PublicKey): Promise<ProgramEvent[]> {
    const signatures = await this.connection.getSignaturesForAddress(
      address,
      { limit: SIGNATURE_LIMIT },
      COMMITMENT,
    )
    const ok = signatures.filter((s) => s.err === null).reverse()
    const txs = await this.connection.getTransactions(
      ok.map((s) => s.signature),
      { commitment: COMMITMENT, maxSupportedTransactionVersion: 0 },
    )
    return txs.flatMap((tx, i) => {
      const signature = ok[i]?.signature
      if (!tx || !signature || !tx.meta) return []
      const meta = { signature, ts: tx.blockTime ?? 0 }
      const keys = tx.transaction.message.getAccountKeys({
        accountKeysFromLookups: tx.meta.loadedAddresses,
      })
      const fromCpi = (tx.meta.innerInstructions ?? []).flatMap((inner) =>
        inner.instructions
          .filter((ix) => keys.get(ix.programIdIndex)?.equals(this.programId))
          .map((ix) => eventFromCpiData(base58ToBytes(ix.data), meta))
          .filter((event): event is ProgramEvent => event !== null),
      )
      return [...eventsFromLogs(tx.meta.logMessages ?? [], meta), ...fromCpi]
    })
  }

  private async marketAccounts(
    marketAddress: PublicKey,
    market: MarketAccount,
    book: OrderBookAccount,
  ) {
    const accounts: MarketAccounts = {
      programId: this.programId,
      config: this.pda([seed('config')]),
      market: marketAddress,
      usdcMint: await this.usdcMint(),
      yesMint: market.yesMint,
      noMint: market.noMint,
      vault: market.vault,
      book: market.book,
      yesEscrow: book.yesEscrow,
      usdcEscrow: book.usdcEscrow,
    }
    return accounts
  }

  private builders(): TradeBuilders {
    if (!this.config.builders) {
      throw new ChainError('Unknown', 'Trading is not available in this build yet.')
    }
    return this.config.builders
  }

  private async blockhash() {
    return this.connection.getLatestBlockhash(COMMITMENT)
  }

  private wrap(tx: VersionedTransaction, lastValidBlockHeight: number): UnsignedTx {
    this.lastValidHeights.set(tx.message, lastValidBlockHeight)
    return { raw: tx }
  }

  async buildTrade(intent: TradeIntent): Promise<UnsignedTx> {
    const builders = this.builders()
    const owner = new PublicKey(intent.owner)
    const marketAddress = new PublicKey(intent.market)
    const [b, latest] = await Promise.all([this.balances(owner, marketAddress), this.blockhash()])
    const ctx: TradeContext = {
      owner,
      market: await this.marketAccounts(marketAddress, b.market, b.book),
      holdings: {
        yes: Number(b.walletYes + b.bookYes) / UNIT,
        no: Number(b.walletNo) / UNIT,
      },
      walletYesBaseUnits: b.walletYes,
      recentBlockhash: latest.blockhash,
    }
    const { qty, priceCents, orderType: kind } = intent
    const tx = (() => {
      switch (intent.action) {
        case 'BuyYes':
          return builders.buildBuyYesTransaction(ctx, { kind, priceCents, qty })
        case 'SellYes':
          return builders.buildSellYesTransaction(ctx, { kind, priceCents, qty })
        case 'BuyNo':
          return builders.buildBuyNoTransaction(ctx, { kind, noPriceCents: priceCents, qty })
        case 'SellNo':
          return builders.buildSellNoTransaction(ctx, { noPriceCents: priceCents, qty })
      }
    })()
    return this.wrap(tx, latest.lastValidBlockHeight)
  }

  private async closeOutContext(
    request: MarketOwner,
  ): Promise<{ ctx: CloseOutContext; height: number }> {
    const owner = new PublicKey(request.owner)
    const marketAddress = new PublicKey(request.market)
    const [b, latest] = await Promise.all([this.balances(owner, marketAddress), this.blockhash()])
    return {
      ctx: {
        owner,
        market: await this.marketAccounts(marketAddress, b.market, b.book),
        outcome: b.market.settled ? b.market.outcome : null,
        walletYesBaseUnits: b.walletYes,
        walletNoBaseUnits: b.walletNo,
        restingOrders: b.restingOrders,
        seat: b.seat,
        recentBlockhash: latest.blockhash,
      },
      height: latest.lastValidBlockHeight,
    }
  }

  async buildRedeem(request: MarketOwner): Promise<UnsignedTx> {
    const build = this.builders().buildRedeem
    if (!build) throw new ChainError('Unknown', 'Redeem is not available in this build yet.')
    const { ctx, height } = await this.closeOutContext(request)
    return this.wrap(build(ctx), height)
  }

  async buildCloseOutAndRedeem(request: MarketOwner): Promise<UnsignedTx[]> {
    const build = this.builders().buildCloseOutAndRedeem
    if (!build) {
      throw new ChainError('Unknown', 'Close out and redeem is not available in this build yet.')
    }
    const { ctx, height } = await this.closeOutContext(request)
    return build(ctx).transactions.map((tx) => this.wrap(tx, height))
  }

  async getOpenOrders(owner: string, market: string): Promise<OpenOrder[]> {
    void owner
    void market
    throw new ChainError('Unknown', 'Open orders are not available in this build yet.')
  }

  async buildCancelOrder(request: CancelOrderRequest): Promise<UnsignedTx> {
    void request
    throw new ChainError('Unknown', 'Cancel order is not available in this build yet.')
  }

  async buildCloseOutPosition(request: MarketOwner): Promise<UnsignedTx[]> {
    void request
    throw new ChainError('Unknown', 'Close out position is not available in this build yet.')
  }

  async sendAndConfirm(tx: SignedTx, commitment: Commitment): Promise<Confirmation> {
    const raw = tx.raw
    if (!(raw instanceof VersionedTransaction)) {
      throw new ChainError('Unknown', 'Unsupported transaction type.')
    }
    try {
      const signature = await this.connection.sendTransaction(raw, {
        preflightCommitment: commitment,
      })
      const lastValidBlockHeight =
        this.lastValidHeights.get(raw.message) ??
        (await this.connection.getLatestBlockhash(commitment)).lastValidBlockHeight
      const result = await this.connection.confirmTransaction(
        { signature, blockhash: raw.message.recentBlockhash, lastValidBlockHeight },
        commitment,
      )
      if (result.value.err) {
        const confirmed = await this.connection.getTransaction(signature, {
          commitment: COMMITMENT,
          maxSupportedTransactionVersion: 0,
        })
        throw toChainError(
          Object.assign(new Error(JSON.stringify(result.value.err)), {
            logs: confirmed?.meta?.logMessages ?? [],
          }),
        )
      }
      return { signature }
    } catch (error) {
      throw toChainError(error)
    }
  }
}

function referenceYesPrice(book: YesBook | null): number | null {
  const bid = book?.bids[0]?.priceCents
  const ask = book?.asks[0]?.priceCents
  if (bid !== undefined && ask !== undefined) return Math.round((bid + ask) / 2)
  return bid ?? ask ?? null
}

function summarize(
  address: PublicKey,
  ticker: Ticker,
  market: MarketAccount,
  book: YesBook | null,
  nowTs: number,
): ContractSummary {
  const settlement =
    market.settled && market.outcome && market.settleSource
      ? {
          price: scaled(market.settlePrice, market.strikeExpo),
          source: market.settleSource,
          outcome: market.outcome,
        }
      : null
  let status: ContractSummary['status'] = 'Open'
  if (market.settled) status = 'Settled'
  else if (nowTs >= market.closeTs) status = 'Closed'
  return {
    market: address.toBase58(),
    ticker,
    strike: scaled(market.strike, market.strikeExpo),
    closeTs: market.closeTs,
    status,
    demo: market.demo,
    yesPriceCents: referenceYesPrice(book),
    settlement,
  }
}

/** The `ChainClient` backed by an RPC connection. */
export function createSolanaChainClient(config: SolanaChainConfig): ChainClient {
  return new SolanaChainClient(config)
}
