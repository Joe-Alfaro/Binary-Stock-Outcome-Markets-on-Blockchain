import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ProgramEvent } from '@meridian/sdk'
import { PortfolioPage } from '../src/components'
import { assertNoAxeViolations } from './support/axe'
import { OTHER_WALLET, WALLET } from './support/fake-chain'
import { contract, fill, mint, REGULAR_NOW } from './support/fixtures'
import { createHarness, renderWith } from './support/render'
import type { Harness } from './support/render'

afterEach(cleanup)

const OPEN = 'aapl-230'
const SETTLED = 'aapl-225'

function setup(): Harness {
  const harness = createHarness({ now: REGULAR_NOW, connected: true })
  harness.chain.markets = [
    contract({ market: OPEN, strike: 230, yesPriceCents: 55 }),
    contract({
      market: SETTLED,
      strike: 225,
      status: 'Settled',
      yesPriceCents: 62,
      settlement: { price: 231.42, source: 'Oracle', outcome: 'Yes' },
    }),
  ]
  const settled: ProgramEvent = {
    kind: 'MarketSettled',
    signature: 's-settle',
    ts: REGULAR_NOW,
    market: SETTLED,
    outcome: 'Yes',
  }
  harness.chain.events = [
    // Buy No 10 against a Yes bid of 0.60: entry 0.40; the Yes mark of 0.55 makes the No mark 0.45.
    mint(OPEN, 's1', WALLET, 10),
    fill(OPEN, 's1', OTHER_WALLET, WALLET, 'Ask', 60, 10),
    // Buy Yes 5 at 0.70 as taker, then 2 more at 0.70 as a resting bid filled in someone else's tx.
    fill(SETTLED, 's2', OTHER_WALLET, WALLET, 'Bid', 70, 5),
    fill(SETTLED, 's3', WALLET, OTHER_WALLET, 'Ask', 70, 2),
    settled,
  ]
  return harness
}

function cellsOf(row: HTMLElement): string[] {
  return within(row)
    .queryAllByRole('cell')
    .concat(within(row).queryAllByRole('rowheader'))
    .map((cell) => cell.textContent?.trim() ?? '')
}

async function rowFor(tableName: RegExp, ...texts: string[]): Promise<HTMLElement> {
  const table = await screen.findByRole('table', { name: tableName })
  const row = within(table)
    .getAllByRole('row')
    .find((r) => texts.every((text) => cellsOf(r).includes(text)))
  assert.ok(row, `no row in ${tableName} with ${texts.join(', ')}`)
  return row
}

function hasCell(row: HTMLElement, ...options: string[]): boolean {
  return cellsOf(row).some((text) => options.includes(text))
}

