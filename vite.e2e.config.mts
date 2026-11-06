import { defineConfig } from 'vite';

// Bundles the Playwright web-server launcher (test/support/e2e-servers.ts) for Node. Test-only; the
// output directory is git-ignored and never served.
export default defineConfig({
  build: {
    ssr: true,
    outDir: '.e2e-build',
    emptyOutDir: true,
    sourcemap: false,
    target: 'node24',
    rollupOptions: { input: { 'e2e-servers': 'test/support/e2e-servers.ts' }, output: { entryFileNames: '[name].mjs', format: 'es' } },
  },
});
