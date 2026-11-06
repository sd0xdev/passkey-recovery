#!/usr/bin/env node
// Bounded smoke of the one local preview (6-recovery-atlas.md §6.1, RUN-1): runs `npm run preview` exactly as a
// user does (build, then the runner on its defaults 4171 / 4172), checks `/` and `/recover` carry a session, a
// browser on /recover is connected and stays connected across reload and back/forward, the native signer listens
// on 4172, the runner API reports this release; records the PID listening on 4171, the version and the served entry
// asset with its sha256; then stops the process group and checks both ports closed. Then `npm run preview:static`
// (the Vite preview of the same build, 4181): pages without a session, the tool says it is a static preview with no
// runner, and Ctrl-C closes 4181. Every probe is bounded. Session material and the pairing code are read in memory only, never printed or written.
//   node scripts/release/preview-smoke.mjs [--out preview-smoke.json]
// Refuses to start while 4171, 4172 or 4181 is in use (stop the running preview first). Exit 1 when a check fails.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createInterrupt, stopAll } from './smoke-lib.mjs';

const args = process.argv.slice(2);
const out = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : 'preview-smoke.json');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const BASE = 'http://127.0.0.1:4171';
const portOpen = (port) => new Promise((r) => { const s = createServer(); s.once('error', () => r(true)); s.listen(port, '127.0.0.1', () => s.close(() => r(false))); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Every HTTP probe gives up after 5 s, so a server that accepts and never answers cannot hold the smoke. */
const probe = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(5_000) });
const listenerPid = (port) => { try { return Number(execFileSync('lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]) || 0; } catch { return 0; } };
for (const p of [4171, 4172, 4181]) if (await portOpen(p)) { console.error(`127.0.0.1:${p} is in use: stop the running preview first`); process.exit(2); }

// The product environment: no private RPC file, no test switch.
const env = { ...process.env };
for (const k of Object.keys(env)) if (k.startsWith('CBPR_')) delete env[k];
const held = async () => { const h = []; for (const p of [4171, 4172, 4181]) if (await portOpen(p)) h.push(p); return h; };
// A Ctrl-C or SIGTERM to the smoke itself stops every server it started (smoke-lib.mjs `createInterrupt`).
const ctl = createInterrupt({
  signalGroup: (pgid, sig) => { try { process.kill(-pgid, sig); } catch { /* gone */ } },
  portsHeld: held,
  wait: sleep,
  exit: (code) => process.exit(code),
  report: (h) => console.error(h.length ? `interrupted; still in use: ${h.join(', ')}` : 'interrupted; 4171, 4172 and 4181 are free'),
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void ctl.interrupt());
// Our handler owns Ctrl-C; Playwright's own would exit first and skip it (the browser still closes on exit).
const NO_SIGNALS = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
const start = (script) => {
  const c = spawn('npm', ['run', script], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  c.stderr.on('data', () => {});
  ctl.started(c.pid);
  return { c, exited: new Promise((r) => c.on('exit', (code, signal) => r({ code, signal }))) };
};
const groupSignal = (c) => (sig) => { try { process.kill(-c.pid, sig); } catch { /* gone */ } };
const { c: child, exited } = start('preview');
let stdout = '';
child.stdout.on('data', (d) => (stdout += d));
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); };
const report = { kind: 'preview-smoke', command: 'npm run preview', version: pkg.version, at: new Date().toISOString() };
let browser;
try {
  const t0 = Date.now();
  let res = null;
  while (Date.now() - t0 < 240_000 && child.exitCode === null) {
    res = await probe(`${BASE}/`).catch(() => null);
    if (res) break;
    await sleep(500);
  }
  check('npm run preview serves 127.0.0.1:4171 (build, then the runner on its default port)', res?.status === 200);
  const html = res ? await res.text() : '';
  report.entryAsset = /src="\/assets\/(index-[^"]+\.js)"/.exec(html)?.[1] ?? null;
  const entry = report.entryAsset ? await probe(`${BASE}/assets/${report.entryAsset}`) : null;
  report.entrySha256 = entry?.status === 200 ? createHash('sha256').update(Buffer.from(await entry.arrayBuffer())).digest('hex') : null;
  check('the served entry asset is identified by name and sha256', /^[0-9a-f]{64}$/.test(report.entrySha256 ?? ''));
  report.listenerPid = listenerPid(4171);
  check('the process listening on 4171 is identified', report.listenerPid > 0);
  const session = /<meta name="cbpr-session" content="([^"]{16,})"/.exec(html)?.[1];
  check('/ carries this start’s session', !!session);
  const cfg = session ? await probe(`${BASE}/api/config`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-cbpr-session': session }, body: '{}' }) : null;
  report.apiVersion = cfg?.status === 200 ? ((await cfg.json()).runner?.version ?? null) : null;
  check('the runner API reports this release', report.apiVersion === pkg.version);
  const recover = await probe(`${BASE}/recover`);
  check('/recover carries this start’s session', recover.status === 200 && /<meta name="cbpr-session" content="[^"]{16,}"/.test(await recover.text()));
  check('the runner prints the /recover address', stdout.includes(`Open on this computer: ${BASE}/recover`));
  check('the native signer listens on 4172', await portOpen(4172));
  browser = await chromium.launch(NO_SIGNALS);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const connected = async () => (await page.getByTestId('caps').locator('[data-cap="runner"]').getAttribute('data-ok', { timeout: 15_000 })) === 'true';
  await page.goto(`${BASE}/recover`);
  await page.getByTestId('caps').waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('[data-cap="runner"]')?.getAttribute('data-ok') === 'true', null, { timeout: 15_000 }).catch(() => {});
  check('a browser on /recover is connected with no pairing', await connected());
  report.runnerLabel = (await page.getByTestId('caps').locator('[data-cap="runner"]').innerText()).replace(/\s+/g, ' ').trim();
  check('the connected runner is this release', report.runnerLabel.includes(pkg.version));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('[data-cap="runner"]')?.getAttribute('data-ok') === 'true', null, { timeout: 15_000 }).catch(() => {});
  check('still connected after reload', await connected());
  await page.getByTestId('nav-guide').click();
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('[data-cap="runner"]')?.getAttribute('data-ok') === 'true', null, { timeout: 15_000 }).catch(() => {});
  check('still connected after back', await connected());
  await page.goForward();
  await page.goBack();
  check('still connected after forward and back', await connected());
  report.npmPid = child.pid;
} catch (e) {
  check('smoke ran to the end', false, e instanceof Error ? e.message.slice(0, 200) : 'error');
} finally {
  const bothClosed = async () => { for (let i = 0; i < 10; i++) { if (!(await portOpen(4171)) && !(await portOpen(4172))) return true; await sleep(300); } return false; };
  const stopped = await stopAll({ closeBrowser: browser ? () => browser.close() : undefined, signal: groupSignal(child), exited, portsClosed: bothClosed });
  check('Ctrl-C stops it and both ports close', stopped);
  if (!stopped) check('after SIGKILL both ports are closed', ctl.finish(child.pid, await bothClosed()));
  else ctl.finish(child.pid, true);
}

