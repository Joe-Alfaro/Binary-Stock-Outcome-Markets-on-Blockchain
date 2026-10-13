import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { noView } from '@meridian/sdk'
// The same fixture the SDK's R29 test checks, so the rendered views and the mapping can't drift.
import { yesBookFixture } from '../../packages/sdk/src/trading/fixtures/yes-book'
import type { BookLevel, YesBook } from '@meridian/sdk'
import { TradePage } from '../src/components'
import { ChainError } from '../src/lib/chain'
import type { ChainErrorCode } from '../src/lib/chain'
import { assertNoAxeViolations } from './support/axe'
import { WALLET } from './support/fake-chain'
import { contract, EARLY_CLOSE, EARLY_NOW, REGULAR_CLOSE, REGULAR_NOW } from './support/fixtures'
import { createHarness, renderWith } from './support/render'
import type { Harness } from './support/render'

afterEach(cleanup)

const MARKET = 'aapl-230'

function setup(options: { now?: number } = {}): Harness {
  const harness = createHarness({ now: options.now ?? REGULAR_NOW, connected: true })
  harness.chain.markets = [
    contract({ market: 'aapl-225', strike: 225, yesPriceCents: 81 }),
    contract({ market: MARKET, strike: 230, yesPriceCents: 62 }),
    contract({ market: 'aapl-235', strike: 235, yesPriceCents: 37 }),
  ]
  harness.chain.books.set(MARKET, yesBookFixture)
  harness.chain.usdcBalance = 100_000_000
  return harness
}

type User = ReturnType<typeof userEvent.setup>

async function card(strike: string) {
  return screen.findByRole('article', { name: `AAPL ${strike}` })
}

async function selectStrike(user: User, strike: string) {
  await user.click(within(await card(strike)).getByRole('button', { name: /trade/i }))
}

async function fillOrder(
  user: User,
  order: { action: string; type: 'Market' | 'Limit'; qty: number; limit?: number },
) {
  await user.click(screen.getByRole('radio', { name: order.action }))
  await user.click(screen.getByRole('radio', { name: order.type }))
  await user.clear(screen.getByRole('spinbutton', { name: /quantity/i }))
  await user.type(screen.getByRole('spinbutton', { name: /quantity/i }), String(order.qty))
  if (order.limit !== undefined) {
    await user.clear(screen.getByRole('spinbutton', { name: /limit price/i }))
    await user.type(screen.getByRole('spinbutton', { name: /limit price/i }), String(order.limit))
  }
}

/** Cell texts of each body row, for a book table with Side, Price and Quantity columns. */
function bookRows(table: HTMLElement): string[][] {
  return within(table)
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('columnheader').length === 0)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent?.trim() ?? ''),
    )
}

function levelsOf(rows: string[][], side: 'Bid' | 'Ask'): BookLevel[] {
  return rows
    .filter((cells) => cells.some((text) => text === side))
    .map((cells) => {
      const price = cells.find((text) => /^\d+¢$/.test(text)) ?? ''
      const qty = cells.find((text) => /^\d+$/.test(text)) ?? ''
      return { priceCents: Number.parseInt(price, 10), qty: Number(qty) }
    })
}

function sortedYes(book: YesBook) {
  return {
    bids: [...book.bids].sort((a, b) => b.priceCents - a.priceCents),
    asks: [...book.asks].sort((a, b) => a.priceCents - b.priceCents),
  }
}

async function bookTables(strike: string) {
  const user = userEvent.setup()
  await selectStrike(user, strike)
  return {
    yes: await screen.findByRole('table', { name: /yes order book/i }),
    no: await screen.findByRole('table', { name: /no order book/i }),
  }
}

