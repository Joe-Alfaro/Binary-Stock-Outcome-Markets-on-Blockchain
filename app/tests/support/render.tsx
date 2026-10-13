import { render } from '@testing-library/react'
import type { ReactElement } from 'react'
import { ServicesProvider } from '../../src/lib/services'
import { FakeChain, FakeWallet, WALLET } from './fake-chain'

export interface Harness {
  chain: FakeChain
  wallet: FakeWallet
  /** Unix seconds returned by `services.now()`; tests may move it. */
  clock: { now: number }
}

export function createHarness(options: { now: number; connected?: boolean }): Harness {
  return {
    chain: new FakeChain(),
    wallet: new FakeWallet(options.connected ? WALLET : null),
    clock: { now: options.now },
  }
}

export function renderWith(harness: Harness, ui: ReactElement) {
  const services = { chain: harness.chain, wallet: harness.wallet, now: () => harness.clock.now }
  return render(<ServicesProvider services={services}>{ui}</ServicesProvider>)
}
