import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'
import { builtProgramIds } from './src/lib/program-ids'

// Program IDs come from the environment, else from the IDLs `anchor build` wrote (`make dev`).
const built = builtProgramIds(fileURLToPath(new URL('../target/idl', import.meta.url)))
const programIdEnv = Object.fromEntries(
  Object.entries({
    NEXT_PUBLIC_MERIDIAN_PROGRAM_ID: process.env.NEXT_PUBLIC_MERIDIAN_PROGRAM_ID || built.meridian,
    NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID:
      process.env.NEXT_PUBLIC_MERIDIAN_ORACLE_PROGRAM_ID || built.meridianOracle,
  }).filter((entry): entry is [string, string] => Boolean(entry[1])),
)

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: programIdEnv,
  // Repo-level agent instructions live in the root AGENTS.md; don't generate another here.
  agentRules: false,
  transpilePackages: ['@meridian/sdk'],
  // The SDK is TypeScript source with NodeNext-style `.js` import specifiers. Webpack maps them to
  // the `.ts` files; Turbopack can't yet, so `dev` and `build` run with `--webpack`.
  webpack(config) {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}

export default nextConfig