describe('R52 positions', () => {
  it('shows entry price, current price and P&L, with No entry at $1.00 minus the Yes sale', async () => {
    renderWith(setup(), <PortfolioPage />)
    const row = await rowFor(/^positions$/i, 'AAPL $230.00', 'No')
    assert.ok(hasCell(row, '10'), 'quantity')
    assert.ok(hasCell(row, '$0.40'), 'entry price')
    assert.ok(hasCell(row, '$0.45'), 'current price')
    assert.ok(hasCell(row, '+$0.50'), 'P&L')
  })

  it('values a settled winner at $1.00 and shows the settlement price and source', async () => {
    renderWith(setup(), <PortfolioPage />)
    const row = await rowFor(/^positions$/i, 'AAPL $225.00', 'Yes')
    assert.ok(hasCell(row, '7'), 'quantity')
    assert.ok(hasCell(row, '$0.70'), 'entry price')
    assert.ok(hasCell(row, '$1.00'), 'current price')
    assert.ok(hasCell(row, '+$2.10'), 'P&L')
    assert.match(row.textContent ?? '', /settled at \$231\.42/i)
    assert.match(row.textContent ?? '', /oracle/i)
  })

  it('offers Redeem only on settled positions', async () => {
    renderWith(setup(), <PortfolioPage />)
    const open = await rowFor(/^positions$/i, 'AAPL $230.00', 'No')
    assert.equal(within(open).queryByRole('button', { name: /redeem/i }), null)
    const settled = await rowFor(/^positions$/i, 'AAPL $225.00', 'Yes')
    assert.ok(within(settled).getByRole('button', { name: /^redeem$/i }))
  })

  it('Redeem signs once and confirms at confirmed', async () => {
    const harness = setup()
    const user = userEvent.setup()
    renderWith(harness, <PortfolioPage />)
    const row = await rowFor(/^positions$/i, 'AAPL $225.00', 'Yes')
    await user.click(within(row).getByRole('button', { name: /^redeem$/i }))

    await waitFor(() => assert.equal(harness.chain.calls.sendAndConfirm.length, 1))
    assert.deepEqual(harness.chain.calls.buildRedeem, [{ market: SETTLED, owner: WALLET }])
    assert.equal(harness.wallet.signPrompts, 1)
    assert.equal(harness.chain.calls.sendAndConfirm[0]?.commitment, 'confirmed')
  })

  it('close out orders and redeem is one transaction and one signature', async () => {
    const harness = setup()
    const user = userEvent.setup()
    renderWith(harness, <PortfolioPage />)
    const row = await rowFor(/^positions$/i, 'AAPL $225.00', 'Yes')
    await user.click(within(row).getByRole('button', { name: /close out orders and redeem/i }))

    await waitFor(() => assert.equal(harness.chain.calls.sendAndConfirm.length, 1))
    assert.deepEqual(harness.chain.calls.buildCloseOutAndRedeem, [
      { market: SETTLED, owner: WALLET },
    ])
    assert.deepEqual(harness.chain.calls.buildRedeem, [])
    assert.equal(harness.wallet.signPrompts, 1)
  })

  it('a split close-out signs and confirms each transaction in order', async () => {
    const harness = setup()
    harness.chain.closeOutTransactions = 2
    const user = userEvent.setup()
    renderWith(harness, <PortfolioPage />)
    const row = await rowFor(/^positions$/i, 'AAPL $225.00', 'Yes')
    await user.click(within(row).getByRole('button', { name: /close out orders and redeem/i }))

    assert.ok(await screen.findByText(/close out and redeem confirmed/i))
    assert.equal(harness.wallet.signPrompts, 2)
    assert.deepEqual(
      harness.chain.calls.sendAndConfirm.map(
        ({ tx }) => (tx.raw as { signed: { part: number } }).signed.part,
      ),
      [0, 1],
    )
  })

  it('asks to connect a wallet when none is connected', async () => {
    const harness = setup()
    harness.wallet.publicKey = null
    renderWith(harness, <PortfolioPage />)
    assert.ok(await screen.findByText(/connect your wallet/i))
    assert.equal(screen.queryByRole('table', { name: /^positions$/i }), null)
  })
})

describe('R52 market-maker view', () => {
  it('shows net Yes and No per strike, fills and P&L', async () => {
    renderWith(setup(), <PortfolioPage />)
    const open = await rowFor(/^market maker/i, 'AAPL $230.00')
    assert.ok(hasCell(open, '-10', '−10'), 'net Yes')
    assert.ok(hasCell(open, '+$0.50'), 'P&L')

    const settled = await rowFor(/^market maker/i, 'AAPL $225.00')
    const cells = cellsOf(settled)
    assert.ok(cells.includes('7'), 'Yes held and net Yes')
    assert.ok(cells.includes('2'), 'fills')
    assert.ok(cells.includes('1'), 'maker fills')
    assert.ok(cells.includes('+$2.10'), 'P&L')
  })
})

describe('R56 portfolio accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = renderWith(setup(), <PortfolioPage />)
    await screen.findByRole('table', { name: /^positions$/i })
    await assertNoAxeViolations(container)
  })
})
