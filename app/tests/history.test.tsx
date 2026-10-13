import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { cleanup, screen, within } from '@testing-library/react'
import type { ProgramEvent } from '@meridian/sdk'
import { HistoryPage } from '../src/components'
import { OTHER_WALLET, WALLET } from './support/fake-chain'
import { contract, fill, merge, mint, REGULAR_NOW } from './support/fixtures'
import { createHarness, renderWith } from './support/render'

afterEach(cleanup)

const MKT = 'aapl-230'
const THIRD = 'Hs7dLq2Wn5vXc9tRk4pYm1bJf8gAe3uTo6iNz2wQr5Ma'

function setup() {
  const harness = createHarness({ now: REGULAR_NOW, connected: true })
  harness.chain.markets = [contract({ market: MKT, strike: 230 })]
  const redeemed: ProgramEvent = {
    kind: 'Redeemed',
    signature: 's-redeem',
    ts: REGULAR_NOW,
    market: MKT,
    owner: WALLET,
    yesQty: 4,
    noQty: 0,
  }
  harness.chain.events = [
    mint(MKT, 's-mint', WALLET, 10),
    fill(MKT, 's-taker', OTHER_WALLET, WALLET, 'Bid', 61, 6),
    // A resting order of ours filled inside another wallet's transaction.
    fill(MKT, 's-their-tx', WALLET, OTHER_WALLET, 'Bid', 64, 3),
    // Neither side is us.
    fill(MKT, 's-unrelated', OTHER_WALLET, THIRD, 'Ask', 50, 9),
    merge(MKT, 's-merge', WALLET, 2),
    redeemed,
  ]
  return harness
}

/**
 * Cell texts of each body row. Expected columns: type (`Fill`, `Mint`, `Merge` or `Redeem`), contract,
 * role (`Maker` or `Taker`, fills only), Yes price, quantity and time.
 */
async function rows(): Promise<string[][]> {
  const table = await screen.findByRole('table', { name: /history/i })
  return within(table)
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('columnheader').length === 0)
    .map((row) =>
      within(row)
        .queryAllByRole('cell')
        .concat(within(row).queryAllByRole('rowheader'))
        .map((cell) => cell.textContent?.trim() ?? ''),
    )
}

function find(all: string[][], ...cells: (string | RegExp)[]): string[] | undefined {
  return all.find((row) =>
    cells.every((want) =>
      row.some((text) => (typeof want === 'string' ? text === want : want.test(text))),
    ),
  )
}

describe('R53 history', () => {
  it('lists fills, mints, merges and redemptions decoded from program events', async () => {
    renderWith(setup(), <HistoryPage />)
    const all = await rows()
    assert.equal(all.length, 5, JSON.stringify(all))
    assert.ok(find(all, /^mint$/i, '10'), 'mint')
    assert.ok(find(all, /^merge$/i, '2'), 'merge')
    assert.ok(find(all, /^redeem$/i, '4'), 'redeem')
    all.forEach((row) => assert.ok(row.includes('AAPL $230.00'), JSON.stringify(row)))
  })

  it("shows a maker fill that landed in another wallet's transaction", async () => {
    renderWith(setup(), <HistoryPage />)
    const all = await rows()
    assert.ok(find(all, /^fill$/i, /^maker$/i, '64¢', '3'), 'maker fill row')
    assert.ok(find(all, /^fill$/i, /^taker$/i, '61¢', '6'), 'taker fill row')
  })

  it('leaves out fills between other wallets', async () => {
    renderWith(setup(), <HistoryPage />)
    const all = await rows()
    assert.equal(find(all, '50¢'), undefined)
  })
})
