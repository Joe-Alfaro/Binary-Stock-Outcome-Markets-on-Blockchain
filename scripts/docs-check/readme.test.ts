// R63: the README covers setup, funding, deploy, the demo and the technical rationale.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readRepoFile, sections } from './repo.js'

interface SectionCheck {
  name: string
  heading: RegExp
  mentions: RegExp[]
}

const checks: SectionCheck[] = [
  {
    name: 'one-command setup',
    heading: /setup|getting started|quick ?start/i,
    mentions: [/make dev\b/],
  },
  {
    name: 'devnet funding',
    heading: /fund/i,
    mentions: [/\bSOL\b/, /airdrop/i, /circle/i, /faucet/i, /\bUSDC\b/, /mock (usdc )?mint/i],
  },
  { name: 'devnet deploy', heading: /deploy/i, mentions: [/make deploy-devnet\b/] },
  { name: 'lifecycle demo', heading: /demo|lifecycle/i, mentions: [/make demo\b/] },
  {
    name: 'chain rationale',
    heading: /chain|why solana/i,
    mentions: [/solana/i, /\bEVM\b/, /\bL2\b/, /hyperliquid/i],
  },
  {
    name: 'relay oracle and switching to Pyth or Chainlink',
    heading: /oracle/i,
    mentions: [/relay/i, /pyth/i, /chainlink data streams/i, /slot/i],
  },
  {
    name: 'merge_pair deviation',
    heading: /merge_pair|deviation/i,
    mentions: [/merge_pair/, /redeem/i, /burn|destroy/i],
  },
  {
    name: 'finality and commitment',
    heading: /finality|commitment/i,
    mentions: [/\bconfirmed\b/, /\bfinalized\b/],
  },
  {
    name: 'settlement schedule',
    heading: /settlement/i,
    mentions: [
      /\b30 ?s/,
      /\+ ?15\b|\b15 min/,
      /\+ ?50\b|\b50 min/,
      /\+ ?60\b|\b60 min/,
      /alert/i,
      /propose/i,
    ],
  },
  { name: 'risks and limitations', heading: /risk|limitation/i, mentions: [/\S[\s\S]{100,}/] },
]

describe('README.md (R63)', () => {
  const readme = readRepoFile('README.md')

  it('exists', () => {
    assert.ok(readme, 'README.md is missing from the repo root')
  })

  checks.forEach((check) => {
    it(`has a ${check.name} section`, () => {
      assert.ok(readme, 'README.md is missing from the repo root')
      const candidates = sections(readme).filter((s) => check.heading.test(s.heading))
      assert.ok(candidates.length > 0, `no heading matching ${check.heading} for ${check.name}`)
      // Any matching section may carry the content; report the closest one.
      const results = candidates.map((section) => ({
        heading: section.heading,
        missing: check.mentions.filter((pattern) => !pattern.test(section.body)).map(String),
      }))
      const best = results.reduce((a, b) => (b.missing.length < a.missing.length ? b : a))
      assert.deepEqual(
        best.missing,
        [],
        `the "${best.heading}" section must mention each of these patterns`,
      )
    })
  })
})
