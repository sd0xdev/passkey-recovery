#!/usr/bin/env node
// PERF-1 byte budgets (6-recovery-atlas.md §5.2) on the built UI: Home entry JS growth ≤ 30 KiB gzip over the
// pre-Atlas build, original visuals (the Demo WebPs; the plate SVG is inside the entry JS and counted there)
// ≤ 200 KiB, no font beyond the pre-Atlas set. Run after `npm run build`. Exit 1 when a budget is exceeded.
//   node scripts/design/budget-home.mjs [--out budget-home.json]
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { checkBudget } from './budget-lib.mjs';

const args = process.argv.slice(2);
const dir = 'dist/assets';
const html = readFileSync('dist/index.html', 'utf8');
const entry = /src="\/assets\/(index-[^"]+\.js)"/.exec(html)?.[1];
if (!entry) { console.error('dist/index.html names no entry script: run npm run build first'); process.exit(2); }
const files = readdirSync(dir);
const entryJsGzip = gzipSync(readFileSync(join(dir, entry)), { level: 9 }).length;
const visuals = files.filter((f) => /^demo-.*\.webp$/.test(f));
const visualBytes = visuals.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
const fonts = files.filter((f) => /\.woff2?$/.test(f));
const r = checkBudget({ entryJsGzip, visualBytes, fonts });
const report = { kind: 'budget-home', at: new Date().toISOString(), entry, entryJsGzip, visuals, fontsShipped: fonts.length, ...r };
console.log(JSON.stringify(report, null, 2));
if (args.includes('--out')) writeFileSync(resolve(args[args.indexOf('--out') + 1]), `${JSON.stringify(report, null, 2)}\n`);
process.exit(r.ok ? 0 : 1);
