import type { Holdings, ProgramEvent, YesBook } from '@meridian/sdk'
import type {
  AdminConfig,
  CancelOrderRequest,
  ChainClient,
  Commitment,
  Confirmation,
  ContractSummary,
  FinalizeAdminSettleRequest,
  LatestPrice,
  MarketOwner,
  OpenOrder,
  ProposeAdminPriceRequest,
  SetPausedRequest,
  SignedTx,
  Ticker,
  TickerDaySummary,
  TradeIntent,
  Unsubscribe,
  UnsignedTx,
  WalletOption,
  WalletPort,
} from '../../src/lib/chain'

type BookListener = { onBook: (book: YesBook) => void; onError: (error: unknown) => void }

/** In-memory `ChainClient` that records every call the UI makes. */
export class FakeChain implements ChainClient {
  readonly commitment: Commitment = 'confirmed'
  prices: LatestPrice[] = []
  markets: ContractSummary[] = []
  books = new Map<string, YesBook>()
  holdings = new Map<string, Holdings>()
  events: ProgramEvent[] = []
  usdcBalance = 0
  /** When true, book subscriptions fail at once, as when the websocket is down. */
  failBookSubscriptions = false
  /** Rejects the next `sendAndConfirm` with this error. */
  sendError: unknown = null
  /** How many transactions close-out builds: more than one when the orders don't fit one. */
  closeOutTransactions = 1
  /** The wallet's resting orders per market. */
  openOrders = new Map<string, OpenOrder[]>()
  /** How many transactions close-out-position builds. */
  closeOutPositionTransactions = 1
  /** `Config` as the Admin page reads it (R70). The connected test wallet is the admin. */
  adminConfig: AdminConfig = {
    admin: WALLET,
    paused: false,
    proposeDelaySecs: 900,
    finalizeDelaySecs: 3600,
  }
  tickerDays: TickerDaySummary[] = []

  readonly calls = {
    getBook: [] as string[],
    buildTrade: [] as TradeIntent[],
    buildRedeem: [] as MarketOwner[],
    buildCloseOutAndRedeem: [] as MarketOwner[],
    buildCancelOrder: [] as CancelOrderRequest[],
    buildCloseOutPosition: [] as MarketOwner[],
    sendAndConfirm: [] as { tx: SignedTx; commitment: Commitment }[],
    getUsdcBalance: [] as string[],
    buildProposeAdminPrice: [] as ProposeAdminPriceRequest[],
    buildFinalizeAdminSettle: [] as FinalizeAdminSettleRequest[],
    buildSetPaused: [] as SetPausedRequest[],
  }

  private priceListeners = new Set<(price: LatestPrice) => void>()
  private bookListeners = new Map<string, Set<BookListener>>()

  async getLatestPrices() {
    return [...this.prices]
  }

  subscribeLatestPrices(onPrice: (price: LatestPrice) => void): Unsubscribe {
    this.priceListeners.add(onPrice)
    return () => this.priceListeners.delete(onPrice)
  }

  async listMarkets(ticker?: Ticker) {
    return this.markets.filter((m) => ticker === undefined || m.ticker === ticker)
  }

  async getBook(market: string) {
    this.calls.getBook.push(market)
    return this.books.get(market) ?? { bids: [], asks: [] }
  }

  subscribeBook(
    market: string,
    onBook: (book: YesBook) => void,
    onError: (error: unknown) => void,
  ): Unsubscribe {
    if (this.failBookSubscriptions) {
      queueMicrotask(() => onError(new Error('websocket closed')))
      return () => {}
    }
    const listener = { onBook, onError }
    const set = this.bookListeners.get(market) ?? new Set<BookListener>()
    set.add(listener)
    this.bookListeners.set(market, set)
    return () => set.delete(listener)
  }

  async getUsdcBalance(owner: string) {
    this.calls.getUsdcBalance.push(owner)
    return this.usdcBalance
  }

  async getHoldings(owner: string, market: string) {
    void owner
    return this.holdings.get(market) ?? { yes: 0, no: 0 }
  }

  async getEvents(owner: string) {
    void owner
    return [...this.events]
  }

  async buildTrade(intent: TradeIntent): Promise<UnsignedTx> {
    this.calls.buildTrade.push(intent)
    return { raw: { kind: 'trade', intent } }
  }

  async buildRedeem(request: MarketOwner): Promise<UnsignedTx> {
    this.calls.buildRedeem.push(request)
    return { raw: { kind: 'redeem', request } }
  }

  async buildCloseOutAndRedeem(request: MarketOwner): Promise<UnsignedTx[]> {
    this.calls.buildCloseOutAndRedeem.push(request)
    return Array.from({ length: this.closeOutTransactions }, (_, part) => ({
      raw: { kind: 'close-out-and-redeem', request, part },
    }))
  }

  async getOpenOrders(owner: string, market: string) {
    void owner
    return [...(this.openOrders.get(market) ?? [])]
  }

  async buildCancelOrder(request: CancelOrderRequest): Promise<UnsignedTx> {
    this.calls.buildCancelOrder.push(request)
    return { raw: { kind: 'cancel-order', request } }
  }

  async buildCloseOutPosition(request: MarketOwner): Promise<UnsignedTx[]> {
    this.calls.buildCloseOutPosition.push(request)
    const parts = this.closeOutPositionTransactions
    return Array.from({ length: parts }, (_, part) => ({
      raw: { kind: 'close-out-position', request, part, last: part === parts - 1 },
    }))
  }

