import { defineConfig } from 'vitest/config';

// Local anvil integration tests (synthetic chain and Plasma fork). Manual / pre-handoff, not in precommit.
export default defineConfig({
  test: { environment: 'node', include: ['test/integration/**/*.test.ts'], testTimeout: 180_000, hookTimeout: 180_000, fileParallelism: false },
});
