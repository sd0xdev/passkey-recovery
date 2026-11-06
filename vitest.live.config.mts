import { defineConfig } from 'vitest/config';

// Live public read-only RPC checks. Manual only; never part of `npm run test` / precommit.
export default defineConfig({
  test: { environment: 'node', include: ['test/live/**/*.test.ts'], testTimeout: 30_000 },
});