describe('R51 contract cards', () => {
  it('shows each strike with Yes and No prices and the implied probability', async () => {
    renderWith(setup(), <TradePage ticker="AAPL" />)
    const strike230 = await card('$230.00')
    const text = strike230.textContent ?? ''
    assert.match(text, /Yes\D*62¢/)
    assert.match(text, /No\D*38¢/)
    assert.match(text, /62%/)
    assert.ok(await card('$225.00'))
    assert.ok(await card('$235.00'))
  })

  it('a settled card shows the price, its source, the winner and $1.00 / $0.00 per token', async () => {
    const harness = setup({ now: REGULAR_CLOSE + 3600 })
    harness.chain.markets = [
      contract({
        market: MARKET,
        strike: 230,
        status: 'Settled',
        settlement: { price: 231.42, source: 'Oracle', outcome: 'Yes' },
      }),
      contract({
        market: 'aapl-235',
        strike: 235,
        status: 'Settled',
        settlement: { price: 231.42, source: 'Admin', outcome: 'No' },
      }),
    ]
    renderWith(harness, <TradePage ticker="AAPL" />)

    const won = (await card('$230.00')).textContent ?? ''
    assert.match(won, /settled at \$231\.42/i)
    assert.match(won, /source: oracle/i)
    assert.match(won, /yes wins/i)
    assert.match(won, /yes pays \$1\.00/i)
    assert.match(won, /no pays \$0\.00/i)

    const lost = (await card('$235.00')).textContent ?? ''
    assert.match(lost, /source: admin/i)
    assert.match(lost, /no wins/i)
    assert.match(lost, /yes pays \$0\.00/i)
    assert.match(lost, /no pays \$1\.00/i)
  })
})

describe('R44 demo badge', () => {
  it('shows "Demo market" on demo markets only', async () => {
    const harness = setup()
    harness.chain.markets = [contract({ market: MARKET, strike: 230, demo: true })]
    renderWith(harness, <TradePage ticker="AAPL" />)
    assert.ok(await screen.findByText('Demo market'))
    cleanup()

    renderWith(setup(), <TradePage ticker="AAPL" />)
    await card('$230.00')
    assert.equal(screen.queryByText('Demo market'), null)
  })
})

describe('R51 / R29 order book views from one book', () => {
  it('the Yes view lists the Yes book best-first', async () => {
    renderWith(setup(), <TradePage ticker="AAPL" />)
    const { yes } = await bookTables('$230.00')
    const expected = sortedYes(yesBookFixture)
    const rows = bookRows(yes)
    assert.deepEqual(levelsOf(rows, 'Bid'), expected.bids)
    assert.deepEqual(levelsOf(rows, 'Ask'), expected.asks)
  })

  it('the No view is 100 minus the Yes book with the same quantities', async () => {
    renderWith(setup(), <TradePage ticker="AAPL" />)
    const { no } = await bookTables('$230.00')
    const expected = noView(yesBookFixture)
    const rows = bookRows(no)
    assert.deepEqual(levelsOf(rows, 'Bid'), expected.bids)
    assert.deepEqual(levelsOf(rows, 'Ask'), expected.asks)
  })
})

describe('R22 real-time book', () => {
  const withNewBid: YesBook = {
    bids: [...yesBookFixture.bids, { priceCents: 62, qty: 7 }],
    asks: yesBookFixture.asks,
  }

  it("shows another wallet's new order within 2 s through the account subscription", async () => {
    const harness = setup()
    renderWith(harness, <TradePage ticker="AAPL" />)
    const { yes, no } = await bookTables('$230.00')

    harness.chain.pushBook(MARKET, withNewBid)

    await waitFor(
      () => assert.deepEqual(levelsOf(bookRows(yes), 'Bid')[0], { priceCents: 62, qty: 7 }),
      { timeout: 2000 },
    )
    assert.deepEqual(levelsOf(bookRows(no), 'Ask')[0], { priceCents: 38, qty: 7 })
  })

  it('falls back to polling when the subscription fails, still within 2 s', async () => {
    const harness = setup()
    harness.chain.failBookSubscriptions = true
    renderWith(harness, <TradePage ticker="AAPL" />)
    const { yes } = await bookTables('$230.00')

    // The order lands on-chain, but no subscription will report it.
    harness.chain.books.set(MARKET, withNewBid)

    await waitFor(
      () => assert.deepEqual(levelsOf(bookRows(yes), 'Bid')[0], { priceCents: 62, qty: 7 }),
      { timeout: 2000 },
    )
  })
})

describe('R51 countdown in ET', () => {
  it('counts down to a regular 4:00 PM ET close', async () => {
    renderWith(setup(), <TradePage ticker="AAPL" />)
    assert.ok((await screen.findAllByText(/4:00\sPM ET/)).length > 0)
    assert.ok(screen.getAllByText(/5h 40m 00s/).length > 0)
  })

  it('honors an early close and ignores the browser time zone', async (t) => {
    const original = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    t.after(() => {
      process.env.TZ = original
    })
    const harness = setup({ now: EARLY_NOW })
    harness.chain.markets = [contract({ market: MARKET, strike: 230, closeTs: EARLY_CLOSE })]
    renderWith(harness, <TradePage ticker="AAPL" />)

    assert.ok((await screen.findAllByText(/1:00\sPM ET/)).length > 0)
    assert.ok(screen.getAllByText(/2h 00m 00s/).length > 0)
  })

  it('ticks every second', async () => {
    const harness = setup()
    renderWith(harness, <TradePage ticker="AAPL" />)
    await screen.findAllByText(/5h 40m 00s/)
    harness.clock.now += 1
    assert.ok((await screen.findAllByText(/5h 39m 59s/, undefined, { timeout: 1500 })).length > 0)
  })
})

