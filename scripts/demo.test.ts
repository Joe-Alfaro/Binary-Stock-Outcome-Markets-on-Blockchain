import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  TRADE_PATHS,
  createDryRunClient,
  runDemo,
  type Commitment,
  type DemoBalances,
  type DemoClient,
  type DemoResult,
  type TradePath,
  type WalletBalances,
} from './demo.js'
import { explorerTxUrl } from './lib/explorer.js'
import {
  CallLog,
  DEVNET_GENESIS_HASH,
  MAINNET_GENESIS_HASH,
  REPO_ROOT,
} from './lib/test-support.js'

const START_MS = 1_791_000_000_000
const CONFIRM_MS = 420
const UNIT = 1_000_000n
/** Every fake fill trades at 50¢. */
const HALF = UNIT / 2n

type Ledger = DemoBalances
type Broken =
  | { kind: 'resting'; path: TradePath }
  | { kind: 'buy-no-unsold' }
  | { kind: 'sell-no-unmerged' }
  | { kind: 'unredeemed' }

const wallet = (usdc: bigint, yes = 0n, no = 0n): WalletBalances => ({ usdc, yes, no })

function move(target: WalletBalances, delta: Partial<WalletBalances>) {
  target.usdc += delta.usdc ?? 0n
  target.yes += delta.yes ?? 0n
  target.no += delta.no ?? 0n
}

/**
 * A fake chain with a fake clock (confirming a transaction takes 420 ms) and a ledger of both
 * demo wallets, where each trade path fills against the counterparty's quote at 50¢. `broken`
 * makes one step behave like the old demo: an order that rests, or a leg that never happens.
 */
function fakeDemo(genesisHash = DEVNET_GENESIS_HASH, broken?: Broken) {
  const log = new CallLog()
  const clock = { now: START_MS }
  const commitments: Commitment[] = []
  const created: { ticker: string; closeTs: number }[] = []
  const confirmedAt = new Map<string, number>()
  const quoted = new Set<TradePath>()
  const ledger: Ledger = { trader: wallet(100n * UNIT), counterparty: wallet(100n * UNIT) }
  let counter = 0
  function send(name: string) {
    counter += 1
    log.record(name)
    return `sig${counter}${name.replace(/[^a-z]/gi, '')}`
  }
  function fill(path: TradePath, qty: bigint) {
    const { trader, counterparty } = ledger
    if (broken?.kind === 'resting' && broken.path === path) return
    if (!quoted.has(path)) return // Nothing to fill against.
    const tokens = qty * UNIT
    const cost = qty * HALF
    if (path === 'buy-yes') {
      move(trader, { yes: tokens, usdc: -cost })
      move(counterparty, { yes: -tokens, usdc: cost })
    } else if (path === 'sell-yes') {
      move(trader, { yes: -tokens, usdc: cost })
      move(counterparty, { yes: tokens, usdc: -cost })
    } else if (path === 'buy-no') {
      // Mint pairs, sell the Yes to the counterparty's bid.
      if (broken?.kind === 'buy-no-unsold') {
        move(trader, { yes: tokens, no: tokens, usdc: -tokens })
        return
      }
      move(trader, { no: tokens, usdc: -cost })
      move(counterparty, { yes: tokens, usdc: -cost })
    } else {
      // Buy Yes from the counterparty's ask, merge the pairs back into USDC.
      if (broken?.kind === 'sell-no-unmerged') {
        move(trader, { yes: tokens, usdc: -cost })
        move(counterparty, { yes: -tokens, usdc: cost })
        return
      }
      move(trader, { no: -tokens, usdc: cost })
      move(counterparty, { yes: -tokens, usdc: cost })
    }
    quoted.delete(path)
  }
  const client: DemoClient = {
    async getGenesisHash() {
      return genesisHash
    },
    async createDemoMarket(params) {
      created.push(params)
      return { market: 'Market111', signature: send('create') }
    },
    async mintPair(_market, quantity) {
      // The counterparty mints what it quotes; a trader holding both sides couldn't Buy Yes (R28).
      const tokens = BigInt(quantity) * UNIT
      move(ledger.counterparty, { yes: tokens, no: tokens, usdc: -tokens })
      return send('mint')
    },
    async quote(_market, path) {
      quoted.add(path)
      return send(`quote:${path}`)
    },
    async trade(_market, path, quantity) {
      fill(path, BigInt(quantity))
      return send(`trade:${path}`)
    },
    async balances() {
      return structuredClone(ledger)
    },
    async publishRelayClose() {
      return send('publish')
    },
    async settle() {
      return send('settle')
    },
    async redeem() {
      if (broken?.kind !== 'unredeemed') {
        // The demo market settles Yes.
        move(ledger.trader, {
          usdc: ledger.trader.yes,
          yes: -ledger.trader.yes,
          no: -ledger.trader.no,
        })
      }
      return send('redeem')
    },
    async confirm(signature, commitment) {
      commitments.push(commitment)
      clock.now += CONFIRM_MS
      confirmedAt.set(signature, clock.now)
    },
  }
  const lines: string[] = []
  const options = {
    client,
    now: () => clock.now,
    sleep: async (ms: number) => {
      clock.now += ms
    },
    log: (line: string) => lines.push(line),
  }
  return { options, log, lines, commitments, created, confirmedAt, ledger }
}

