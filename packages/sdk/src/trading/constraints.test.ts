import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertPositionConstraint,
  checkPositionConstraint,
  PositionConstraintError,
} from './index.js'

function blockedError(result: ReturnType<typeof checkPositionConstraint>): PositionConstraintError {
  assert.equal(result.allowed, false)
  if (result.allowed) throw new Error('unreachable')
  assert.ok(result.error instanceof PositionConstraintError)
  return result.error
}

describe('R28 position constraint', () => {
  it('blocks Buy Yes while the wallet holds No and offers Sell No', () => {
    const error = blockedError(checkPositionConstraint('BuyYes', { yes: 0, no: 3 }))
    assert.equal(error.code, 'HOLDS_NO')
    assert.equal(error.exitAction, 'SellNo')
    assert.match(error.message, /Sell No/)
  })

  it('blocks Buy No while the wallet holds Yes and offers Sell Yes', () => {
    const error = blockedError(checkPositionConstraint('BuyNo', { yes: 2, no: 0 }))
    assert.equal(error.code, 'HOLDS_YES')
    assert.equal(error.exitAction, 'SellYes')
    assert.match(error.message, /Sell Yes/)
  })

  it('allows buying the side already held, and selling it', () => {
    assert.deepEqual(checkPositionConstraint('BuyYes', { yes: 2, no: 0 }), { allowed: true })
    assert.deepEqual(checkPositionConstraint('BuyNo', { yes: 0, no: 2 }), { allowed: true })
    assert.deepEqual(checkPositionConstraint('SellYes', { yes: 2, no: 0 }), { allowed: true })
    assert.deepEqual(checkPositionConstraint('SellNo', { yes: 0, no: 2 }), { allowed: true })
  })

  it('allows every trade for a flat wallet', () => {
    const actions = ['BuyYes', 'SellYes', 'BuyNo', 'SellNo'] as const
    actions.forEach((action) => {
      assert.deepEqual(checkPositionConstraint(action, { yes: 0, no: 0 }), { allowed: true })
    })
  })

  it('lets a wallet holding both through a resting Buy No limit cancel and close out', () => {
    const both = { yes: 5, no: 5 }
    assert.deepEqual(checkPositionConstraint('Cancel', both), { allowed: true })
    assert.deepEqual(checkPositionConstraint('CloseOut', both), { allowed: true })
    assert.equal(checkPositionConstraint('BuyYes', both).allowed, false)
    assert.equal(checkPositionConstraint('BuyNo', both).allowed, false)
  })

  it('assertPositionConstraint throws the same typed error the builders use', () => {
    assert.throws(
      () => assertPositionConstraint('BuyYes', { yes: 0, no: 1 }),
      (error: unknown) =>
        error instanceof PositionConstraintError &&
        error.code === 'HOLDS_NO' &&
        error.exitAction === 'SellNo',
    )
    assert.doesNotThrow(() => assertPositionConstraint('CloseOut', { yes: 1, no: 1 }))
  })
})
