import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as sdk from '@meridian/sdk'
import { appChainConfig } from '../../src/lib/app-services'

describe('app services', () => {
  it('give the chain client the SDK trade builders', () => {
    const builders = appChainConfig().builders
    assert.ok(builders, 'no builders configured')
    assert.equal(builders.buildBuyYesTransaction, sdk.buildBuyYesTransaction)
    assert.equal(builders.buildSellYesTransaction, sdk.buildSellYesTransaction)
    assert.equal(builders.buildBuyNoTransaction, sdk.buildBuyNoTransaction)
    assert.equal(builders.buildSellNoTransaction, sdk.buildSellNoTransaction)
  })

  it('give the chain client the SDK redeem and close-out builders', () => {
    const builders = appChainConfig().builders
    assert.ok(builders, 'no builders configured')
    assert.equal(builders.buildRedeem, sdk.buildRedeem)
    assert.equal(builders.buildCloseOutAndRedeem, sdk.buildCloseOutAndRedeem)
  })
})