/** The trader's balances recorded after a step, and after the step before it. */
function balancesAround(result: DemoResult, step: string) {
  const index = result.transactions.findIndex((tx) => tx.step === step)
  assert.ok(index > 0, `no ${step} step after another step`)
  const after = result.transactions[index]?.balances?.trader
  const before = result.transactions
    .slice(0, index)
    .reverse()
    .find((tx) => tx.balances)?.balances?.trader
  assert.ok(after, `no balances recorded after ${step}`)
  assert.ok(before, `no balances recorded before ${step}`)
  return {
    yes: after.yes - before.yes,
    no: after.no - before.no,
    usdc: after.usdc - before.usdc,
  }
}

/**
 * What a filled trade path does to the trader: Buy Yes and Sell Yes move Yes against USDC; Buy No
 * mints and sells the Yes, so only No arrives; Sell No buys Yes and merges, so only No leaves.
 * Every fill is at a price strictly between 0 and $1 a token.
 */
function assertFilled(path: TradePath, delta: WalletBalances) {
  const label = `${path}: ${JSON.stringify(delta, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`
  const moved = {
    'buy-yes': delta.yes,
    'sell-yes': -delta.yes,
    'buy-no': delta.no,
    'sell-no': -delta.no,
  }[path]
  const untouched = path.endsWith('-yes') ? delta.no : delta.yes
  assert.ok(moved > 0n, `${label}: the order did not fill`)
  assert.equal(untouched, 0n, `${label}: the other token should not change`)
  const paid = path.startsWith('buy') ? -delta.usdc : delta.usdc
  assert.ok(paid > 0n && paid < moved, `${label}: price must be between 0 and $1`)
}

