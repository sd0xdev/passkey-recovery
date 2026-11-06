// Playwright web servers for the browser e2e (bundled by vite.e2e.config.mts, run from the repo root):
//   • 127.0.0.1:4174 — `vite preview` of the static build (no sidecar: the no-sidecar error state and
//     the DevTools helper check);
//   • 127.0.0.1:4175 — the real sidecar bundle in SYNTHETIC testchain mode, against an offline anvil
//     (chainId 9745) that starts EMPTY: the registry infrastructure is not deployed, so the full flow
//     deploys it step by step through the page's EIP-1193 wallet, exactly as on a fresh chain;
//   • 127.0.0.1:4176 — a SYNTHETIC "custom provider" for the RPC settings e2e: /rpc/<E2E_RPC_SECRET>
//     forwards to that testchain, /other/<E2E_RPC_SECRET> to a second chain with the same chainId and
//     another genesis; GET /hits counts requests; GET /world describes the synthetic accounts (public
//     data and fixture seeds only); POST /fund {address} gives a synthetic gas wallet 5 XPL on the
//     testchain; GET /pair-code is the runner's latest pairing code and POST /runner/restart restarts
//     the runner and answers its fresh code; any other path is a 404;
//   • 127.0.0.1:4177/4178 — the local runner bundle (dist-server/runner.mjs) in testchain mode with its
//     native signer: a FAKE `op` (synthetic item), a temp keystore dir in explicit test mode, a low scrypt
//     cost, and `--allow-origin https://127.0.0.1:4179` — the website path a user runs, no test-only origin switch;
//   • 127.0.0.1:4179 — the hosted build (dist-hosted/) served over HTTPS (a self-signed certificate made for
//     this run, which the browser context accepts) with exactly its `_headers`, as the website is;
//   • 127.0.0.1:4180 — the same hosted build over plain HTTP, like `wrangler dev`: a static preview that cannot pair.
// No network, no real keys: the gas wallet is anvil's own dev account (the page reaches it only through
// the test's mock EIP-1193 provider) or a key generated in the test, and every wallet owner is a
// throwaway fixture key. The real 1Password CLI is never run.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { getAddress, isAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { fakeOp, opAccountId, opId } from '../fixtures/fakeOp';
import { syntheticGasWallet } from '../fixtures/keystore';
import { E2E_RPC_SECRET, type E2eWorld } from './e2e-constants';
import { startTestchain, type Testchain } from './testchain';
import { startWorld, type World } from './world';

const children: ChildProcess[] = [];
let w: World | undefined;
let other: Testchain | undefined;
let op: ReturnType<typeof fakeOp> | undefined;
let storeDir: string | undefined;
let certDir: string | undefined;
let ksWallet: ReturnType<typeof syntheticGasWallet> | undefined;
let ksChosen: ReturnType<typeof syntheticGasWallet> | undefined;
let ksManifest = '';
let runner: ChildProcess | undefined;
let startRunner: () => Promise<string> = () => Promise.reject(new Error('not started'));

