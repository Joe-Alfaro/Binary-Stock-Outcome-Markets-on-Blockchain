import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WalletButton } from '../src/components'
import { assertNoAxeViolations } from './support/axe'
import { WALLET } from './support/fake-chain'
import { REGULAR_NOW } from './support/fixtures'
import { createHarness, renderWith } from './support/render'

afterEach(cleanup)

describe('R48 wallet', () => {
  it('connects through the chosen adapter and shows the USDC balance', async () => {
    const harness = createHarness({ now: REGULAR_NOW })
    harness.chain.usdcBalance = 1_234_560_000
    const user = userEvent.setup()
    renderWith(harness, <WalletButton />)

    await user.click(screen.getByRole('button', { name: /connect wallet/i }))
    assert.ok(screen.getByRole('button', { name: 'Solflare' }))
    await user.click(screen.getByRole('button', { name: 'Phantom' }))

    assert.equal(harness.wallet.connectedWith, 'Phantom')
    assert.ok(await screen.findByText(/1,234\.56 USDC/))
    assert.deepEqual(harness.chain.calls.getUsdcBalance, [WALLET])
  })

  it('disconnects and offers to connect again', async () => {
    const harness = createHarness({ now: REGULAR_NOW, connected: true })
    harness.chain.usdcBalance = 5_000_000
    const user = userEvent.setup()
    renderWith(harness, <WalletButton />)

    assert.ok(await screen.findByText(/5\.00 USDC/))
    await user.click(screen.getByRole('button', { name: /disconnect/i }))

    assert.equal(harness.wallet.disconnects, 1)
    assert.ok(await screen.findByRole('button', { name: /connect wallet/i }))
    assert.equal(screen.queryByText(/USDC/), null)
  })
})

describe('R56 wallet accessibility', () => {
  it('the wallet picker has no axe violations', async () => {
    const harness = createHarness({ now: REGULAR_NOW })
    const user = userEvent.setup()
    const { container } = renderWith(harness, <WalletButton />)
    await user.click(screen.getByRole('button', { name: /connect wallet/i }))
    await screen.findByRole('button', { name: 'Phantom' })
    await assertNoAxeViolations(container)
  })
})
