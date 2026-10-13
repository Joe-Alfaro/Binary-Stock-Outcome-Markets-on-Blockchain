import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { PositionConstraintError } from '@meridian/sdk'
import { ChainError, toChainError, tradeErrorMessage } from '../../src/lib/chain'

function walletRejection(): Error {
  const error = new Error('User rejected the request.')
  error.name = 'WalletSignTransactionError'
  return error
}

/** The shape `@solana/web3.js` gives a failed preflight: the message plus the program logs. */
function programFailure(logs: string[]): Error & { logs: string[] } {
  return Object.assign(new Error('Simulation failed.'), { logs })
}

function anchorLog(name: string, number: number): string {
  return `Program log: AnchorError occurred. Error Code: ${name}. Error Number: ${number}. Error Message: x.`
}

describe('R54 classifying failures', () => {
  it('a declined wallet prompt is SignatureRejected', () => {
    assert.equal(toChainError(walletRejection()).code, 'SignatureRejected')
  })

  it('an SPL token insufficient-funds failure is InsufficientUsdc', () => {
    const error = programFailure([
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]',
      'Program log: Error: insufficient funds',
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1',
    ])
    assert.equal(toChainError(error).code, 'InsufficientUsdc')
  })

  it('the Paused program error is Paused', () => {
    assert.equal(toChainError(programFailure([anchorLog('Paused', 6002)])).code, 'Paused')
  })

  it('MarketClosed and MarketSettled program errors are MarketClosed', () => {
    assert.equal(
      toChainError(programFailure([anchorLog('MarketClosed', 6004)])).code,
      'MarketClosed',
    )
    assert.equal(
      toChainError(programFailure([anchorLog('MarketSettled', 6005)])).code,
      'MarketClosed',
    )
  })

  it('passes a ChainError through and calls anything else Unknown', () => {
    const known = new ChainError('Paused')
    assert.equal(toChainError(known), known)
    assert.equal(toChainError(new Error('socket hang up')).code, 'Unknown')
  })
})

describe('R54 error messages', () => {
  it('explains each failure in plain words', () => {
    assert.match(tradeErrorMessage(walletRejection()), /rejected the signature/i)
    assert.match(tradeErrorMessage(new ChainError('InsufficientUsdc')), /not enough USDC/i)
    assert.match(tradeErrorMessage(new ChainError('Paused')), /trading is paused/i)
    assert.match(tradeErrorMessage(new ChainError('MarketClosed')), /market is closed/i)
  })

  it('shows the SDK message for a position constraint block', () => {
    const error = new PositionConstraintError(
      'HOLDS_NO',
      'SellNo',
      'You hold No for this strike. Sell No before buying Yes.',
    )
    assert.equal(
      tradeErrorMessage(error),
      'You hold No for this strike. Sell No before buying Yes.',
    )
  })
})
