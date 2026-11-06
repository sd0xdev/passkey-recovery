#!/usr/bin/env node
// Packs the runner and starts it the way a user does: `npm exec --package ./<tgz>` in an empty folder, with npm's cache,
// npm's user config and the runner's store isolated in that folder (HOME is not changed).
//   node scripts/release/pack-smoke.mjs [--out release-out] [--keep]
// Needs a fresh `npm run build` (dist/ and dist-server/) and network for npm to fetch the pinned Anvil optional dependency.
// Writes <out>/<tarball>, <out>/<tarball>.sha256 and <out>/pack-smoke.json (version, sha256, file list, case results).
// Exit 1 when any case fails. Nothing is published.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterrupt, reapGroups } from './smoke-lib.mjs';

const args = process.argv.slice(2);
const outDir = resolve(args.includes('--out') ? args[args.indexOf('--out') + 1] : 'release-out');
const keep = args.includes('--keep');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const f of ['dist/index.html', 'dist-server/runner.mjs']) if (!existsSync(f)) throw new Error(`${f} is missing: run npm run build first`);

mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'cbpr-pack-smoke-'));
const cache = join(work, 'npm-cache');
const userconfig = join(work, 'npmrc');
const store = join(work, 'store');
const app = join(work, 'app');
for (const d of [cache, store, app]) mkdirSync(d);
writeFileSync(userconfig, '');