describe('explorerTxUrl (R61)', () => {
  it('links devnet transactions to the devnet explorer', () => {
    assert.equal(
      explorerTxUrl('abc', { cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com' }),
      'https://explorer.solana.com/tx/abc?cluster=devnet',
    )
  })

  it('links localnet transactions through a custom RPC URL', () => {
    assert.equal(
      explorerTxUrl('abc', { cluster: 'localnet', rpcUrl: 'http://127.0.0.1:8913' }),
      'https://explorer.solana.com/tx/abc?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8913',
    )
  })
})

// R61: create → mint → all 4 trade paths → settle via the relay → redeem, with signatures,
// explorer links, confirmation latency (R55) and settlement delay (R38).
describe('runDemo (R61, R55, R38)', () => {
  it('runs the lifecycle in order', async () => {
    const fake = fakeDemo()
    await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
    const at = (name: string) => fake.log.indexOf(name)
    const trades = TRADE_PATHS.map((path) => at(`trade:${path}`))
    assert.ok(
      trades.every((index) => index >= 0),
      `calls: ${fake.log.calls.join(', ')}`,
    )
    assert.equal(at('create'), 0)
    assert.ok(at('mint') > at('create'))
    assert.ok(trades.every((index) => index > at('mint')))
    assert.ok(trades.every((index) => index < at('publish')))
    assert.ok(at('publish') < at('settle'))
    assert.ok(at('settle') < at('redeem'))
    assert.equal(fake.created.length, 1)
    assert.ok((fake.created[0]?.closeTs ?? 0) * 1000 > START_MS, 'close_ts must be in the future')
  })

  it('waits for close_ts before publishing the close and settling', async () => {
    const fake = fakeDemo()
    const result = await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
    const settleSig = result.transactions.find((tx) => tx.step === 'settle')?.signature
    assert.ok(settleSig)
    assert.ok((fake.confirmedAt.get(settleSig) ?? 0) >= result.closeTs * 1000)
  })

  it('prints every signature with its explorer link and confirmation latency', async () => {
    const fake = fakeDemo()
    const result = await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
    assert.equal(result.transactions.length, fake.log.calls.length)
    result.transactions.forEach((tx) => {
      assert.equal(tx.confirmMs, CONFIRM_MS)
      assert.equal(tx.explorerUrl, `https://explorer.solana.com/tx/${tx.signature}?cluster=devnet`)
      const line = fake.lines.find((candidate) => candidate.includes(tx.signature))
      assert.ok(line, `no output line for ${tx.step}`)
      assert.match(line, new RegExp(`${CONFIRM_MS}\\s?ms`))
      assert.ok(fake.lines.join('\n').includes(tx.explorerUrl))
    })
  })

  it('confirms every transaction at confirmed commitment', async () => {
    const fake = fakeDemo()
    await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
    assert.ok(fake.commitments.length >= 9)
    assert.ok(fake.commitments.every((commitment) => commitment === 'confirmed'))
  })

  it('reports and prints the settlement delay from close_ts', async () => {
    const fake = fakeDemo()
    const result = await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
    const settleSig = result.transactions.find((tx) => tx.step === 'settle')?.signature ?? ''
    const expected = ((fake.confirmedAt.get(settleSig) ?? 0) - result.closeTs * 1000) / 1000
    assert.equal(result.settlementDelaySecs, expected)
    const line = fake.lines.find((candidate) => /settlement delay/i.test(candidate))
    assert.ok(line, 'no settlement delay line')
    const printed = Number(line.match(/settlement delay\D*([\d.]+)/i)?.[1])
    assert.ok(Math.abs(printed - expected) < 1, `printed ${printed}, expected ${expected}`)
  })

  it('refuses demo mode on testnet (R44)', async () => {
    const fake = fakeDemo()
    await assert.rejects(runDemo({ env: { SOLANA_CLUSTER: 'testnet' }, ...fake.options }), /demo/i)
    assert.deepEqual(fake.log.calls, [])
  })

  const mainnetTargets: [string, NodeJS.ProcessEnv, string][] = [
    ['cluster name', { SOLANA_CLUSTER: 'mainnet-beta' }, DEVNET_GENESIS_HASH],
    ['RPC URL', { SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com' }, DEVNET_GENESIS_HASH],
    ['genesis hash', { SOLANA_RPC_URL: 'https://rpc.example.com' }, MAINNET_GENESIS_HASH],
  ]
  mainnetTargets.forEach(([label, env, genesis]) => {
    it(`refuses mainnet-beta by ${label} before sending anything (R45)`, async () => {
      const fake = fakeDemo(genesis)
      await assert.rejects(runDemo({ env, ...fake.options }), /mainnet/i)
      assert.deepEqual(fake.log.calls, [])
    })
  })
})

// R61 (validation round 1): the four trade paths were bare limit orders from one wallet that
// rested without filling. A second funded wallet quotes each path, every path fills, Buy No mints
// and sells, Sell No buys and merges, and the demo checks balances after every step.
describe('runDemo trade paths fill against a counterparty (R61)', () => {
  it('has the counterparty quote each path after the mint and before its trade', async () => {
    const fake = fakeDemo()
    await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
    TRADE_PATHS.forEach((path) => {
      const quote = fake.log.indexOf(`quote:${path}`)
      assert.ok(quote >= 0, `${path} never quoted: ${fake.log.calls.join(', ')}`)
      assert.ok(
        quote > fake.log.indexOf('mint'),
        `${path} quoted before the mint: ${fake.log.calls}`,
      )
      assert.ok(quote < fake.log.indexOf(`trade:${path}`), `${path} not quoted before its trade`)
    })
  })

  it("records both wallets' balances after every step", async () => {
    const fake = fakeDemo()
    const result = await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
    const steps = ['mint', ...TRADE_PATHS, 'redeem']
    steps.forEach((name) => {
      const tx = result.transactions.find((candidate) => candidate.step === name)
      assert.ok(tx?.balances, `no balances recorded after ${name}`)
      assert.ok(tx.balances.counterparty, `no counterparty balances after ${name}`)
    })
  })

  TRADE_PATHS.forEach((path) => {
    it(`${path} fills: the trader's balances move as the path promises`, async () => {
      const fake = fakeDemo()
      const result = await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
      assertFilled(path, balancesAround(result, path))
    })

    it(`stops with an error when ${path} rests without filling`, async () => {
      const fake = fakeDemo(DEVNET_GENESIS_HASH, { kind: 'resting', path })
      await assert.rejects(
        runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options }),
        new RegExp(`${path}.*fill|fill.*${path}`, 'i'),
      )
      assert.equal(fake.log.indexOf('publish'), -1, 'the demo went on after a failed fill')
    })
  })

  it('stops when Buy No keeps the minted Yes instead of selling it', async () => {
    const fake = fakeDemo(DEVNET_GENESIS_HASH, { kind: 'buy-no-unsold' })
    await assert.rejects(runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options }), /buy-no/i)
    assert.equal(fake.log.indexOf('trade:sell-no'), -1)
  })

  it('stops when Sell No buys Yes but never merges the pairs', async () => {
    const fake = fakeDemo(DEVNET_GENESIS_HASH, { kind: 'sell-no-unmerged' })
    await assert.rejects(
      runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options }),
      /sell-no/i,
    )
    assert.equal(fake.log.indexOf('publish'), -1)
  })

  it('goes into the redeem with a position, then burns it all for the payout', async () => {
    const fake = fakeDemo()
    const result = await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
    const index = result.transactions.findIndex((tx) => tx.step === 'redeem')
    const before = result.transactions
      .slice(0, index)
      .reverse()
      .find((tx) => tx.balances)?.balances?.trader
    assert.ok(before && before.yes + before.no > 0n, 'the trader has nothing left to redeem')
    const after = result.transactions[index]?.balances?.trader
    assert.deepEqual(
      { yes: after?.yes, no: after?.no },
      { yes: 0n, no: 0n },
      'the trader still holds tokens after the redeem',
    )
  })

  it('stops when the redeem leaves the trader holding tokens', async () => {
    const fake = fakeDemo(DEVNET_GENESIS_HASH, { kind: 'unredeemed' })
    await assert.rejects(runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options }), /redeem/i)
  })
})

