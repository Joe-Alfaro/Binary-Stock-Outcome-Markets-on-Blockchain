import { defineConfig, devices } from '@playwright/test'

// End-to-end specs run against the private local stack `make e2e` starts (scripts/e2e.ts), which
// sets E2E_BASE_URL and E2E_STACK_FILE. Unit tests (`npm test`) never run these.
export default defineConfig({
  testDir: './e2e',
  // One validator and one demo market: specs share chain state, so they run one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: 'line',
  timeout: 60_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3105',
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
