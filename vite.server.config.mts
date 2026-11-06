import { defineConfig } from 'vite';

// Node bundles for the loopback sidecar, the Terminal signer, the local runner and its native signer child (tech spec §4.4). Dependencies stay
// external (resolved from node_modules); nothing from here is served to the browser.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'dist-server',
    emptyOutDir: true,
    sourcemap: false,
    target: 'node24',
    rollupOptions: {
      input: { sidecar: 'server/sidecar.ts', signer: 'server/signer/cli.ts', runner: 'server/runner/runner.ts', 'signer-service': 'server/runner/signerChild.ts' },
      output: { entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs', format: 'es' },
    },
  },
});