  async getAdminConfig() {
    return { ...this.adminConfig }
  }

  async listTickerDays() {
    return this.tickerDays.map((day) => ({ ...day }))
  }

  async buildProposeAdminPrice(request: ProposeAdminPriceRequest): Promise<UnsignedTx> {
    this.calls.buildProposeAdminPrice.push(request)
    return { raw: { kind: 'propose-admin-price', request } }
  }

  async buildFinalizeAdminSettle(request: FinalizeAdminSettleRequest): Promise<UnsignedTx> {
    this.calls.buildFinalizeAdminSettle.push(request)
    return { raw: { kind: 'finalize-admin-settle', request } }
  }

  async buildSetPaused(request: SetPausedRequest): Promise<UnsignedTx> {
    this.calls.buildSetPaused.push(request)
    return { raw: { kind: 'set-paused', request } }
  }

  async sendAndConfirm(tx: SignedTx, commitment: Commitment): Promise<Confirmation> {
    this.calls.sendAndConfirm.push({ tx, commitment })
    if (this.sendError) {
      const error = this.sendError
      this.sendError = null
      throw error
    }
    this.apply(tx)
    return { signature: `sig-${this.calls.sendAndConfirm.length}` }
  }

  /**
   * What the program does for the unwind transactions: a cancel returns the escrow to the wallet
   * (escrowed Yes already counts in `holdings`; a bid's USDC comes back), and close-out then
   * merges every Yes+No pair into one USDC each.
   */
  private apply(tx: SignedTx) {
    this.applyAdmin(tx)
    const signed = (tx.raw as { signed?: unknown }).signed as
      { kind: string; request: CancelOrderRequest; last?: boolean } | undefined
    if (signed?.kind !== 'cancel-order' && signed?.kind !== 'close-out-position') return
    const { market, orderId } = signed.request
    const orders = this.openOrders.get(market) ?? []
    const cancel = (order: OpenOrder) => {
      if (order.side === 'Bid') this.usdcBalance += order.qty * order.priceCents * 10_000
    }
    if (signed.kind === 'cancel-order') {
      orders.filter((o) => o.orderId === orderId).forEach(cancel)
      this.openOrders.set(
        market,
        orders.filter((o) => o.orderId !== orderId),
      )
      return
    }
    if (signed.kind !== 'close-out-position' || !signed.last) return
    orders.forEach(cancel)
    this.openOrders.set(market, [])
    const held = this.holdings.get(market) ?? { yes: 0, no: 0 }
    const pairs = Math.min(held.yes, held.no)
    this.holdings.set(market, { yes: held.yes - pairs, no: held.no - pairs })
    this.usdcBalance += pairs * 1_000_000
  }

  /** What the program does for the admin transactions (R36, R41). */
  private applyAdmin(tx: SignedTx) {
    const signed = (tx.raw as { signed?: { kind: string; request: unknown } }).signed
    if (signed?.kind === 'set-paused') {
      this.adminConfig.paused = (signed.request as SetPausedRequest).paused
      return
    }
    if (signed?.kind !== 'propose-admin-price' && signed?.kind !== 'finalize-admin-settle') return
    const request = signed.request as ProposeAdminPriceRequest | FinalizeAdminSettleRequest
    const day = this.tickerDays.find(
      (d) => d.ticker === request.ticker && d.tradingDay === request.tradingDay,
    )
    if (!day) return
    if ('priceCents' in request) day.pendingAdminPrice = request.priceCents / 100
    else day.status = 'Final'
  }

  /** Simulates another wallet's order landing: pushes the new book through the subscription. */
  pushBook(market: string, book: YesBook) {
    this.books.set(market, book)
    this.bookListeners.get(market)?.forEach((l) => l.onBook(book))
  }

  pushPrice(price: LatestPrice) {
    this.prices = [...this.prices.filter((p) => p.ticker !== price.ticker), price]
    this.priceListeners.forEach((l) => l(price))
  }
}

/** Mocked wallet adapter: counts signature prompts and can reject one. */
export class FakeWallet implements WalletPort {
  readonly wallets: readonly WalletOption[] = [{ name: 'Phantom' }, { name: 'Solflare' }]
  publicKey: string | null = null
  connectedWith: string | null = null
  signPrompts = 0
  disconnects = 0
  /** Rejects the next signature prompt the way the wallet adapter does when the user declines. */
  rejectNextSign = false

  private listeners = new Set<() => void>()

  constructor(publicKey: string | null = null) {
    this.publicKey = publicKey
  }

  getPublicKey() {
    return this.publicKey
  }

  subscribe(listener: () => void): Unsubscribe {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async connect(walletName: string) {
    this.connectedWith = walletName
    this.publicKey = WALLET
    this.listeners.forEach((l) => l())
  }

  async disconnect() {
    this.disconnects += 1
    this.publicKey = null
    this.listeners.forEach((l) => l())
  }

  async signTransaction(tx: UnsignedTx): Promise<SignedTx> {
    this.signPrompts += 1
    if (this.rejectNextSign) {
      this.rejectNextSign = false
      const error = new Error('User rejected the request.')
      error.name = 'WalletSignTransactionError'
      throw error
    }
    return { raw: { signed: tx.raw } }
  }
}

export const WALLET = 'Fq8m3sZ7kU2pXb4cTn9wQe6rHy1vLd5aGj3oPi7uMt2N'
export const OTHER_WALLET = 'Bz2t9WqLm4nXc7vRk1pYs8dJh3fGa6eTu5oNi9wQx4Kc'