async function main() {
  w = await startWorld({ deployInfra: false });
  other = await startTestchain(undefined, ['--timestamp', '1000000']);
  // A: undeployed, created with nonce 0, one Passkey at index 0 — the full check → deploy → move → track flow.
  const A = await w.account({ passkeys: [{ index: 0, seed: 0x21 }], nonce: 0n, deploy: false });
  // B: undeployed, created with factory nonce 7 and two owners (an address owner at 0, the Passkey at 1).
  const B = await w.account({ passkeys: [{ index: 1, seed: 0x22 }], others: [{ index: 0, bytes: ('0x' + '00'.repeat(12) + '11'.repeat(20)) as `0x${string}` }], nonce: 7n, deploy: false });
  // C: undeployed, created with factory nonce 3, one Passkey at index 0 — the keyboard-only flow, deploy included.
  const C = await w.account({ passkeys: [{ index: 0, seed: 0x23 }], nonce: 3n, deploy: false });
  // D: undeployed, created with factory nonce 5, one Passkey at index 0 — a deploy step left while the wallet checks its chain.
  const D = await w.account({ passkeys: [{ index: 0, seed: 0x24 }], nonce: 5n, deploy: false });
  // E: browser File gas payer (no browser wallet). F: native 1Password gas payer through the runner.
  const E = await w.account({ passkeys: [{ index: 0, seed: 0x25 }], nonce: 11n, deploy: false });
  const F = await w.account({ passkeys: [{ index: 0, seed: 0x26 }], nonce: 12n, deploy: false });
  // G: undeployed — the hosted page plans its deploy through the paired runner's fork (HOST-02).
  const G = await w.account({ passkeys: [{ index: 0, seed: 0x27 }], nonce: 13n, deploy: false });
  // H, I: the UX-01 journey counts (test/e2e/ux-journeys.spec.ts) — H through the hosted page, I on the runner page.
  const H = await w.account({ passkeys: [{ index: 0, seed: 0x28 }], nonce: 14n, deploy: false });
  const I = await w.account({ passkeys: [{ index: 0, seed: 0x29 }], nonce: 15n, deploy: false });
  // J, K: UX-02 journeys on the website — J with a browser File payer, K with 1Password through the runner.
  const J = await w.account({ passkeys: [{ index: 0, seed: 0x2a }], nonce: 16n, deploy: false });
  const K = await w.account({ passkeys: [{ index: 0, seed: 0x2b }], nonce: 17n, deploy: false });
  for (const a of [A, B, C, D, E, F, G, H, I, J, K]) {
    await w.fundNative(a.address, 3n * 10n ** 18n);
    await w.fundToken(a.address, 250_000_000n);
  }
  await w.fundNative(w.gasWallet, 50n * 10n ** 18n);
  // The existing gas wallet (the Terminal signer's format), all SYNTHETIC: a throwaway keystore (0600) in a temp
  // dir, its public manifest next to it, and its password in an item of the fake op's first account.
  ksWallet = syntheticGasWallet();
  // A SYNTHETIC item shaped like a real one, whose raw gas key is in its "password" field.
  const pwKey = generatePrivateKey();
  const pwKeyAddress = privateKeyToAccount(pwKey).address;
  ksManifest = join(ksWallet.dir, 'gas-wallet-public.json');
  // A second SYNTHETIC keystore the user chooses (not the manifest's): its real (link-free) path is in a field of a
  // fake item beside its password, and the same file is what the e2e picks in the file input.
  ksChosen = syntheticGasWallet();
  const ksChosenPath = realpathSync(ksChosen.manifest.keystore);
  writeFileSync(ksManifest, JSON.stringify(ksWallet.manifest), { mode: 0o600 });
  const world: E2eWorld = {
    rpc: w.tc.url,
    gasWallet: w.gasWallet,
    accounts: {
      A: { address: A.address, owners: A.owners, nonce: A.nonce.toString(), passkey: { index: 0, seed: 0x21 } },
      B: { address: B.address, owners: B.owners, nonce: B.nonce.toString(), passkey: { index: 1, seed: 0x22 } },
      C: { address: C.address, owners: C.owners, nonce: C.nonce.toString(), passkey: { index: 0, seed: 0x23 } },
      D: { address: D.address, owners: D.owners, nonce: D.nonce.toString(), passkey: { index: 0, seed: 0x24 } },
      E: { address: E.address, owners: E.owners, nonce: E.nonce.toString(), passkey: { index: 0, seed: 0x25 } },
      F: { address: F.address, owners: F.owners, nonce: F.nonce.toString(), passkey: { index: 0, seed: 0x26 } },
      G: { address: G.address, owners: G.owners, nonce: G.nonce.toString(), passkey: { index: 0, seed: 0x27 } },
      H: { address: H.address, owners: H.owners, nonce: H.nonce.toString(), passkey: { index: 0, seed: 0x28 } },
      I: { address: I.address, owners: I.owners, nonce: I.nonce.toString(), passkey: { index: 0, seed: 0x29 } },
      J: { address: J.address, owners: J.owners, nonce: J.nonce.toString(), passkey: { index: 0, seed: 0x2a } },
      K: { address: K.address, owners: K.owners, nonce: K.nonce.toString(), passkey: { index: 0, seed: 0x2b } },
    },
    recipient: getAddress('0x5a000000000000000000000000000000000e2e01'),
    opLink: `https://start.1password.com/open/i?a=${opAccountId('a')}&v=${opId('b')}&i=${opId('c')}&h=e2e.1password.com`,
    // FAKE_OP_REF's vault and item (test/fixtures/keystore.ts), in the same account as opLink.
    passwordKeyItem: { address: pwKeyAddress, link: `https://start.1password.com/open/i?a=${opAccountId('a')}&v=${opId('b')}&i=${opId('d')}&h=e2e.1password.com` },
    chosenKeystore: { address: ksChosen.address, link: `https://start.1password.com/open/i?a=${opAccountId('a')}&v=${opId('b')}&i=${opId('e')}&h=e2e.1password.com`, path: ksChosenPath, file: ksChosenPath },
    keystoreWallet: { address: ksWallet.address, link: `https://start.1password.com/open/i?a=${opAccountId('a')}&v=${opId('a')}&i=${opId('b')}&h=e2e.1password.com` },
  };
  // The fake op is a SYNTHETIC desktop app with two accounts on one sign-in address, selected as op 2.x selects
  // them (account ID case-sensitive; fakeOp `accounts`). The link's account holds one item: a hex key generated
  // now, a note and a password field.
  const opItemJson = { id: opId('c'), vault: { id: opId('b') }, fields: [{ id: 'gaskey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }, { id: 'note', label: 'Note', type: 'STRING', value: 'synthetic e2e item' }, { id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: 'synthetic-e2e-pass-1' }] };
  const opItem = {
    accounts: [
      {
        id: opAccountId('a'),
        url: 'e2e.1password.com',
        vaults: {
          [opId('b')]: {
            [opId('c')]: opItemJson,
            [opId('e')]: {
              id: opId('e'),
              vault: { id: opId('b') },
              fields: [
                { id: 'keystore_path', label: 'keystore_path', type: 'STRING', value: ksChosenPath },
                { id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: ksChosen.password },
                { id: 'notesPlain', label: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: 'synthetic chosen keystore notes' },
              ],
            },
            [opId('d')]: {
              id: opId('d'),
              vault: { id: opId('b') },
              fields: [
                { id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: pwKey },
                { id: 'notesPlain', label: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: 'synthetic gas wallet notes' },
                { id: 'wallet_address', label: 'wallet_address', type: 'STRING', value: pwKeyAddress },
              ],
            },
          },
          [opId('a')]: { [opId('b')]: { id: opId('b'), vault: { id: opId('a') }, fields: [{ id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: ksWallet.password }] } },
        },
      },
      { id: opAccountId('z'), url: 'e2e.1password.com', vaults: { [opId('y')]: {} } },
    ],
  };
  op = fakeOp(opItem);
  storeDir = mkdtempSync(join(tmpdir(), 'cbpr-e2e-store-'));
  let pairCode = '';

  const hits = { rpc: 0, other: 0, bad: 0 };
  const upstreams: Record<string, string> = { [`/rpc/${E2E_RPC_SECRET}`]: w.tc.url, [`/other/${E2E_RPC_SECRET}`]: other.url };
  createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/hits') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hits));
      if (req.method === 'GET' && req.url === '/world') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(world));
      if (req.method === 'GET' && req.url === '/pair-code') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code: pairCode }));
      if (req.method === 'POST' && req.url === '/runner/restart')
        return void startRunner().then(
          (code) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ code })),
          () => res.writeHead(500).end(),
        );
      // The user cancelling the 1Password approval (SYNTHETIC stderr, exit 1) until /op/restore puts the item back.
      if (req.method === 'POST' && req.url === '/op/cancel') return (op!.set({ stderr: '[ERROR] authorization was cancelled by the user\n', code: 1 }), res.writeHead(204).end());
      if (req.method === 'POST' && req.url === '/op/restore') return (op!.set(opItem), res.writeHead(204).end());
      // SYNTHETIC desktop-app integration outcomes, worded as op 2.x prints them: integration off / blocked by the OS,
      // the approval prompt dismissed, and an approval still pending (the fake sleeps until it is killed).
      if (req.method === 'POST' && req.url === '/op/unavailable') return (op!.set({ stderr: '[ERROR] No accounts configured for use with 1Password CLI.\n', code: 1 }), res.writeHead(204).end());
      if (req.method === 'POST' && req.url === '/op/dismiss') return (op!.set({ stderr: '[ERROR] authorization prompt dismissed, please try again\n', code: 1 }), res.writeHead(204).end());
      if (req.method === 'POST' && req.url === '/op/pending') return (op!.set({ ...opItem, sleepSec: 60 }), res.writeHead(204).end());
      if (req.method === 'POST' && req.url === '/fund') {
        const a = (JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { address?: string }).address;
        if (!a || !isAddress(a)) return res.writeHead(400).end();
        return void w!.fundNative(getAddress(a), 5n * 10n ** 18n).then(() => res.writeHead(204).end(), () => res.writeHead(500).end());
      }
      const to = upstreams[req.url ?? ''];
      if (!to) {
        hits.bad++;
        return res.writeHead(404).end();
      }
      if (to === w!.tc.url) hits.rpc++;
      else hits.other++;
      void fetch(to, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) }).then(
        async (r) => res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text()),
        () => res.writeHead(502).end(),
      );
    });
  }).listen(4176, '127.0.0.1');

  const env: NodeJS.ProcessEnv = { ...process.env, CBPR_PORT: '4175', CBPR_TESTCHAIN_RPC: w.tc.url };
  delete env.CBPR_RPC_URL_FILE;
  children.push(spawn('node', ['dist-server/sidecar.mjs'], { env, stdio: 'inherit' }));
  children.push(spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], { stdio: 'inherit' }));

  const renv: NodeJS.ProcessEnv = { ...env, CBPR_TEST_STORE_DIR: storeDir, CBPR_TEST_OP_BIN: op.bin, CBPR_TEST_KDF_N: '1024' };
  delete renv.CBPR_TEST_ALLOW_LOOPBACK_ORIGIN;
  delete renv.CBPR_PORT;
  // (Re)starts the runner and resolves with its first pairing code. A restart is how the hosted spec gets
  // a fresh single-use code (codes live 5 minutes; the runner's [p] key needs a TTY).
  startRunner = async () => {
    if (runner) {
      const old = runner;
      const gone = new Promise<void>((r) => (old.exitCode !== null || old.signalCode !== null ? r() : old.once('exit', () => r())));
      old.kill('SIGTERM');
      await gone;
      children.splice(children.indexOf(old), 1);
    }
    pairCode = '';
    const r = spawn('node', ['dist-server/runner.mjs', '--port', '4177', '--allow-origin', 'https://127.0.0.1:4179', '--gas-manifest', ksManifest], { env: renv, stdio: ['ignore', 'pipe', 'inherit'] });
    runner = r;
    children.push(r);
    return new Promise<string>((res, rej) => {
      r.once('exit', (c) => rej(new Error(`runner exited (${c})`)));
      r.stdout!.on('data', (d: Buffer) => {
        const text = d.toString('utf8');
        process.stdout.write(text.replace(/Pairing code: \S+/g, 'Pairing code: <hidden>'));
        const m = /Pairing code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text);
        if (m) res((pairCode = m[1]!));
      });
    });
  };
  await startRunner();

  // The hosted build, served the way a static host applies `_headers` (the `/*` block, verbatim).
  const hostedRoot = join(process.cwd(), 'dist-hosted');
  const hostedHeaders = Object.fromEntries(
    readFileSync(join(hostedRoot, '_headers'), 'utf8')
      .split('\n')
      .filter((l) => /^\s+[A-Za-z-]+:/.test(l))
      .map((l) => [l.trim().slice(0, l.trim().indexOf(':')), l.trim().slice(l.trim().indexOf(':') + 1).trim()]),
  );
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
  // Mimics Workers Static Assets with `not_found_handling: "404-page"` + `html_handling: "drop-trailing-slash"`
  // (wrangler.jsonc): an exact file is served; `<path>` serves `<path>/index.html`; `<path>/` and `….html`
  // redirect to the bare path; anything else is 404.html with status 404 — never an index.html fallback.
  const send = (res: ServerResponse, status: number, file: string) =>
    res.writeHead(status, { ...hostedHeaders, 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  // Case-sensitive like the real host, also on a case-insensitive disk (macOS): every segment must match a listed name.
  const isFile = (f: string) =>
    f.startsWith(hostedRoot + sep) &&
    existsSync(f) &&
    statSync(f).isFile() &&
    relative(hostedRoot, f)
      .split(sep)
      .every((seg, i, all) => readdirSync(join(hostedRoot, ...all.slice(0, i))).includes(seg));
  const hosted = (req: IncomingMessage, res: ServerResponse) => {
    const u = new URL(req.url ?? '/', 'http://hosted.invalid');
    let path: string;
    try {
      path = decodeURIComponent(u.pathname);
    } catch {
      return void send(res, 404, join(hostedRoot, '404.html'));
    }
    if (path.split('/').some((seg) => seg === '..') || path.includes('_headers')) return void send(res, 404, join(hostedRoot, '404.html'));
    const bare = path.replace(/\/index\.html$/, '/').replace(/\.html$/, '').replace(/(.)\/+$/, '$1');
    if (bare !== path) return void res.writeHead(307, { location: bare + u.search }).end();
    const exact = join(hostedRoot, path);
    if (path !== '/' && isFile(exact)) return void send(res, 200, exact);
    const page = join(hostedRoot, path, 'index.html');
    if (isFile(page)) return void send(res, 200, page);
    send(res, 404, join(hostedRoot, '404.html'));
  };
  // A throwaway self-signed certificate for this run only (never committed, removed on stop).
  certDir = mkdtempSync(join(tmpdir(), 'cbpr-e2e-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-days', '2', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  createHttpsServer({ key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) }, hosted).listen(4179, '127.0.0.1');
  createServer(hosted).listen(4180, '127.0.0.1');
  const stop = async () => {
    for (const c of children) c.kill('SIGTERM');
    op?.cleanup();
    if (ksWallet) rmSync(ksWallet.dir, { recursive: true, force: true });
    if (ksChosen) rmSync(ksChosen.dir, { recursive: true, force: true });
    if (storeDir) rmSync(storeDir, { recursive: true, force: true });
    if (certDir) rmSync(certDir, { recursive: true, force: true });
    await other?.stop();
    await w?.tc.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}
main().catch((e: unknown) => {
  process.stderr.write(`e2e servers failed: ${e instanceof Error ? e.message : 'error'}\n`);
  for (const c of children) c.kill('SIGTERM');
  if (certDir) rmSync(certDir, { recursive: true, force: true });
  void (w?.tc.stop() ?? Promise.resolve()).finally(() => process.exit(1));
});
