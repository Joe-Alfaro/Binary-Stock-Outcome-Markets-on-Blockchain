export type ChainErrorCode =
  'SignatureRejected' | 'InsufficientUsdc' | 'Paused' | 'MarketClosed' | 'Unknown'

/** A failure the UI can explain. `ChainClient` methods reject with this. */
export class ChainError extends Error {
  readonly code: ChainErrorCode

  constructor(code: ChainErrorCode, message: string = code) {
    super(message)
    this.name = 'ChainError'
    this.code = code
  }
}

/** Classifies a wallet, RPC or program error. */
export function toChainError(error: unknown): ChainError {
  void error
  throw new Error('not implemented')
}

/** The message the trade panel shows for a failed trade (R54). */
export function tradeErrorMessage(error: unknown): string {
  void error
  throw new Error('not implemented')
}