describe('R51 trade panel and payoff text', () => {
  it('offers the four actions, each with market or limit', async () => {
    renderWith(setup(), <TradePage ticker="AAPL" />)
    await selectStrike(userEvent.setup(), '$230.00')
    ;['Buy Yes', 'Sell Yes', 'Buy No', 'Sell No', 'Market', 'Limit'].forEach((name) =>
      assert.ok(screen.getByRole('radio', { name }), name),
    )
  })

  it('a market Buy Yes pays the best Yes ask, with the at-strike note', async () => {
    const user = userEvent.setup()
    renderWith(setup(), <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await fillOrder(user, { action: 'Buy Yes', type: 'Market', qty: 10 })

    assert.ok(screen.getByText('You pay $0.65. You win $1.00 if AAPL closes above $230.00.'))
    assert.ok(
      screen.getAllByText('If AAPL closes exactly at $230.00, the contract pays Yes.').length > 0,
    )
  })

  it('a market Buy No pays 100 minus the best Yes bid and reads "closes below"', async () => {
    const user = userEvent.setup()
    renderWith(setup(), <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await fillOrder(user, { action: 'Buy No', type: 'Market', qty: 10 })

    assert.ok(screen.getByText('You pay $0.40. You win $1.00 if AAPL closes below $230.00.'))
    assert.ok(
      screen.getAllByText('If AAPL closes exactly at $230.00, the contract pays Yes.').length > 0,
    )
  })

  it('a limit order pays the limit price', async () => {
    const user = userEvent.setup()
    renderWith(setup(), <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await fillOrder(user, { action: 'Buy Yes', type: 'Limit', qty: 4, limit: 63 })

    assert.ok(screen.getByText('You pay $0.63. You win $1.00 if AAPL closes above $230.00.'))
  })

  const intents = [
    { action: 'Buy Yes', path: 'BuyYes', type: 'Market', priceCents: 65 },
    { action: 'Sell Yes', path: 'SellYes', type: 'Market', priceCents: 60 },
    { action: 'Buy No', path: 'BuyNo', type: 'Market', priceCents: 40 },
    { action: 'Sell No', path: 'SellNo', type: 'Market', priceCents: 35 },
    { action: 'Buy No', path: 'BuyNo', type: 'Limit', priceCents: 41, limit: 41 },
    { action: 'Sell Yes', path: 'SellYes', type: 'Limit', priceCents: 66, limit: 66 },
  ] as const

  intents.forEach((c) => {
    it(`${c.type} ${c.action} builds the matching trade intent`, async () => {
      const harness = setup()
      if (c.action.startsWith('Sell')) {
        harness.chain.holdings.set(
          MARKET,
          c.action === 'Sell Yes' ? { yes: 20, no: 0 } : { yes: 0, no: 20 },
        )
      }
      const user = userEvent.setup()
      renderWith(harness, <TradePage ticker="AAPL" />)
      await selectStrike(user, '$230.00')
      await fillOrder(user, {
        action: c.action,
        type: c.type,
        qty: 10,
        limit: 'limit' in c ? c.limit : undefined,
      })
      await user.click(screen.getByRole('button', { name: /place order/i }))

      await waitFor(() => assert.equal(harness.chain.calls.buildTrade.length, 1))
      assert.deepEqual(harness.chain.calls.buildTrade[0], {
        market: MARKET,
        owner: WALLET,
        action: c.path,
        orderType: c.type,
        qty: 10,
        priceCents: c.priceCents,
      })
    })
  })
})

describe('R54 / R55 signing', () => {
  async function placeBuyYes(harness: Harness) {
    const user = userEvent.setup()
    renderWith(harness, <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await fillOrder(user, { action: 'Buy Yes', type: 'Market', qty: 10 })
    await user.click(screen.getByRole('button', { name: /place order/i }))
  }

  it('prompts exactly one signature per trade and confirms at confirmed', async () => {
    const harness = setup()
    await placeBuyYes(harness)

    await waitFor(() => assert.match(screen.getByRole('status').textContent ?? '', /confirmed/i))
    assert.equal(harness.wallet.signPrompts, 1)
    assert.equal(harness.chain.calls.buildTrade.length, 1)
    assert.equal(harness.chain.calls.sendAndConfirm.length, 1)
    assert.equal(harness.chain.calls.sendAndConfirm[0]?.commitment, 'confirmed')
  })

  it('explains a rejected signature and sends nothing', async () => {
    const harness = setup()
    harness.wallet.rejectNextSign = true
    await placeBuyYes(harness)

    assert.match((await screen.findByRole('alert')).textContent ?? '', /rejected the signature/i)
    assert.equal(harness.wallet.signPrompts, 1)
    assert.equal(harness.chain.calls.sendAndConfirm.length, 0)
  })

  const failures: { code: ChainErrorCode; message: RegExp }[] = [
    { code: 'InsufficientUsdc', message: /not enough USDC/i },
    { code: 'Paused', message: /trading is paused/i },
    { code: 'MarketClosed', message: /market is closed/i },
  ]

  failures.forEach(({ code, message }) => {
    it(`explains ${code}`, async () => {
      const harness = setup()
      harness.chain.sendError = new ChainError(code)
      await placeBuyYes(harness)

      assert.match((await screen.findByRole('alert')).textContent ?? '', message)
      assert.equal(harness.wallet.signPrompts, 1)
    })
  })

  it('blocks Buy Yes while holding No, says why and offers Sell No, without a prompt', async () => {
    const harness = setup()
    harness.chain.holdings.set(MARKET, { yes: 0, no: 5 })
    const user = userEvent.setup()
    renderWith(harness, <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await fillOrder(user, { action: 'Buy Yes', type: 'Market', qty: 10 })

    const alert = await screen.findByRole('alert')
    assert.equal(
      alert.textContent?.includes('You hold No for this strike. Sell No before buying Yes.'),
      true,
    )
    const place = screen.getByRole('button', { name: /place order/i }) as HTMLButtonElement
    assert.equal(place.disabled, true)

    await user.click(within(alert).getByRole('button', { name: 'Sell No' }))
    assert.equal((screen.getByRole('radio', { name: 'Sell No' }) as HTMLInputElement).checked, true)
    assert.equal(harness.wallet.signPrompts, 0)
  })

  it('blocks Buy No while holding Yes and offers Sell Yes', async () => {
    const harness = setup()
    harness.chain.holdings.set(MARKET, { yes: 3, no: 0 })
    const user = userEvent.setup()
    renderWith(harness, <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await fillOrder(user, { action: 'Buy No', type: 'Market', qty: 10 })

    const alert = await screen.findByRole('alert')
    assert.equal(
      alert.textContent?.includes('You hold Yes for this strike. Sell Yes before buying No.'),
      true,
    )
    assert.ok(within(alert).getByRole('button', { name: 'Sell Yes' }))
  })
})

describe('R56 trade page accessibility', () => {
  it('the trade form has no axe violations', async () => {
    const user = userEvent.setup()
    const { container } = renderWith(setup(), <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await fillOrder(user, { action: 'Buy No', type: 'Limit', qty: 2, limit: 41 })
    await assertNoAxeViolations(container)
  })
})

describe('R28 [G] unwind a resting Buy No before settlement', () => {
  /**
   * The wallet started with $100, minted 5 pairs for a Buy No 5 limit at 41¢, and the Yes leg
   * rests as an ask at 59¢. It holds 5 No and 5 Yes (in escrow): both sides of one strike.
   */
  function hedged(): Harness {
    const harness = setup()
    harness.chain.usdcBalance = 95_000_000
    harness.chain.holdings.set(MARKET, { yes: 5, no: 5 })
    harness.chain.openOrders.set(MARKET, [{ orderId: '7', side: 'Ask', priceCents: 59, qty: 5 }])
    return harness
  }

  async function openHedged(harness: Harness) {
    const user = userEvent.setup()
    renderWith(harness, <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await screen.findByText('You hold 5 Yes and 5 No for this strike.')
    return user
  }

  async function expectClosedOut() {
    assert.ok(await screen.findByText('You hold 0 Yes and 0 No for this strike.'))
    assert.ok(await screen.findByText(/100\.00 USDC/), 'the $5 locked in the pairs is back')
    assert.equal(screen.queryByRole('button', { name: /cancel order/i }), null)
  }

  it('shows Cancel order and Close out position to a wallet holding both through a resting Buy No', async () => {
    const harness = hedged()
    await openHedged(harness)

    // Buy Yes is blocked while it holds No (R28), but the unwind stays available.
    assert.ok(await screen.findByRole('alert'))
    const cancel = await screen.findByRole('button', { name: /cancel order/i })
    const closeOut = await screen.findByRole('button', { name: /close out position/i })
    assert.equal((cancel as HTMLButtonElement).disabled, false)
    assert.equal((closeOut as HTMLButtonElement).disabled, false)
    assert.ok(await screen.findByText(/95\.00 USDC/), 'the wallet USDC balance is shown')
    assert.equal(harness.wallet.signPrompts, 0)
  })

  it('offers no Cancel order without a resting order, or without a connected wallet', async () => {
    const harness = setup()
    harness.chain.holdings.set(MARKET, { yes: 0, no: 5 })
    const user = userEvent.setup()
    const { unmount } = renderWith(harness, <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await screen.findByText('You hold 0 Yes and 5 No for this strike.')
    assert.equal(screen.queryByRole('button', { name: /cancel order/i }), null)
    unmount()

    const disconnected = hedged()
    disconnected.wallet.publicKey = null
    renderWith(disconnected, <TradePage ticker="AAPL" />)
    await selectStrike(user, '$230.00')
    await screen.findByText(/connect a wallet/i)
    assert.equal(screen.queryByRole('button', { name: /cancel order/i }), null)
    assert.equal(screen.queryByRole('button', { name: /close out position/i }), null)
  })

  it('Close out position signs once, confirms, and leaves Yes 0 and No 0 with the USDC back', async () => {
    const harness = hedged()
    const user = await openHedged(harness)
    await user.click(await screen.findByRole('button', { name: /close out position/i }))

    await waitFor(() => assert.equal(harness.chain.calls.sendAndConfirm.length, 1))
    assert.deepEqual(harness.chain.calls.buildCloseOutPosition, [{ market: MARKET, owner: WALLET }])
    assert.equal(harness.wallet.signPrompts, 1)
    assert.equal(harness.chain.calls.sendAndConfirm[0]?.commitment, 'confirmed')
    assert.deepEqual(harness.chain.calls.buildTrade, [], 'no trade is placed')
    await expectClosedOut()
  })

  it('Cancel order returns the Yes to the wallet, then Close out position merges the pairs', async () => {
    const harness = hedged()
    const user = await openHedged(harness)
    await user.click(await screen.findByRole('button', { name: /cancel order/i }))

    await waitFor(() => assert.equal(harness.chain.calls.sendAndConfirm.length, 1))
    assert.deepEqual(harness.chain.calls.buildCancelOrder, [
      { market: MARKET, owner: WALLET, orderId: '7' },
    ])
    assert.equal(harness.wallet.signPrompts, 1)
    await waitFor(() => assert.equal(screen.queryByRole('button', { name: /cancel order/i }), null))
    assert.ok(screen.getByText('You hold 5 Yes and 5 No for this strike.'))

    await user.click(await screen.findByRole('button', { name: /close out position/i }))
    await waitFor(() => assert.equal(harness.chain.calls.sendAndConfirm.length, 2))
    assert.equal(harness.wallet.signPrompts, 2)
    await expectClosedOut()
  })

  it('a split close-out signs and confirms each transaction in order', async () => {
    const harness = hedged()
    harness.chain.closeOutPositionTransactions = 2
    const user = await openHedged(harness)
    await user.click(await screen.findByRole('button', { name: /close out position/i }))

    await waitFor(() => assert.equal(harness.chain.calls.sendAndConfirm.length, 2))
    assert.equal(harness.wallet.signPrompts, 2)
    assert.deepEqual(
      harness.chain.calls.sendAndConfirm.map(
        ({ tx }) => (tx.raw as { signed: { part: number } }).signed.part,
      ),
      [0, 1],
    )
    await expectClosedOut()
  })

  it('explains a rejected signature and sends nothing', async () => {
    const harness = hedged()
    harness.wallet.rejectNextSign = true
    const user = await openHedged(harness)
    await user.click(await screen.findByRole('button', { name: /close out position/i }))

    await waitFor(() =>
      assert.ok(
        screen
          .getAllByRole('alert')
          .some((alert) => /rejected the signature/i.test(alert.textContent ?? '')),
      ),
    )
    assert.equal(harness.chain.calls.sendAndConfirm.length, 0)
    assert.ok(screen.getByText('You hold 5 Yes and 5 No for this strike.'))
  })
})
