import { defineConfig } from '@playwright/test'

// End-to-end specs run against a local validator with a test wallet; the devnet/e2e package wires
// up the web server and wallet. Unit tests (`npm test`) never run these.
export default defineConfig({
  testDir: './e2e',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000' },
})