// The runner never needs a private RPC; drop anything that could point at one.
const env = { ...process.env, npm_config_cache: cache, npm_config_userconfig: userconfig, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', CBPR_TEST_STORE_DIR: store };
for (const k of Object.keys(env)) if (k.startsWith('CBPR_') && k !== 'CBPR_TEST_STORE_DIR') delete env[k];

// 1. npm pack (no lifecycle scripts run: the package has none).
const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', outDir], { env, encoding: 'utf8' }))[0];
const tgz = join(outDir, packed.filename);
const sha256 = createHash('sha256').update(readFileSync(tgz)).digest('hex');
writeFileSync(`${tgz}.sha256`, `${sha256}  ${packed.filename}\n`);
copyFileSync(tgz, join(app, packed.filename));
const files = packed.files.map((f) => f.path).sort();

const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const portOpen = (port) => new Promise((r) => { const s = createServer(); s.once('error', () => r(true)); s.listen(port, '127.0.0.1', () => s.close(() => r(false))); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Processes still running whose command line mentions the smoke folder (the installed package lives there). */
const leftovers = () => execFileSync('ps', ['-Ao', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(work) && !l.includes('ps -Ao'));
/** Every group started and not yet confirmed gone (by group liveness, never by command line). */
let groups = [];
/** A process group is alive while any member is: a signal-0 probe of the group (ESRCH = gone, EPERM = alive). */
const groupAlive = (pgid) => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const killLeftovers = () => { for (const l of leftovers()) try { process.kill(Number(l.trim().split(' ')[0]), 'SIGKILL'); } catch { /* gone */ } };
// A Ctrl-C or SIGTERM to the smoke itself stops every runner it started (they are detached process groups), then
// any process still running from the smoke folder, and removes the folder unless --keep (smoke-lib.mjs `createInterrupt`).
const ctl = createInterrupt({
  signalGroup: (pgid, sig) => { try { process.kill(-pgid, sig); } catch { /* gone */ } },
  portsHeld: async () => [...leftovers(), ...groups.filter(groupAlive).map((g) => `group ${g}`)],
  wait: sleep,
  exit: (code) => process.exit(code),
  report: (left) => {
    killLeftovers();
    if (!keep) rmSync(work, { recursive: true, force: true });
    console.error(`interrupted; ${left.length} process(es) from the smoke folder were still running after SIGKILL and were killed`);
  },
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void ctl.interrupt());

/** Runs `npm exec … passkey-recovery <argv>` in the empty app folder as its own process group. */
function runPkg(argv) {
  const child = spawn('npm', ['exec', '--yes', '--package', `./${packed.filename}`, '--', 'passkey-recovery', ...argv], { cwd: app, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  ctl.started(child.pid);
  groups.push(child.pid);
  const res = { child, stdout: '', stderr: '', code: null, signal: null };
  child.stdout.on('data', (d) => (res.stdout += d));
  child.stderr.on('data', (d) => (res.stderr += d));
  res.done = new Promise((r) => child.on('exit', (code, signal) => r(Object.assign(res, { code, signal }))));
  return res;
}
const within = (p, ms, what) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${what}: no exit within ${ms} ms`); })]);
const killGroup = (r, sig = 'SIGKILL') => { try { process.kill(-r.child.pid, sig); } catch { /* already gone */ } };
const cases = [];
async function check(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    cases.push({ name, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
  } catch (e) {
    cases.push({ name, ok: false, ms: Date.now() - t0, error: e.message });
  }
  // A case that timed out may leave its npm wrapper (and children) running: SIGKILL every group still alive, wait
  // for it to go, and release from the interrupt list only the groups that are really gone.
  const still = await reapGroups({ groups, alive: groupAlive, kill: (g) => { try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ } }, wait: sleep });
  for (const g of groups) if (!still.includes(g)) ctl.finish(g, true);
  groups = still;
  const c = cases.at(-1);
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${name}${c.ok ? '' : `: ${c.error}`}`);
  if (still.length) {
    cases.push({ name: `${name}: cleanup`, ok: false, error: `${still.length} process group(s) still alive after SIGKILL` });
    console.log(`FAIL ${name}: cleanup: ${still.length} process group(s) still alive after SIGKILL`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

await check('--version prints the package version', async () => {
  const r = await within(runPkg(['--version']).done, 180_000, '--version');
  expect(r.code === 0 && r.stdout.trim() === pkg.version, `exit ${r.code}, stdout ${JSON.stringify(r.stdout.trim())}`);
});
await check('--help prints usage with the tarball command', async () => {
  const r = await within(runPkg(['--help']).done, 60_000, '--help');
  expect(r.code === 0 && r.stdout.includes('npm exec --yes --package ./passkey-recovery-<version>.tgz'), `exit ${r.code}`);
  expect(r.stdout.includes('[--port 4171]'), 'the default port in --help is not 4171');
});
await check('an unknown flag exits 2 with a message', async () => {
  const r = await within(runPkg(['--bogus']).done, 60_000, '--bogus');
  expect(r.code === 2 && r.stderr.trim().length > 0, `exit ${r.code}, stderr ${JSON.stringify(r.stderr.trim().slice(0, 120))}`);
  return r.stderr.trim().split('\n').at(-1);
});
await check('a non-https --allow-origin is refused', async () => {
  const r = await within(runPkg(['--allow-origin', 'http://evil.example']).done, 60_000, 'allow-origin');
  expect(r.code === 2 && /--allow-origin/.test(r.stderr), `exit ${r.code}`);
  return r.stderr.trim().split('\n').at(-1);
});
await check('a port already in use exits 1 and leaves nothing running', async () => {
  const port = await freePort();
  const blocker = createServer().listen(port, '127.0.0.1');
  await new Promise((r) => blocker.once('listening', r));
  const signerPort = await freePort();
  try {
    const r = await within(runPkg(['--port', String(port), '--signer-port', String(signerPort)]).done, 60_000, 'port in use');
    expect(r.code === 1 && /could not start on 127\.0\.0\.1:\d+ \(EADDRINUSE\)/.test(r.stderr) && !/\n\s+at /.test(r.stderr), `exit ${r.code}, stderr ${JSON.stringify(r.stderr.trim().slice(0, 160))}`);
    await sleep(500);
    expect(!(await portOpen(signerPort)), 'the native signer port is still open');
    return r.stderr.trim().split('\n').at(-1);
  } finally {
    blocker.close();
  }
});
await check('start, serve the UI on 127.0.0.1, then Ctrl-C stops every process', async () => {
  const port = await freePort();
  const signerPort = await freePort();
  const r = runPkg(['--port', String(port), '--signer-port', String(signerPort), '--allow-origin', 'https://site.example']);
  try {
    const t0 = Date.now();
    let res;
    while (Date.now() - t0 < 60_000) {
      res = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
      if (res || r.code !== null) break;
      await sleep(300);
    }
    expect(res && res.status === 200, `UI did not answer (exit ${r.code}): ${r.stderr.trim().slice(0, 200)}`);
    const html = await res.text();
    expect(/<div id="root">/.test(html), 'index.html not served');
    expect((res.headers.get('content-security-policy') ?? '').includes("default-src 'self'"), 'no CSP header');
    expect(/Pairing code: [A-Z0-9]{4}-[A-Z0-9]{4}/.test(r.stdout), 'no pairing code printed');
    expect(r.stdout.includes('Anvil pinned'), 'Anvil is not the pinned build');
    expect(r.stdout.includes(`Open on this computer: http://127.0.0.1:${port}/recover`), 'the /recover address is not printed');
    // The page the runner serves connects by itself: /recover carries this start's session (never printed here).
    const recover = await fetch(`http://127.0.0.1:${port}/recover`);
    expect(recover.status === 200 && /<meta name="cbpr-session" content="[^"]{16,}"/.test(await recover.text()), '/recover has no session meta');
    // The website command's --allow-origin works: that exact https origin gets hello; any other origin is refused.
    const hello = (origin) => fetch(`http://127.0.0.1:${port}/api/hello`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'cross-site' }, body: '{}' });
    const ok = await hello('https://site.example');
    const okBody = ok.status === 200 ? await ok.json() : null;
    expect(okBody?.protocol === 1 && okBody?.version === pkg.version && ok.headers.get('access-control-allow-origin') === 'https://site.example', `allowed origin hello: ${ok.status}`);
    for (const o of ['https://evil.example', 'http://site.example', 'https://site.example.evil.example']) {
      const bad = await hello(o);
      expect(bad.status === 403 && bad.headers.get('access-control-allow-origin') === null, `${o} was not refused (${bad.status})`);
    }
    // The pairing exchange the website runs: the printed code (read here, never written out) pairs that origin
    // once; its token reaches a paired-only route; the same code does not pair a second time.
    const code = /Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(r.stdout)?.[1];
    const site = { 'content-type': 'application/json', origin: 'https://site.example', 'sec-fetch-site': 'cross-site' };
    const pairOnce = () => fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST', headers: site, body: JSON.stringify({ code }) });
    const paired = await pairOnce();
    const token = paired.status === 200 ? (await paired.json()).token : null;
    expect(typeof token === 'string' && token.length >= 16, `the printed code did not pair (${paired.status})`);
    const cfg = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: { ...site, 'x-cbpr-pair': token }, body: '{}' });
    expect(cfg.status === 200 && (await cfg.json()).runner?.version === pkg.version, `the pair token was not accepted (${cfg.status})`);
    const noToken = await fetch(`http://127.0.0.1:${port}/api/config`, { method: 'POST', headers: site, body: '{}' });
    expect(noToken.status === 401, `a paired-only route answered without a token (${noToken.status})`);
    const again = await pairOnce();
    expect(again.status === 410, `the same code paired twice (${again.status})`);
    expect(await portOpen(signerPort), 'native signer port is not open');
    killGroup(r, 'SIGINT');
    await within(r.done, 15_000, 'SIGINT');
    expect(r.stdout.includes('stopped; no process started by the runner is left running.'), `no clean stop line (exit ${r.code}, signal ${r.signal})`);
    await sleep(500);
    expect(!(await portOpen(port)) && !(await portOpen(signerPort)), 'a port is still open after stop');
    const left = leftovers();
    expect(left.length === 0, `processes left: ${left.length}`);
    return { exit: r.code, signal: r.signal, stdoutLines: r.stdout.trim().split('\n').length };
  } finally {
    if (r.code === null) killGroup(r);
  }
});
const report = {
  name: pkg.name,
  version: pkg.version,
  tarball: packed.filename,
  sha256,
  size: packed.size,
  unpackedSize: packed.unpackedSize,
  entryCount: packed.entryCount,
  files,
  node: process.version,
  npm: execFileSync('npm', ['--version'], { env, encoding: 'utf8' }).trim(),
  platform: `${process.platform}-${process.arch}`,
  isolation: { npmCache: 'temp', npmUserconfig: 'empty temp file', storeDir: 'CBPR_TEST_STORE_DIR in temp', homeChanged: false },
  cases,
  at: new Date().toISOString(),
};
writeFileSync(join(outDir, 'pack-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
for (const g of groups) try { process.kill(-g, 'SIGKILL'); } catch { /* gone */ }
killLeftovers();
if (!keep) rmSync(work, { recursive: true, force: true });
const failed = cases.filter((c) => !c.ok).length;
console.log(`${packed.filename} sha256 ${sha256}; ${cases.length - failed}/${cases.length} cases passed`);
// An interrupt that arrived during the run owns the exit (130) and its own cleanup report.
if (ctl.pending) await ctl.pending;
process.exit(failed ? 1 : 0);
