/**
 * R61: `scripts/demo.ts` run for real against the local validator, with the script's own chain
 * client. Each trade path is checked from the confirmed transaction itself, not from what the demo
 * reports: the trader's token balance changes in the transaction's metadata, the instructions it
 * ran and that it is the SDK builders' v0 transaction. The final redeem is checked the same way.
 *
 * It shares the lifecycle tests' bootstrap (one config per validator) and trades AAPL on today's
 * New York trading day, which no other test uses.
 */
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import type { TokenBalance, VersionedTransactionResponse } from '@solana/web3.js'
import { expect } from 'chai'
import { runDemo, TRADE_PATHS } from '../scripts/demo.js'
import type { DemoResult, TradePath } from '../scripts/demo.js'
import { createDemoClient } from '../scripts/lib/chain.js'
import { bootstrap, connection, enableDemoMode, meridian } from './support/meridian.js'
import type { Roles } from './support/meridian.js'

const encoder = new TextEncoder()

interface Delta {
  usdc: bigint
  yes: bigint
  no: bigint
}

/** The Meridian instructions a transaction ran, by IDL name. */
function meridianInstructions(tx: VersionedTransactionResponse): string[] {
  const message = tx.transaction.message
  const keys = message.staticAccountKeys
  return message.compiledInstructions
    .filter((ix) => keys[ix.programIdIndex]?.equals(meridian.programId))
    .map((ix) => {
      const data = Buffer.from(ix.data)
      const found = meridian.idl.instructions.find((candidate) =>
        Buffer.from(candidate.discriminator).equals(data.subarray(0, 8)),
      )
      return found?.name ?? 'unknown'
    })
}

function amountOf(balances: TokenBalance[] | null | undefined, owner: string, mint: string) {
  const found = (balances ?? []).find((b) => b.owner === owner && b.mint === mint)
  return BigInt(found?.uiTokenAmount.amount ?? '0')
}

