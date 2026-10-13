import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
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
