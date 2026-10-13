import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WalletButton } from '../src/components'
import { useTransaction } from '../src/lib/hooks'
import { FakeChain, WALLET } from './support/fake-chain'
import { REGULAR_NOW } from './support/fixtures'
import { createHarness, renderWith } from './support/render'

afterEach(cleanup)

/** Sends one redeem through `useTransaction`, as the Portfolio page does. */
function RedeemButton() {
  const { run } = useTransaction()
  return (
    <button type="button" onClick={() => run('Redeem', async () => ({ raw: { kind: 'redeem' } }))}>
      Redeem
    </button>
  )
}

/** `FakeChain` with the optional token-account subscription. */
class SubscribingChain extends FakeChain {
  usdcListeners = new Set<() => void>()
  subscribeUsdcBalance(owner: string, onChange: () => void) {
    void owner
    this.usdcListeners.add(onChange)
    return () => this.usdcListeners.delete(onChange)
  }
}

describe('R48 wallet balance stays current', () => {
  it('re-reads the header balance after a confirmed transaction', async () => {
    const harness = createHarness({ now: REGULAR_NOW, connected: true })
    harness.chain.usdcBalance = 5_000_000
    const user = userEvent.setup()
    renderWith(
      harness,
      <>
        <WalletButton />
        <RedeemButton />
      </>,
    )
    assert.ok(await screen.findByText(/5\.00 USDC/))

    harness.chain.usdcBalance = 12_000_000
    await user.click(screen.getByRole('button', { name: 'Redeem' }))

    assert.ok(await screen.findByText(/12\.00 USDC/))
    assert.deepEqual(harness.chain.calls.getUsdcBalance, [WALLET, WALLET])
  })

  it('re-reads the header balance when the USDC account subscription reports a change', async () => {
    const harness = createHarness({ now: REGULAR_NOW, connected: true })
    const chain = new SubscribingChain()
    harness.chain = chain
    chain.usdcBalance = 5_000_000
    renderWith(harness, <WalletButton />)
    assert.ok(await screen.findByText(/5\.00 USDC/))
    assert.equal(chain.usdcListeners.size, 1)

    chain.usdcBalance = 7_500_000
    chain.usdcListeners.forEach((listener) => listener())

    assert.ok(await screen.findByText(/7\.50 USDC/))
    cleanup()
    assert.equal(chain.usdcListeners.size, 0)
  })
})
