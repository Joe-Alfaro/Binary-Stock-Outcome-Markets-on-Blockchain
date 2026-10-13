import type { Holdings, ProgramEvent, YesBook } from '@meridian/sdk'
import type {
  ChainClient,
  Commitment,
  Confirmation,
  ContractSummary,
  LatestPrice,
  MarketOwner,
  SignedTx,
  Ticker,
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

  readonly calls = {
    getBook: [] as string[],
    buildTrade: [] as TradeIntent[],
    buildRedeem: [] as MarketOwner[],
    buildCloseOutAndRedeem: [] as MarketOwner[],
    sendAndConfirm: [] as { tx: SignedTx; commitment: Commitment }[],
    getUsdcBalance: [] as string[],
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

  async buildCloseOutAndRedeem(request: MarketOwner): Promise<UnsignedTx> {
    this.calls.buildCloseOutAndRedeem.push(request)
    return { raw: { kind: 'close-out-and-redeem', request } }
  }

  async sendAndConfirm(tx: SignedTx, commitment: Commitment): Promise<Confirmation> {
    this.calls.sendAndConfirm.push({ tx, commitment })
    if (this.sendError) {
      const error = this.sendError
      this.sendError = null
      throw error
    }
    return { signature: `sig-${this.calls.sendAndConfirm.length}` }
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
