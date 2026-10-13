import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { TRADE_PATHS, runDemo, type Commitment, type DemoClient } from './demo.js'
import { explorerTxUrl } from './lib/explorer.js'
import { CallLog, DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH } from './lib/test-support.js'

const START_MS = 1_791_000_000_000
const CONFIRM_MS = 420

/** A fake chain with a fake clock: confirming a transaction takes 420 ms. */
function fakeDemo(genesisHash = DEVNET_GENESIS_HASH) {
  const log = new CallLog()
  const clock = { now: START_MS }
  const commitments: Commitment[] = []
  const created: { ticker: string; closeTs: number }[] = []
  const confirmedAt = new Map<string, number>()
  let counter = 0
  function send(name: string) {
    counter += 1
    log.record(name)
    return `sig${counter}${name.replace(/[^a-z]/gi, '')}`
  }
  const client: DemoClient = {
    async getGenesisHash() {
      return genesisHash
    },
    async createDemoMarket(params) {
      created.push(params)
      return { market: 'Market111', signature: send('create') }
    },
    async mintPair() {
      return send('mint')
    },
    async trade(_market, path) {
      return send(`trade:${path}`)
    },
    async publishRelayClose() {
      return send('publish')
    },
    async settle() {
      return send('settle')
    },
    async redeem() {
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
  return { options, log, lines, commitments, created, confirmedAt }
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
