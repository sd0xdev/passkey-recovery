#!/usr/bin/env node
// Regenerates the Home page's Demo stills (6-recovery-atlas.md §3) from the real UI on the e2e SYNTHETIC
// testchain: runs the first flow.spec tests with E2E_DEMO_DIR set (they capture at Check, Deploy, Approve and
// Track), then encodes each PNG to WebP into src/ui/site/assets/. Nothing real is shown: synthetic accounts,
// a synthetic gas wallet, no 1Password link, no pairing code. Needs `cwebp` (libwebp) on PATH. Design-time only.
// Each capture is checked before encoding: a PNG of exactly 1280×736 (the tool below the site header); a missing or
// wrong-sized still fails the run and nothing is written for it.
//   node scripts/design/capture-demo.mjs [--out <dir>]   (default src/ui/site/assets)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const NAMES = ['demo-check', 'demo-deploy', 'demo-approve', 'demo-track'];
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'src/ui/site/assets';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Throws unless `file` is a PNG of 1280×736. */
function checkStill(file) {
  const b = readFileSync(file);
  if (!b.subarray(0, 8).equals(PNG)) throw new Error(`${file} is not a PNG`);
  const [w, h] = [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (w !== 1280 || h !== 736) throw new Error(`${file} is ${w}×${h}, expected 1280×736`);
}
const dir = mkdtempSync(join(tmpdir(), 'cbpr-demo-'));
const env = { ...process.env, E2E_DEMO_DIR: dir };
for (const k of Object.keys(env)) if (k.startsWith('CBPR_')) delete env[k];
try {
  execFileSync('npx', ['playwright', 'test', 'test/e2e/flow.spec.ts', '--grep', ' (check|deploy): | move nonce 0 '], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  for (const n of NAMES) checkStill(join(dir, `${n}.png`));
  mkdirSync(out, { recursive: true });
  for (const n of NAMES) {
    const to = join(out, `${n}.webp`);
    execFileSync('cwebp', ['-quiet', '-q', '70', '-resize', '960', '0', '-metadata', 'none', join(dir, `${n}.png`), '-o', to]);
    console.log(`${to} ${statSync(to).size} bytes`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