describe('make demo on localnet (R61)', () => {
  let roles: Roles
  let result: DemoResult
  let mints: { usdc: string; yes: string; no: string }
  const txs = new Map<string, VersionedTransactionResponse>()

  before(async () => {
    roles = await bootstrap()
    // `make dev` and the devnet bootstrap turn demo mode on before the demo runs.
    await enableDemoMode(roles.admin)
    const env: NodeJS.ProcessEnv = {
      SOLANA_CLUSTER: 'localnet',
      SOLANA_RPC_URL: connection.rpcEndpoint,
      ADMIN_KEYPAIR: bs58.encode(roles.admin.secretKey),
      AUTOMATION_KEYPAIR: bs58.encode(roles.automation.secretKey),
      RELAY_SIGNER_1_KEYPAIR: bs58.encode(roles.relay.secretKey),
      ANCHOR_WALLET: process.env.ANCHOR_WALLET ?? '',
    }
    result = await runDemo({ env, client: createDemoClient(env), log: () => {} })

    const market = new PublicKey(result.market)
    const mint = (seed: string) =>
      PublicKey.findProgramAddressSync(
        [encoder.encode(seed), market.toBytes()],
        meridian.programId,
      )[0].toBase58()
    mints = { usdc: roles.usdcMint.toBase58(), yes: mint('yes'), no: mint('no') }

    for (const tx of result.transactions) {
      const confirmed = await connection.getTransaction(tx.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      })
      if (!confirmed) throw new Error(`${tx.step} ${tx.signature} is not on the chain`)
      txs.set(tx.step, confirmed)
    }
  })

  function stepTx(step: string) {
    const tx = txs.get(step)
    expect(tx, `the demo ran no ${step} step`).to.not.equal(undefined)
    return tx as VersionedTransactionResponse
  }

  const feePayer = (tx: VersionedTransactionResponse) =>
    tx.transaction.message.staticAccountKeys[0]?.toBase58() ?? ''

  /** The fee payer's balance changes in one transaction, from its own metadata. */
  function delta(tx: VersionedTransactionResponse): Delta {
    const owner = feePayer(tx)
    const change = (mint: string) =>
      amountOf(tx.meta?.postTokenBalances, owner, mint) -
      amountOf(tx.meta?.preTokenBalances, owner, mint)
    return { usdc: change(mints.usdc), yes: change(mints.yes), no: change(mints.no) }
  }

  const trader = () => feePayer(stepTx('buy-yes'))

  it('runs all four trade paths from one trader wallet', () => {
    const payers = TRADE_PATHS.map((path) => feePayer(stepTx(path)))
    expect(new Set(payers).size, `fee payers: ${payers.join(', ')}`).to.equal(1)
  })

  it('has a second, funded wallet quote each path before the trader trades it', () => {
    const steps = result.transactions.map((tx) => tx.step)
    TRADE_PATHS.forEach((path) => {
      const quote = steps.findIndex((step) => step.startsWith('quote') && step.includes(path))
      expect(quote, `no quote step for ${path}: ${steps.join(', ')}`).to.be.greaterThan(-1)
      expect(quote).to.be.lessThan(steps.indexOf(path))
      const quoteTx = stepTx(steps[quote] as string)
      expect(feePayer(quoteTx), `${path} was quoted by the trader itself`).to.not.equal(trader())
    })
  })

  it('sends each trade path as the SDK builders do: one v0 transaction', () => {
    TRADE_PATHS.forEach((path) => {
      expect(stepTx(path).version, `${path} is not an SDK v0 transaction`).to.equal(0)
    })
  })

  // `Program` camel-cases the IDL's instruction names.
  const expectedInstructions: Record<TradePath, string[]> = {
    'buy-yes': ['placeOrder', 'settleFunds'],
    'sell-yes': ['placeOrder', 'settleFunds'],
    'buy-no': ['mintPair', 'placeOrder', 'settleFunds'],
    'sell-no': ['placeOrder', 'settleFunds', 'mergePairUpTo'],
  }

  /** How much of the path's token moved, and the USDC paid (buys) or received (sells). */
  function fill(path: TradePath, d: Delta) {
    const moved = { 'buy-yes': d.yes, 'sell-yes': -d.yes, 'buy-no': d.no, 'sell-no': -d.no }[path]
    const other = path.endsWith('-yes') ? d.no : d.yes
    const usdc = path.startsWith('buy') ? -d.usdc : d.usdc
    return { moved, other, usdc }
  }

  TRADE_PATHS.forEach((path) => {
    it(`${path} runs the SDK path's instructions`, () => {
      const names = meridianInstructions(stepTx(path))
      const inOrder = names.filter((name) => expectedInstructions[path].includes(name))
      expect(inOrder, `${path} ran ${names.join(', ')}`).to.deep.equal(expectedInstructions[path])
    })

    it(`${path} fills against the counterparty`, () => {
      const d = delta(stepTx(path))
      const { moved, other, usdc } = fill(path, d)
      const shown = `yes ${d.yes}, no ${d.no}, usdc ${d.usdc}`
      expect(moved > 0n, `${path} did not fill (${shown})`).to.equal(true)
      // Buy No sells the Yes it mints; Sell No merges the Yes it buys.
      expect(other, `${path} left the other token changed (${shown})`).to.equal(0n)
      expect(usdc > 0n && usdc < moved, `${path} price outside (0, $1) (${shown})`).to.equal(true)
    })

    it(`${path} records the trader's on-chain balances after the step`, () => {
      const tx = stepTx(path)
      const recorded = result.transactions.find((candidate) => candidate.step === path)?.balances
      expect(recorded, `no balances recorded after ${path}`).to.not.equal(undefined)
      const owner = feePayer(tx)
      expect(recorded?.trader).to.deep.equal({
        usdc: amountOf(tx.meta?.postTokenBalances, owner, mints.usdc),
        yes: amountOf(tx.meta?.postTokenBalances, owner, mints.yes),
        no: amountOf(tx.meta?.postTokenBalances, owner, mints.no),
      })
    })
  })

  it('redeems every token the trader holds for the settled outcome', async () => {
    const tx = stepTx('redeem')
    const owner = feePayer(tx)
    expect(owner).to.equal(trader())
    const pre = (mint: string) => amountOf(tx.meta?.preTokenBalances, owner, mint)
    const post = (mint: string) => amountOf(tx.meta?.postTokenBalances, owner, mint)
    expect(pre(mints.yes) + pre(mints.no) > 0n, 'the trader had nothing to redeem').to.equal(true)
    expect({ yes: post(mints.yes), no: post(mints.no) }).to.deep.equal({ yes: 0n, no: 0n })

    const state = await meridian.account.market.fetch(new PublicKey(result.market))
    const outcome = state.outcome as { yes?: object; no?: object } | null
    expect(outcome, 'the demo market is not settled').to.not.equal(null)
    const winners = outcome && 'yes' in outcome ? pre(mints.yes) : pre(mints.no)
    expect(post(mints.usdc) - pre(mints.usdc)).to.equal(winners)
  })
})