describe('createDryRunClient (R61)', () => {
  function dryRun() {
    let current = START_MS
    return runDemo({
      env: { SOLANA_CLUSTER: 'devnet' },
      client: createDryRunClient(),
      now: () => current,
      sleep: async (ms) => {
        current += ms
      },
      log: () => {},
    })
  }

  it('runs the whole demo with a quote before each of the four trade paths', async () => {
    const result = await dryRun()
    const steps = result.transactions.map((tx) => tx.step)
    TRADE_PATHS.forEach((path) => {
      const quoted = steps.some((name) => name.startsWith('quote') && name.includes(path))
      assert.ok(quoted, `no quote step for ${path}: ${steps.join(', ')}`)
    })
  })

  TRADE_PATHS.forEach((path) => {
    it(`simulates a filled ${path}`, async () => {
      assertFilled(path, balancesAround(await dryRun(), path))
    })
  })
})

describe('createDemoClient trade paths (R61)', () => {
  it('builds the four trade paths with the SDK builders the app uses', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/lib/chain.ts'), 'utf8')
    const sdkImport = /import\s*\{([^}]*)\}\s*from\s*'@meridian\/sdk'/.exec(source)?.[1] ?? ''
    const builders = [
      'buildBuyYesTransaction',
      'buildSellYesTransaction',
      'buildBuyNoTransaction',
      'buildSellNoTransaction',
    ]
    builders.forEach((builder) => {
      assert.match(sdkImport, new RegExp(`\\b${builder}\\b`), `chain.ts does not import ${builder}`)
      assert.match(source, new RegExp(`${builder}\\(`), `chain.ts never calls ${builder}`)
    })
  })
})

// R44: the demo replays the recorded AAPL close of 2026-10-12 ($340.97), not a hand-written one.
describe('the demo replays a recorded real close (R44)', () => {
  it('prints the recorded close it replays and the strike one dollar over it', async () => {
    const fake = fakeDemo()
    await runDemo({ env: { SOLANA_CLUSTER: 'devnet' }, ...fake.options })
    const output = fake.lines.join('\n')
    assert.match(output, /recorded AAPL close of 2026-10-12/)
    assert.match(output, /\$340\.97\b/)
    assert.match(output, /strike \$341\.97\b/i)
  })

  it('has the chain demo client replay the recorded close, not the hand-written mock fixtures', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts/lib/chain.ts'), 'utf8')
    assert.doesNotMatch(source, /\bcreateMockSource\b/, 'chain.ts still replays the mock fixtures')
    assert.match(
      source,
      /\bcreateDemoReplaySource\(/,
      'chain.ts never builds the demo replay source',
    )
  })
})