// The static preview of the same build: no runner, and the page says so.
const stat = start('preview:static');
const STATIC = 'http://127.0.0.1:4181';
let sbrowser;
try {
  const t0 = Date.now();
  let res = null;
  while (Date.now() - t0 < 60_000 && stat.c.exitCode === null) {
    res = await probe(`${STATIC}/recover`).catch(() => null);
    if (res) break;
    await sleep(300);
  }
  check('npm run preview:static serves 127.0.0.1:4181', res?.status === 200);
  check('the static preview carries no session', !!res && !/name="cbpr-session"/.test(await res.text()));
  sbrowser = await chromium.launch(NO_SIGNALS);
  const page = await sbrowser.newPage();
  await page.goto(`${STATIC}/recover`);
  await page.getByTestId('caps').waitFor({ timeout: 30_000 });
  const ui = (await page.getByTestId('caps').locator('[data-cap="ui"]').innerText()).replace(/\s+/g, ' ');
  const runnerOk = await page.getByTestId('caps').locator('[data-cap="runner"]').getAttribute('data-ok');
  check('the tool on the static preview says it has no runner', /Static preview/.test(ui) && runnerOk === 'false');
} catch (e) {
  check('static preview smoke ran to the end', false, e instanceof Error ? e.message.slice(0, 200) : 'error');
} finally {
  const closed4181 = async () => { for (let i = 0; i < 10; i++) { if (!(await portOpen(4181))) return true; await sleep(300); } return false; };
  const ok = await stopAll({ closeBrowser: sbrowser ? () => sbrowser.close() : undefined, signal: groupSignal(stat.c), exited: stat.exited, portsClosed: closed4181 });
  check('Ctrl-C stops the static preview and 4181 closes', ok);
  if (!ok) check('after SIGKILL 4181 is closed', ctl.finish(stat.c.pid, await closed4181()));
  else ctl.finish(stat.c.pid, true);
}
report.checks = checks;
writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
const failed = checks.filter((c) => !c.ok).length;
console.log(`${checks.length - failed}/${checks.length} checks passed; report ${out}`);
// An interrupt that arrived during the run owns the exit (130) and its own cleanup report.
if (ctl.pending) await ctl.pending;
process.exit(failed ? 1 : 0);
