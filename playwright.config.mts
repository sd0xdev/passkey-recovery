import { defineConfig, devices } from '@playwright/test';

// Browser e2e against a fresh production build on loopback: `vite preview` on 4174 (static, no sidecar),
// the real sidecar bundle on 4175 in SYNTHETIC testchain mode, the runner bundle on 4177/4178 and the
// hosted build on 4179 (https) and 4180 (http) (test/support/e2e-servers.ts). Own
// ports, never reusing a running server, so a long-lived `npm start` (4173) can never stand in for the
// current revision.
export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  // One sidecar is shared by every spec, and switching its RPC endpoint (rpc-settings.spec.ts) discards
  // plans by design — so specs must not run concurrently against it.
  workers: 1,
  reporter: 'list',
  // The hosted build on 4179 is served over https with a certificate made for the run (test/support/e2e-servers.ts).
  // The test runner applies these `use` options to every `browser.newContext()` a spec makes through the `browser`
  // fixture, not only to the page fixture: https://playwright.dev/docs/test-use-options#explicit-context-creation-and-option-inheritance
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'off', ignoreHTTPSErrors: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run build:hosted && npx vite build -c vite.e2e.config.mts && node .e2e-build/e2e-servers.mjs',
    url: 'http://127.0.0.1:4174',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
