import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { readdirSync, readFileSync } from 'node:fs';
import { hostedHeadersFile } from './server/http';
import { SUB_PATHS } from './src/ui/site/routes';

// `npm run preview:static` (vite preview, 4181) serves the static build without a runner; the full local preview is
// `npm run preview` (the runner on 4171). Dev mode needs inline scripts for HMR, so the
// CSP applies to preview only (tech spec §3.7).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self' https://rpc.plasma.to",
  "img-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// `vite build --mode hosted` (npm run build:hosted → dist-hosted/) is the same UI for the static website;
// only the `_headers` file (CSP allowing a paired loopback runner) is added. Nothing is deployed by a build.
const hostedHeaders = (mode: string): Plugin => ({
  name: 'cbpr-hosted-headers',
  apply: 'build',
  generateBundle() {
    if (mode === 'hosted') this.emitFile({ type: 'asset', fileName: '_headers', source: hostedHeadersFile() });
  },
});

// Real path routing on the hosted site (design guidelines §13.3): Workers static assets serve <path>/index.html
// at <path> (html_handling "drop-trailing-slash") and 404.html for anything else (not_found_handling "404-page"),
// so each page path gets its own copy of the one built index.html — no SPA fallback that could shadow a file.
// The runner needs none of this: it routes page paths itself (server/staticRoute.ts).
const hostedRoutes = (mode: string): Plugin => ({
  name: 'cbpr-hosted-routes',
  apply: 'build',
  enforce: 'post',
  generateBundle(_, bundle) {
    if (mode !== 'hosted') return;
    const index = bundle['index.html'];
    if (!index || index.type !== 'asset') throw new Error('hosted routes: index.html was not built');
    for (const p of SUB_PATHS) this.emitFile({ type: 'asset', fileName: `${p.slice(1)}/index.html`, source: index.source });
  },
});

// Every UI build carries the license texts of what it bundles (fonts, React, viem…) and of this project, so the
// hosted site and the runner package both ship them next to the code (THIRD_PARTY_NOTICES.md).
const notices = (): Plugin => ({
  name: 'cbpr-notices',
  apply: 'build',
  generateBundle() {
    for (const f of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md']) this.emitFile({ type: 'asset', fileName: `licenses/${f}${f.includes('.') ? '' : '.txt'}`, source: readFileSync(f, 'utf8') });
    for (const f of readdirSync('licenses')) this.emitFile({ type: 'asset', fileName: `licenses/${f}`, source: readFileSync(`licenses/${f}`, 'utf8') });
  },
});

// Local-only: bind loopback, fixed ports, fail instead of falling back to another port.
export default defineConfig(({ mode }) => ({
  plugins: [react(), hostedHeaders(mode), hostedRoutes(mode), notices()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: {
    host: '127.0.0.1',
    port: 4181,
    strictPort: true,
    headers: {
      'Content-Security-Policy': CSP,
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Opener-Policy': 'same-origin',
    },
  },
  // Two documents: the app, and the static 404 page (no script) that both hosts answer unknown paths with.
  build: { sourcemap: false, assetsInlineLimit: 0, rollupOptions: { input: { index: 'index.html', notFound: '404.html' } } },
  test: { environment: 'node', include: ['test/unit/**/*.test.ts'] },
}));
