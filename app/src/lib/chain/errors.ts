import { PositionConstraintError, RedeemError } from '@meridian/sdk'

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

/** `meridian` program errors the UI explains, by Anchor error name and number (6000 + index). */
const PROGRAM_ERRORS: Record<string, ChainErrorCode> = {
  Paused: 'Paused',
  MarketClosed: 'MarketClosed',
  MarketSettled: 'MarketClosed',
}
const PROGRAM_ERROR_NUMBERS: Record<number, ChainErrorCode> = {
  6002: 'Paused',
  6004: 'MarketClosed',
  6005: 'MarketClosed',
}

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Program logs from a `@solana/web3.js` `SendTransactionError` or a simulation result. */
function logsOf(error: unknown): string[] {
  if (!isRecord(error)) return []
  const logs = error.logs ?? error.transactionLogs
  if (Array.isArray(logs)) return logs.filter((line): line is string => typeof line === 'string')
  return []
}

function isWalletRejection(error: unknown): boolean {
  if (!isRecord(error)) return false
  if (error.code === 4001) return true
  const name = typeof error.name === 'string' ? error.name : ''
  const message = typeof error.message === 'string' ? error.message : ''
  if (/user rejected|rejected the request|declined/i.test(message)) return true
  return name === 'WalletSignTransactionError' && /reject/i.test(message)
}

function fromLogs(lines: readonly string[]): ChainErrorCode | null {
  const text = lines.join('\n')
  const anchor = /Error Code: (\w+)\. Error Number: (\d+)/.exec(text)
  if (anchor) {
    const byName = PROGRAM_ERRORS[anchor[1] ?? '']
    if (byName) return byName
  }
  const hex = /custom program error: (0x[0-9a-f]+)/i.exec(text)
  const number = hex ? Number.parseInt(hex[1] ?? '', 16) : NaN
  const tokenFailed = lines.some((line) => line.startsWith(`Program ${TOKEN_PROGRAM} failed`))
  if (/insufficient funds/i.test(text) && (tokenFailed || number === 1)) return 'InsufficientUsdc'
  if (!tokenFailed && PROGRAM_ERROR_NUMBERS[number]) return PROGRAM_ERROR_NUMBERS[number]
  return null
}

/** Classifies a wallet, RPC or program error. */
export function toChainError(error: unknown): ChainError {
  if (error instanceof ChainError) return error
  if (isWalletRejection(error)) return new ChainError('SignatureRejected')
  const message = error instanceof Error ? error.message : String(error)
  const code = fromLogs([...logsOf(error), message])
  return new ChainError(code ?? 'Unknown', code ? code : message)
}

const MESSAGES: Record<Exclude<ChainErrorCode, 'Unknown'>, string> = {
  SignatureRejected: 'You rejected the signature in your wallet, so nothing was sent.',
  InsufficientUsdc: 'There is not enough USDC in your wallet for this order.',
  Paused: 'Trading is paused right now. Try again once it resumes.',
  MarketClosed: 'This market is closed to new orders.',
}

/** The message the trade panel shows for a failed trade (R54). */
export function tradeErrorMessage(error: unknown): string {
  if (error instanceof PositionConstraintError || error instanceof RedeemError) return error.message
  const chainError = toChainError(error)
  if (chainError.code === 'Unknown') return `The transaction failed: ${chainError.message}`
  return MESSAGES[chainError.code]
}
