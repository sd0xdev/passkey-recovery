// Native signer service (server/runner/signerService.ts): the secret boundary for the op and native-File
// gas payers. Runs on a free loopback port with a fake auth callback, a FAKE op (never the real 1Password
// CLI), a temp KeystoreStore in explicit test mode and a low scrypt cost. All keys are synthetic.
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { appendFileSync, chmodSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { SIGNER_API } from '../../../src/config/signerApi';
import { join } from 'node:path';
import { getAddress, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { itemGetArgv, parsePrivateLink, realOpRunner, type OpRunner } from '../../../server/runner/op1p';
import { createSignerService } from '../../../server/runner/signerService';
import { KeystoreStore } from '../../../server/runner/store';
import type { IssuedTx } from '../../../server/relay';
import { encryptKeystore as nodeEncrypt, syntheticGasWallet, type SyntheticGasWallet } from '../../fixtures/keystore';
import { fakeOp, opAccountId, opId, type FakeOp } from '../../fixtures/fakeOp';

const FAST = { n: 2 ** 10, r: 8, p: 1 };
const SELF = 'http://127.0.0.1:4171';
const SITE = 'https://site.example';
const SESSION = `sess-${randomBytes(8).toString('hex')}`;
const PAIR = `pair-${randomBytes(8).toString('hex')}`;
const A = opAccountId('a1'); // as Copy Private Link writes it: capitals
const V = opId('b2');
const I = opId('c3');
const LINK = `https://start.1password.com/open/i?a=${A}&v=${V}&i=${I}&h=my.1password.com`;
const PASSWORD = 'synthetic keystore pass 1';

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = netServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: Record<string, unknown>;
}

let port: number;
function call(path: string, body: unknown = {}, headers: Record<string, string | undefined> = {}, method = 'POST'): Promise<Reply> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries({ host: `127.0.0.1:${port}`, origin: SELF, 'content-type': 'application/json', 'x-cbpr-session': SESSION, ...headers })) if (v !== undefined) h[k] = v;
  const payload = method === 'POST' ? JSON.stringify(body) : '';
  return new Promise((res, rej) => {
    const r = request({ host: '127.0.0.1', port, path, method, headers: h, agent: false }, (m) => {
      const chunks: Buffer[] = [];
      m.on('data', (c: Buffer) => chunks.push(c));
      m.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: Record<string, unknown> = {};
        try {
          json = text ? JSON.parse(text) : {};
        } catch {
          /* not JSON */
        }
        res({ status: m.statusCode ?? 0, headers: m.headers, text, json });
      });
    });
    r.on('error', rej);
    r.end(payload);
  });
}

/** The unlock a confirm / recheck is about (the page sends the one it shows). */
const kid = () => svc.status().keyId;
/** Signs as the sidecar does; for a picked file, answers the sign's challenge as the page would (re-read: same file). */
async function signWithPage(tx: Parameters<typeof svc.sign>[0], sha256?: string) {
  const signing = svc.sign(tx);
  const src = svc.status().source as { origin?: string; sha256?: string } | null;
  if (src?.origin === 'file') {
    const c = (await call('/gas/keystore/recheck', { keyId: kid(), sha256: sha256 ?? src.sha256, challenge: '' })).json.challenge;
    await call('/gas/keystore/recheck', { keyId: kid(), sha256: sha256 ?? src.sha256, challenge: c });
  }
  return signing;
}

const item = (fields: unknown[], id = I.toUpperCase()) => JSON.stringify({ id, vault: { id: V }, fields });

let base: string;
let op: FakeOp;
let store: KeystoreStore;
let changes: string[];
let authCalls: Array<[string, string | undefined, string | undefined]>;
let svc: ReturnType<typeof createSignerService>;

async function start(o: { op?: boolean; store?: boolean; opTimeoutMs?: number; opRunner?: OpRunner; manifest?: { path: string; chainId: number }; pickedSignWaitMs?: number } = {}) {
  port = await freePort();
  svc = createSignerService({
    port,
    allowedOrigins: [SELF, SITE],
    auth: async (origin, s, p) => (authCalls.push([origin, s, p]), (origin === SELF && s === SESSION) || (origin === SITE && p === PAIR)),
    op: o.op === false ? null : (o.opRunner ?? realOpRunner(op.bin, { PATH: '/usr/bin:/bin', HOME: op.dir })),
    store: o.store === false ? null : store,
    onChange: (r) => changes.push(r),
    kdf: FAST,
    opTimeoutMs: o.opTimeoutMs ?? 5000,
    ...(o.manifest ? { manifest: o.manifest } : {}),
    ...(o.pickedSignWaitMs ? { pickedSignWaitMs: o.pickedSignWaitMs } : {}),
  });
  await svc.listen();
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cbpr-signer-')));
  op = fakeOp();
  store = new KeystoreStore(join(base, 'store'), { explicitTest: true });
  changes = [];
  authCalls = [];
});
afterEach(async () => {
  await svc?.close();
  op.cleanup();
  rmSync(base, { recursive: true, force: true });
});

const txFor = (from: Address, over: Partial<IssuedTx> = {}): IssuedTx => ({ chainId: 9745, from, to: getAddress(`0x${randomBytes(20).toString('hex')}`), data: '0xa9059cbb' as Hex, nonce: 7n, gas: 120_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, ...over });

/** Unlocks a synthetic hex key through the op path and returns its address. */
async function unlockHex(): Promise<Address> {
  const pk = generatePrivateKey();
  op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: pk }]) });
  const r = await call('/gas/op/unlock', { link: LINK, field: 'synthkey' });
  expect(r.status).toBe(200);
  return privateKeyToAccount(pk).address;
}

describe('caller checks', () => {
  beforeEach(() => start());

  it('the page with its live session → 200 status; auth asked with origin and session', async () => {
    const r = await call('/gas/status');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ api: SIGNER_API, unlocked: false, address: null, keyId: null, confirmed: false, source: null, opAvailable: true, fileAvailable: true, manifestAvailable: false });
    expect(authCalls).toEqual([[SELF, SESSION, undefined]]);
  });

  it('a paired website with its pairing token → 200, with CORS echoing its exact origin', async () => {
    const r = await call('/gas/status', {}, { origin: SITE, 'x-cbpr-session': undefined, 'x-cbpr-pair': PAIR });
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(SITE);
  });

  it('an allowed origin that auth does not recognise → 401 (with CORS so the page can read it)', async () => {
    const r = await call('/gas/status', {}, { 'x-cbpr-session': 'stale-session' });
    expect(r.status).toBe(401);
    expect(r.headers['access-control-allow-origin']).toBe(SELF);
  });

  it('a website without a pairing token → 401', async () => {
    expect((await call('/gas/status', {}, { origin: SITE, 'x-cbpr-session': undefined })).status).toBe(401);
  });

  it.each([
    ['foreign Origin', { origin: 'https://evil.example' }, 403],
    ['missing Origin', { origin: undefined }, 403],
    ['DNS-rebinding Host', { host: 'evil.example' }, 421],
    ['localhost alias Host', { host: 'localhost:1' }, 421],
    ['form content type', { 'content-type': 'text/plain' }, 415],
  ])('%s → %i, and auth is never asked', async (_, h, code) => {
    const r = await call('/gas/status', {}, h as Record<string, string | undefined>);
    expect(r.status).toBe(code);
    expect(authCalls).toEqual([]);
  });

  it('a foreign origin gets no CORS header', async () => {
    expect((await call('/gas/status', {}, { origin: 'https://evil.example' })).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('GET → 405', async () => expect((await call('/gas/status', undefined, {}, 'GET')).status).toBe(405));

  it('an unknown endpoint → 404 (after authentication)', async () => {
    expect((await call('/gas/export')).status).toBe(404);
    expect(authCalls).toHaveLength(1);
  });
});

describe('CORS preflight', () => {
  beforeEach(() => start());
  const pre = (h: Record<string, string | undefined>) => call('/gas/op/unlock', undefined, { 'content-type': undefined, 'x-cbpr-session': undefined, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-cbpr-pair', ...h }, 'OPTIONS');

  it('an allowed origin asking for POST with our headers → 204 echoing exactly that origin', async () => {
    const r = await pre({ origin: SITE });
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(SITE);
    expect(r.headers['access-control-allow-methods']).toBe('POST');
    expect(r.headers['access-control-allow-private-network']).toBeUndefined();
  });

  it('Private Network Access is answered only when asked', async () => {
    expect((await pre({ origin: SITE, 'access-control-request-private-network': 'true' })).headers['access-control-allow-private-network']).toBe('true');
  });

  it.each([
    ['a foreign origin', { origin: 'https://evil.example' }, 403],
    ['no origin', { origin: undefined }, 403],
    ['a non-POST method', { origin: SITE, 'access-control-request-method': 'PUT' }, 403],
    ['an extra header', { origin: SITE, 'access-control-request-headers': 'content-type, authorization' }, 403],
    ['a foreign Host', { origin: SITE, host: 'evil.example' }, 421],
  ])('%s → %i without Allow-Origin for foreigners', async (_, h, code) => {
    const r = await pre(h);
    expect(r.status).toBe(code);
    if (h.origin !== SITE) expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('a preflight never reaches auth', async () => {
    await pre({ origin: SITE });
    expect(authCalls).toEqual([]);
  });
});

describe('1Password (op) payer', () => {
  it('inspect returns field metadata and shapes, never values; op ran with exactly itemGetArgv', async () => {
    await start();
    const hex = generatePrivateKey();
    const ksPw = `pw-${randomBytes(8).toString('hex')}`;
    op.set({ stdout: item([
      { id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: hex },
      { id: 'synthks', label: 'Keystore', type: 'STRING', value: nodeEncrypt(randomBytes(32), ksPw) },
      { id: 'synthpw', label: 'Password', type: 'CONCEALED', value: ksPw },
    ]) });
    const r = await call('/gas/op/inspect', { link: LINK });
    expect(r.status).toBe(200);
    expect((r.json.fields as Array<{ id: string; shape: string }>).map((f) => [f.id, f.shape])).toEqual([['synthkey', 'private-key-hex'], ['synthks', 'keystore-v3'], ['synthpw', 'password-like']]);
    expect(r.text).not.toContain(hex.slice(2));
    expect(r.text).not.toContain(ksPw);
    expect(op.argv()).toEqual([...itemGetArgv(parsePrivateLink(LINK))]);
  });

  it('unlock with a hex-key field → the derived address, unconfirmed; the link is not echoed', async () => {
    await start();
    const addr = await unlockHex();
    const s = await call('/gas/status');
    expect(s.json).toMatchObject({ unlocked: true, address: addr, confirmed: false, source: { kind: 'op', field: 'synthkey' } });
    expect(s.text).not.toContain(I);
    expect(changes).toEqual(['op-unlocked']);
  });

  it('inspect names the address a raw-key field unlocks (UX: pick the field by its gas wallet); keystore and non-key fields get none', async () => {
    await start();
    const hex = generatePrivateKey();
    const ksPw = `pw-${randomBytes(8).toString('hex')}`;
    op.set({ stdout: item([
      { id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: hex },
      { id: 'synthks', label: 'Keystore', type: 'STRING', value: nodeEncrypt(randomBytes(32), ksPw) },
      { id: 'zero', label: 'Zero', type: 'CONCEALED', value: '0'.repeat(64) },
      { id: 'note', label: 'Note', type: 'STRING', value: 'synthetic note text' },
    ]) });
    const r = await call('/gas/op/inspect', { link: LINK });
    expect((r.json.fields as Array<{ id: string; address: string | null }>).map((f) => [f.id, f.address])).toEqual([['synthkey', privateKeyToAccount(hex).address], ['synthks', null], ['zero', null], ['note', null]]);
    expect(r.text).not.toContain(hex.slice(2));
    expect(changes).toEqual([]);
  });

  it('"unlock and use" with the address shown → unlocked and confirmed in one request', async () => {
    await start();
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address;
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: pk }]) });
    const r = await call('/gas/op/unlock', { link: LINK, field: 'synthkey', confirmAddress: addr.toLowerCase() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ unlocked: true, address: addr, confirmed: true });
    expect(changes).toEqual(['op-unlocked', 'confirmed']);
  });

  it.each([
    ['another address', () => privateKeyToAccount(generatePrivateKey()).address],
    ['not an address', () => '0x1234'],
    ['not a string', () => 7],
  ])('"unlock and use" with %s → 409 op-changed, nothing unlocked or confirmed', async (_l, other) => {
    await start();
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]) });
    const r = await call('/gas/op/unlock', { link: LINK, field: 'synthkey', confirmAddress: other() });
    expect([r.status, r.json.kind]).toEqual([409, 'op-changed']);
    expect((await call('/gas/status')).json).toMatchObject({ unlocked: false, confirmed: false });
    expect(changes).toEqual([]);
  });

  it('unlock with a keystore field needs its password field, then derives the keystore address', async () => {
    await start();
    const pk = randomBytes(32);
    const ksPw = `pw-${randomBytes(8).toString('hex')}`;
    op.set({ stdout: item([{ id: 'synthks', label: 'Keystore', value: nodeEncrypt(pk, ksPw) }, { id: 'synthpw', label: 'Password', value: ksPw }]) });
    expect((await call('/gas/op/unlock', { link: LINK, field: 'synthks' })).json).toMatchObject({ kind: 'op-field-password' });
    expect((await call('/gas/op/unlock', { link: LINK, field: 'synthks', passwordField: 'synthks' })).json).toMatchObject({ kind: 'op-field-password' });
    const r = await call('/gas/op/unlock', { link: LINK, field: 'synthks', passwordField: 'synthpw' });
    expect(r.json).toMatchObject({ unlocked: true, address: privateKeyToAccount(`0x${pk.toString('hex')}`).address });
  });

  it('a keystore field with a wrong password field → 400 file-wrong-password', async () => {
    await start();
    op.set({ stdout: item([{ id: 'synthks', value: nodeEncrypt(randomBytes(32), 'synthetic right pw') }, { id: 'synthpw', value: 'synthetic wrong pw' }]) });
    const r = await call('/gas/op/unlock', { link: LINK, field: 'synthks', passwordField: 'synthpw' });
    expect([r.status, r.json.kind]).toEqual([400, 'file-wrong-password']);
  });

  it.each([
    ['a password-like field', { field: 'synthpw' }],
    ['a field not in the item', { field: 'gone' }],
    ['no field', {}],
  ])('unlock with %s → 400 op-field, nothing unlocked', async (_, b) => {
    await start();
    op.set({ stdout: item([{ id: 'synthpw', value: 'synthetic-pass-123' }]) });
    const r = await call('/gas/op/unlock', { link: LINK, ...b });
    expect([r.status, r.json.kind]).toEqual([400, 'op-field']);
    expect(svc.status().unlocked).toBe(false);
  });

  it.each([
    ['all zeros', `0x${'0'.repeat(64)}`],
    ['the curve order n', '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'],
  ])('a 64-hex field that is not a valid secp256k1 scalar (%s) → 400 op-field, never 500', async (_, v) => {
    await start();
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: v }]) });
    const r = await call('/gas/op/unlock', { link: LINK, field: 'synthkey' });
    expect([r.status, r.json.kind]).toEqual([400, 'op-field']);
    expect(svc.status().unlocked).toBe(false);
  });

  // Field choice is free in the page (a field named "password" may hold the key); the signer decides from the value
  // it reads again on unlock. SYNTHETIC item shaped like a real one: password / notesPlain / wallet_address.
  describe('any field may be chosen; only the value read again on unlock decides', () => {
    const pk = generatePrivateKey();
    const addr = privateKeyToAccount(pk).address;
    const realLike = (password: string) => [
      { id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: password },
      { id: 'notesPlain', label: 'notesPlain', type: 'STRING', purpose: 'NOTES', value: 'synthetic gas wallet notes' },
      { id: 'wallet_address', label: 'wallet_address', type: 'STRING', value: addr },
      { id: 'blank', label: 'blank', type: 'STRING', value: '' },
    ];

    it('a raw key in the label=password / CONCEALED field → inspect names its address; "unlock and use" installs exactly it', async () => {
      await start();
      op.set({ stdout: item(realLike(pk)) });
      const fields = (await call('/gas/op/inspect', { link: LINK })).json.fields as Array<{ id: string; shape: string; address: string | null }>;
      expect(fields.map((f) => [f.id, f.shape, f.address])).toEqual([['password', 'private-key-hex', addr], ['notesPlain', 'other', null], ['wallet_address', 'password-like', null], ['blank', 'empty', null]]);
      const r = await call('/gas/op/unlock', { link: LINK, field: 'password', confirmAddress: addr });
      expect(r.json).toMatchObject({ unlocked: true, address: addr, confirmed: true, source: { kind: 'op', field: 'password' } });
      expect(r.text).not.toContain(pk.slice(2));
    });

    it.each([
      ['a note', 'notesPlain'],
      ['an address (not a key)', 'wallet_address'],
      ['an empty field', 'blank'],
      ['a password that is not a key', 'password'],
    ])('choosing %s → 400 op-field, op re-read the item, no key is left, no other field is used', async (_, field) => {
      await start();
      op.set({ stdout: item(realLike('synthetic-keystore-password-1')) });
      const r = await call('/gas/op/unlock', { link: LINK, field });
      expect([r.status, r.json.kind]).toEqual([400, 'op-field']);
      expect(op.argv()).toEqual([...itemGetArgv(parsePrivateLink(LINK))]);
      expect(svc.status()).toMatchObject({ unlocked: false, address: null });
      expect(changes).toEqual([]);
    });

    it('a note chosen while another field of the item holds a valid key → 400 op-field; that other key is never used', async () => {
      await start();
      op.set({ stdout: item([...realLike('synthetic-keystore-password-1'), { id: 'gaskey', label: 'Gas key', type: 'CONCEALED', value: pk }]) });
      const r = await call('/gas/op/unlock', { link: LINK, field: 'notesPlain' });
      expect([r.status, r.json.kind]).toEqual([400, 'op-field']);
      expect(svc.status()).toMatchObject({ unlocked: false, address: null });
    });

    it.each([
      ['63 hex', pk.slice(0, -1)],
      ['65 hex', `${pk}0`],
      ['inner whitespace', `${pk.slice(0, 20)} ${pk.slice(20)}`],
      ['two keys on two lines', `${pk}\n${generatePrivateKey()}`],
    ])('a near-key value (%s) is refused, never truncated, padded or split', async (_, value) => {
      await start();
      op.set({ stdout: item([{ id: 'password', label: 'password', type: 'CONCEALED', value }]) });
      const r = await call('/gas/op/unlock', { link: LINK, field: 'password' });
      expect([r.status, r.json.kind]).toEqual([400, 'op-field']);
      expect(svc.status().unlocked).toBe(false);
    });

    it('metadata out of date: a field that read as text now holds a key → unlock reads it again and opens it unconfirmed (the address is confirmed afterwards)', async () => {
      await start();
      op.set({ stdout: item(realLike('synthetic-keystore-password-1')) });
      expect(((await call('/gas/op/inspect', { link: LINK })).json.fields as Array<{ shape: string }>)[0]!.shape).toBe('password-like');
      op.set({ stdout: item(realLike(pk)) });
      const r = await call('/gas/op/unlock', { link: LINK, field: 'password' });
      expect(r.json).toMatchObject({ unlocked: true, address: addr, confirmed: false });
      expect((await call('/gas/confirm', { keyId: kid(), address: addr })).json).toMatchObject({ confirmed: true });
    });

    it('metadata out of date the other way: the shown key was replaced → 409 op-changed, nothing unlocked', async () => {
      await start();
      op.set({ stdout: item(realLike(pk)) });
      await call('/gas/op/inspect', { link: LINK });
      op.set({ stdout: item(realLike(generatePrivateKey())) });
      const r = await call('/gas/op/unlock', { link: LINK, field: 'password', confirmAddress: addr });
      expect([r.status, r.json.kind]).toEqual([409, 'op-changed']);
      expect(svc.status().unlocked).toBe(false);
    });

    it('a keystore picked without its password field → 400 op-field-password; with it → opens', async () => {
      await start();
      const kpk = randomBytes(32);
      op.set({ stdout: item([{ id: 'ks', label: 'password', type: 'CONCEALED', value: nodeEncrypt(kpk, 'synthetic ks pw 1') }, { id: 'pw', label: 'notesPlain', type: 'STRING', value: 'synthetic ks pw 1' }]) });
      expect((await call('/gas/op/unlock', { link: LINK, field: 'ks' })).json.kind).toBe('op-field-password');
      expect(svc.status().unlocked).toBe(false);
      const r = await call('/gas/op/unlock', { link: LINK, field: 'ks', passwordField: 'pw' });
      expect(r.json).toMatchObject({ unlocked: true, address: privateKeyToAccount(`0x${kpk.toString('hex')}`).address });
    });
  });

  it('a valid hex scalar next to it still unlocks (control for the scalar check)', async () => {
    await start();
    expect(await unlockHex()).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('a malformed link → 400 op-link and op never runs', async () => {
    await start();
    const r = await call('/gas/op/inspect', { link: LINK.replace('start.1password.com', 'evil.example') });
    expect([r.status, r.json.kind]).toEqual([400, 'op-link']);
    expect(op.argv()).toBeNull();
  });

  it.each([
    ['[ERROR] you are not currently signed in', 'op-locked'],
    ['[ERROR] authorization prompt dismissed, please try again', 'op-cancelled'],
    ['[ERROR] No accounts configured for use with 1Password CLI.', 'op-unavailable'],
    ['[ERROR] no account found for filter synthetic', 'op-account'],
    ['[ERROR] permission denied for this vault', 'op-denied'],
    ['[ERROR] cancelled by user', 'op-cancelled'],
    ['[ERROR] found no accounts', 'op-account'],
    ['[ERROR] "x" isn\'t an item', 'op-not-found'],
    ['[ERROR] synthetic', 'op-failed'],
  ])('op failing with %j → 409 %s, and op’s stderr is withheld', async (stderr, kind) => {
    await start();
    const canary = `CANARY-${randomBytes(8).toString('hex')}`;
    op.set({ stderr: `${stderr} ${canary}`, code: 1 });
    const r = await call('/gas/op/inspect', { link: LINK });
    expect([r.status, r.json.kind]).toEqual([409, kind]);
    expect(r.text).not.toContain(canary);
  });

  it('op returning another item than the link names → 409 op-not-found', async () => {
    await start();
    op.set({ stdout: item([], opId('d4')) });
    expect((await call('/gas/op/inspect', { link: LINK })).json.kind).toBe('op-not-found');
  });

  it('op not answering in time → 409 op-timeout', async () => {
    await start({ opTimeoutMs: 300 });
    op.set({ sleepSec: 30 });
    const r = await call('/gas/op/inspect', { link: LINK });
    expect([r.status, r.json.kind]).toEqual([409, 'op-timeout']);
  });

  it('without an op runner → 409 op-missing, status says opAvailable false', async () => {
    await start({ op: false });
    expect((await call('/gas/op/inspect', { link: LINK })).json.kind).toBe('op-missing');
    expect((await call('/gas/op/unlock', { link: LINK, field: 'x' })).json.kind).toBe('op-missing');
    expect(svc.status().opAvailable).toBe(false);
  });

  it('regression: a lock while an unlock is still reading 1Password is answered at once; the late key is not installed', async () => {
    await start();
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]), delaySec: 1 });
    const unlocking = call('/gas/op/unlock', { link: LINK, field: 'synthkey' });
    await new Promise((r) => setTimeout(r, 300));
    const lock = await call('/gas/lock');
    expect([lock.status, lock.json.unlocked]).toEqual([200, false]);
    const late = await unlocking;
    expect([late.status, svc.status().unlocked, svc.status().address]).toEqual([409, false, null]);
  });

  it('a lock naming a keyId locks only that key: another keyId leaves the newer key installed; the current keyId, or none, locks', async () => {
    await start();
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]) });
    const first = await call('/gas/op/unlock', { link: LINK, field: 'synthkey' });
    const older = first.json.keyId as string;
    expect(typeof older).toBe('string');
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]) });
    const second = await call('/gas/op/unlock', { link: LINK, field: 'synthkey' });
    const newer = second.json.keyId as string;
    expect(newer).not.toBe(older);
    const stale = await call('/gas/lock', { keyId: older });
    expect([stale.status, stale.json.unlocked, stale.json.keyId]).toEqual([200, true, newer]);
    expect(svc.status().unlocked).toBe(true);
    const own = await call('/gas/lock', { keyId: newer });
    expect([own.status, own.json.unlocked, svc.status().keyId]).toEqual([200, false, null]);
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]) });
    expect((await call('/gas/op/unlock', { link: LINK, field: 'synthkey' })).json.unlocked).toBe(true);
    expect((await call('/gas/lock', {})).json.unlocked).toBe(false);
  });

  it('a lock with a keyId that is present but not a string is refused (400) and locks nothing', async () => {
    await start();
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]) });
    const current = (await call('/gas/op/unlock', { link: LINK, field: 'synthkey' })).json.keyId as string;
    for (const keyId of [7, null, { id: current }, [current]]) {
      const r = await call('/gas/lock', { keyId });
      expect(r.status).toBe(400);
      expect([svc.status().unlocked, svc.status().keyId]).toEqual([true, current]);
    }
    expect((await call('/gas/lock', { keyId: current })).json.unlocked).toBe(false);
  });

  it('a lock (Stop waiting, or leaving the mode) while an unlock waits on the 1Password approval ends that op: 409 op-cancelled, approving later reads nothing, and a retry works', async () => {
    await start({ opTimeoutMs: 60_000 });
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]), delaySec: 30 });
    const t0 = Date.now();
    const unlocking = call('/gas/op/unlock', { link: LINK, field: 'synthkey' });
    let pid: number | null = null;
    for (let i = 0; i < 100 && pid === null; i++) (await new Promise((r) => setTimeout(r, 20)), (pid = op.pid()));
    expect(pid).toBeGreaterThan(0);
    expect((await call('/gas/lock')).status).toBe(200);
    const late = await unlocking;
    expect([late.status, late.json.kind, svc.status().unlocked]).toEqual([409, 'op-cancelled', false]);
    const alive = (n: number) => { try { process.kill(n, 0); return true; } catch { return false; } };
    // The kill is sent with the lock; the process is reaped a moment later.
    for (let i = 0; i < 100 && alive(pid!); i++) await new Promise((r) => setTimeout(r, 20));
    expect(alive(pid!)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(10_000);
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]) });
    expect((await call('/gas/op/unlock', { link: LINK, field: 'synthkey' })).json.unlocked).toBe(true);
  });

  it.each([['/gas/op/unlock'], ['/gas/op/inspect']])('regression: a lock that lands while a %s body is still uploading cancels it before op runs: 409 op-cancelled, op never started, nothing returned or installed', async (path) => {
    await start();
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]) });
    const payload = Buffer.from(JSON.stringify({ link: LINK, field: 'synthkey' }));
    const half = Math.floor(payload.length / 2);
    const headers = { host: `127.0.0.1:${port}`, origin: SELF, 'content-type': 'application/json', 'x-cbpr-session': SESSION, 'content-length': String(payload.length) };
    let req!: ReturnType<typeof request>;
    const answer = new Promise<{ status: number; body: string }>((res, rej) => {
      req = request({ host: '127.0.0.1', port, path, method: 'POST', headers, agent: false }, (m) => {
        let body = '';
        m.on('data', (c: Buffer) => (body += c.toString('utf8')));
        m.on('end', () => res({ status: m.statusCode ?? 0, body }));
      });
      req.on('error', rej);
    });
    req.write(payload.subarray(0, half));
    await new Promise((r) => setTimeout(r, 200));
    expect((await call('/gas/lock')).status).toBe(200);
    req.end(payload.subarray(half));
    const r = await answer;
    expect([r.status, JSON.parse(r.body).kind]).toEqual([409, 'op-cancelled']);
    expect(op.argv()).toBeNull();
    expect([svc.status().unlocked, r.body.includes('synthkey')]).toEqual([false, false]);
  });

  it('a lock that lands just as op answers an inspect: the fields it read are not returned (409 op-cancelled)', async () => {
    // An op runner with no cancel (as if op had already printed when the lock came): the generation check holds.
    let answer!: (b: Buffer) => void;
    const started = new Promise<void>((ok) => {
      const runner: OpRunner = { run: () => (ok(), new Promise<Buffer>((r) => (answer = r))) };
      void start({ opRunner: runner });
    });
    await new Promise((r) => setTimeout(r, 100));
    const inspecting = call('/gas/op/inspect', { link: LINK });
    await started;
    expect((await call('/gas/lock')).status).toBe(200);
    answer(Buffer.from(item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }])));
    const r = await inspecting;
    expect([r.status, r.json.kind, r.text.includes('synthkey')]).toEqual([409, 'op-cancelled', false]);
  });

  it('regression: a lock that lands while an unlock body is still uploading cancels that unlock; the late key is not installed', async () => {
    await start();
    op.set({ stdout: item([{ id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: generatePrivateKey() }]) });
    const payload = Buffer.from(JSON.stringify({ link: LINK, field: 'synthkey' }));
    const half = Math.floor(payload.length / 2);
    const headers = { host: `127.0.0.1:${port}`, origin: SELF, 'content-type': 'application/json', 'x-cbpr-session': SESSION, 'content-length': String(payload.length) };
    let req!: ReturnType<typeof request>;
    const unlocking = new Promise<number>((res, rej) => {
      req = request({ host: '127.0.0.1', port, path: '/gas/op/unlock', method: 'POST', headers, agent: false }, (m) => (m.resume(), m.on('end', () => res(m.statusCode ?? 0))));
      req.on('error', rej);
    });
    req.write(payload.subarray(0, half));
    await new Promise((r) => setTimeout(r, 200));
    const lock = await call('/gas/lock');
    expect([lock.status, lock.json.unlocked]).toEqual([200, false]);
    req.end(payload.subarray(half));
    expect([await unlocking, svc.status().unlocked, svc.status().address]).toEqual([409, false, null]);
  });

  it('a second request while one is in flight → 409 busy; a status read is still answered (version and state)', async () => {
    await start();
    op.set({ sleepSec: 1 });
    const first = call('/gas/op/inspect', { link: LINK });
    await new Promise((r) => setTimeout(r, 300));
    const second = await call('/gas/op/inspect', { link: LINK });
    expect([second.status, second.json.error]).toEqual([409, 'the signer is busy with another request']);
    const status = await call('/gas/status');
    expect([status.status, status.json.api, status.json.unlocked]).toEqual([200, SIGNER_API, false]);
    await first;
  });
});

describe('native File payer', () => {
  it('create with two different passwords → 400 file-weak-password, nothing written', async () => {
    await start();
    const r = await call('/gas/file/create', { password: 'synthetic pass one', repeat: 'synthetic pass two' });
    expect([r.status, r.json.kind]).toEqual([400, 'file-weak-password']);
    expect(store.list()).toEqual([]);
  });

  it('create with a too-short password → 400 file-weak-password', async () => {
    await start();
    expect((await call('/gas/file/create', { password: 'short', repeat: 'short' })).json.kind).toBe('file-weak-password');
  });

  it('create → a 0600 keystore named for the new address, unlocked but unconfirmed', async () => {
    await start();
    const r = await call('/gas/file/create', { password: PASSWORD, repeat: PASSWORD });
    expect(r.status).toBe(200);
    const addr = r.json.address as string;
    expect(r.json).toMatchObject({ unlocked: true, confirmed: false, file: `gas-${addr.slice(2).toLowerCase()}.json` });
    expect(store.list()).toEqual([{ file: r.json.file, address: addr.toLowerCase() }]);
    if (process.platform !== 'win32') expect(statSync(join(store.dir, r.json.file as string)).mode & 0o777).toBe(0o600);
    expect(changes).toEqual(['file-created']);
  });

  it('list → the store dir and its keystores', async () => {
    await start();
    const c = await call('/gas/file/create', { password: PASSWORD, repeat: PASSWORD });
    expect((await call('/gas/file/list')).json).toEqual({ dir: store.dir, files: [{ file: c.json.file, address: (c.json.address as string).toLowerCase() }] });
  });

  it('after lock: unlock with the wrong password → 400 file-wrong-password and stays locked; the right one unlocks', async () => {
    await start();
    const c = await call('/gas/file/create', { password: PASSWORD, repeat: PASSWORD });
    await call('/gas/lock');
    const bad = await call('/gas/file/unlock', { file: c.json.file, password: `${PASSWORD}!` });
    expect([bad.status, bad.json.kind]).toEqual([400, 'file-wrong-password']);
    expect(svc.status().unlocked).toBe(false);
    const good = await call('/gas/file/unlock', { file: c.json.file, password: PASSWORD });
    expect(good.json).toMatchObject({ unlocked: true, address: c.json.address, source: { kind: 'file', file: c.json.file } });
    expect(changes).toEqual(['file-created', 'locked', 'file-unlocked']);
  });

  it('a keystore whose key does not match its file name → 400 file-address-mismatch, nothing unlocked', async () => {
    await start();
    const named = randomBytes(20).toString('hex');
    const file = store.create(named, nodeEncrypt(randomBytes(32), PASSWORD));
    const r = await call('/gas/file/unlock', { file, password: PASSWORD });
    expect([r.status, r.json.kind]).toEqual([400, 'file-address-mismatch']);
    expect(svc.status().unlocked).toBe(false);
  });

  it.each([
    ['an unknown keystore name', { file: '../secret.json', password: PASSWORD }, 400, 'store-not-found'],
    ['an absent keystore', { file: `gas-${'0'.repeat(40)}.json`, password: PASSWORD }, 400, 'store-not-found'],
    ['no password', { file: `gas-${'0'.repeat(40)}.json` }, 400, undefined],
  ])('unlock with %s → %i %s', async (_, b, code, kind) => {
    await start();
    const r = await call('/gas/file/unlock', b);
    expect([r.status, r.json.kind]).toEqual([code, kind]);
  });

  it('a keystore holding a zero key → 400 file-malformed, nothing unlocked (never 500)', async () => {
    await start();
    const file = store.create(randomBytes(20).toString('hex'), nodeEncrypt(Buffer.alloc(32), PASSWORD));
    const r = await call('/gas/file/unlock', { file, password: PASSWORD });
    expect([r.status, r.json.kind]).toEqual([400, 'file-malformed']);
    expect(svc.status().unlocked).toBe(false);
  });

  it('without a store → 400 store-unsafe-dir on every file route', async () => {
    await start({ store: false });
    for (const p of ['/gas/file/list', '/gas/file/create', '/gas/file/unlock']) expect((await call(p, { password: PASSWORD, repeat: PASSWORD, file: 'x' })).json.kind, p).toBe('store-unsafe-dir');
    expect(svc.status().fileAvailable).toBe(false);
  });
});

describe('address confirmation (GAS-05)', () => {
  beforeEach(() => start());

  it('confirm before any unlock → 409', async () => {
    expect((await call('/gas/confirm', { keyId: kid(), address: `0x${'1'.repeat(40)}` })).status).toBe(409);
  });

  it.each([['another address', () => `0x${randomBytes(20).toString('hex')}`], ['a truncated address', () => '0x1234'], ['a non-string', () => 7]])('confirming %s → 409, still unconfirmed', async (_, a) => {
    await unlockHex();
    const r = await call('/gas/confirm', { keyId: kid(), address: a() });
    expect([r.status, r.json.error]).toEqual([409, 'the confirmed address is not the derived one']);
    expect(svc.status().confirmed).toBe(false);
  });

  it('confirming the derived address (any case) → confirmed', async () => {
    const addr = await unlockHex();
    const r = await call('/gas/confirm', { keyId: kid(), address: addr.toLowerCase() });
    expect(r.json).toMatchObject({ confirmed: true, address: addr });
    expect(changes).toEqual(['op-unlocked', 'confirmed']);
  });

  it('a new unlock voids an earlier confirmation', async () => {
    await call('/gas/confirm', { address: await unlockHex(), keyId: kid() });
    await unlockHex();
    expect(svc.status().confirmed).toBe(false);
  });
});

describe('sign() (IPC from the sidecar)', () => {
  beforeEach(() => start());

  it('refused before unlock', async () => {
    expect(await svc.sign(txFor(privateKeyToAccount(generatePrivateKey()).address))).toEqual({ ok: false, reason: 'no gas key is unlocked in the runner', code: 'sign-locked' });
  });

  it('refused after unlock but before confirm', async () => {
    expect(await svc.sign(txFor(await unlockHex()))).toEqual({ ok: false, reason: 'confirm the gas wallet address first', code: 'sign-unconfirmed' });
  });

  it('refused for another `from` than the unlocked key', async () => {
    await call('/gas/confirm', { address: await unlockHex(), keyId: kid() });
    const r = await svc.sign(txFor(privateKeyToAccount(generatePrivateKey()).address));
    expect(r).toEqual({ ok: false, reason: 'the transaction is for another gas wallet than the unlocked one', code: 'sign-other-wallet' });
  });

  it('refused for a nonce beyond Number.MAX_SAFE_INTEGER', async () => {
    const addr = await unlockHex();
    await call('/gas/confirm', { keyId: kid(), address: addr });
    expect(await svc.sign(txFor(addr, { nonce: BigInt(Number.MAX_SAFE_INTEGER) + 1n }))).toEqual({ ok: false, reason: 'nonce out of range', code: 'sign-bad-tx' });
  });

  it('after confirm → an EIP-1559 raw tx of exactly the issued fields, recovered to the derived address', async () => {
    const addr = await unlockHex();
    await call('/gas/confirm', { keyId: kid(), address: addr });
    const tx = txFor(addr.toLowerCase() as Address);
    const r = await svc.sign(tx);
    if (!r.ok) throw new Error(r.reason);
    expect(parseTransaction(r.raw)).toMatchObject({ type: 'eip1559', chainId: tx.chainId, to: tx.to.toLowerCase(), data: tx.data, nonce: Number(tx.nonce), gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
    expect(parseTransaction(r.raw).value ?? 0n).toBe(0n);
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'] })).toBe(addr);
  });

  it('a File-created key signs too, recovered to the file’s address', async () => {
    const c = await call('/gas/file/create', { password: PASSWORD, repeat: PASSWORD });
    await call('/gas/confirm', { keyId: kid(), address: c.json.address });
    const r = await svc.sign(txFor(c.json.address as Address));
    if (!r.ok) throw new Error(r.reason);
    expect(await recoverTransactionAddress({ serializedTransaction: r.raw as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'] })).toBe(c.json.address);
  });
});

describe('lock', () => {
  beforeEach(() => start());

  it('clears key, source and confirmation; sign() is refused afterwards', async () => {
    const addr = await unlockHex();
    await call('/gas/confirm', { keyId: kid(), address: addr });
    const r = await call('/gas/lock');
    expect(r.json).toEqual({ api: SIGNER_API, unlocked: false, address: null, keyId: null, confirmed: false, source: null, opAvailable: true, fileAvailable: true, manifestAvailable: false });
    expect(svc.address()).toBeNull();
    expect(await svc.sign(txFor(addr))).toMatchObject({ ok: false, reason: 'no gas key is unlocked in the runner', code: 'sign-locked' });
    expect(changes).toEqual(['op-unlocked', 'confirmed', 'locked']);
  });

  it('regression (NX-02): close() during an inspect waiting on 1Password ends that op and returns; no op outlives the signer', async () => {
    op.set({ sleepSec: 30 });
    const t0 = Date.now();
    const pending = call('/gas/op/inspect', { link: LINK });
    let pid: number | null = null;
    for (let i = 0; i < 100 && pid === null; i++) (await new Promise((res) => setTimeout(res, 20)), (pid = op.pid()));
    expect(pid).toBeGreaterThan(0);
    await svc.close();
    expect(() => process.kill(pid!, 0)).toThrow();
    expect((await pending).status).toBeGreaterThanOrEqual(400);
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('close() drops the key', async () => {
    await unlockHex();
    await svc.close();
    expect(svc.address()).toBeNull();
  });
});

// Regression: listen() rejects on a busy port, which signerChild.ts relies on to report
// "signer port … is in use" instead of the runner waiting on `ready` forever.
describe('listen()', () => {
  it('rejects when the port is already in use', async () => {
    const occupier = netServer();
    const busy = await new Promise<number>((res) => occupier.listen(0, '127.0.0.1', () => res((occupier.address() as { port: number }).port)));
    const s = createSignerService({ port: busy, allowedOrigins: [SELF], auth: async () => false, op: null, store: null, onChange: () => undefined });
    s.server.on('error', () => undefined); // keep the test process alive; the module itself attaches none
    try {
      const outcome = await Promise.race([s.listen().then(() => 'listening', () => 'rejected'), new Promise<string>((r) => setTimeout(() => r('pending'), 1000))]);
      expect(outcome).toBe('rejected');
    } finally {
      await new Promise<void>((r) => occupier.close(() => r()));
    }
  });
});

// The existing gas wallet (the Terminal signer's format): a SYNTHETIC encrypted keystore with its public manifest,
// and a SYNTHETIC desktop app (case-sensitive account model, fakeOp `accounts`) whose item holds its password.
describe('existing gas wallet: keystore + 1Password password (synthetic)', () => {
  const ACC = opAccountId('k1');
  const KV = opId('a'); // FAKE_OP_REF's vault and item (test/fixtures/keystore.ts)
  const KI = opId('b');
  const KLINK = `https://start.1password.com/open/i?a=${ACC}&v=${KV}&i=${KI}&h=my.1password.com`;
  let w: SyntheticGasWallet;
  let manifestPath: string;
  const writeManifest = (m: Record<string, unknown>) => writeFileSync(manifestPath, JSON.stringify(m), { mode: 0o600 });
  const accounts = (fields: unknown[]) => [
    { id: ACC, url: 'my.1password.com', vaults: { [KV]: { [KI]: { id: KI, vault: { id: KV }, fields } } } },
    // Another account on the same sign-in address, holding an item with the same ids and another password.
    { id: opAccountId('k2'), url: 'my.1password.com', vaults: { [KV]: { [KI]: { id: KI, vault: { id: KV }, fields: [{ id: 'password', label: 'password', type: 'CONCEALED', value: 'synthetic-other-account' }] } } } },
  ];
  const pwFields = () => [
    { id: 'username', label: 'username', type: 'STRING', value: 'synthetic-user' },
    { id: 'password', label: 'password', type: 'CONCEALED', value: w.password },
  ];
  beforeEach(async () => {
    w = syntheticGasWallet();
    manifestPath = join(base, 'gas-wallet-public.json');
    writeManifest(w.manifest);
    op.set({ accounts: accounts(pwFields()) });
    await start({ manifest: { path: manifestPath, chainId: 9745 } });
  });
  afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

  it('/gas/status manifestAvailable follows the manifest on disk: valid → true; missing or malformed → false', async () => {
    expect((await call('/gas/status')).json.manifestAvailable).toBe(true);
    rmSync(manifestPath);
    expect((await call('/gas/status')).json.manifestAvailable).toBe(false);
    writeFileSync(manifestPath, '{"address":"not an address"}', { mode: 0o600 });
    expect((await call('/gas/status')).json.manifestAvailable).toBe(false);
    writeManifest(w.manifest);
    expect((await call('/gas/status')).json.manifestAvailable).toBe(true);
  });

  it('status → the manifest’s address and keystore path (public data only); op does not run', async () => {
    const r = await call('/gas/manifest/status', { manifest: '/etc/hosts', keystore: '/etc/hosts' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ address: w.address, chainId: 9745, keystore: w.manifest.keystore });
    expect(op.argv()).toBeNull();
  });

  it('a page cannot point status or unlock at another manifest: a valid decoy wallet’s path under any key is ignored', async () => {
    const decoy = syntheticGasWallet();
    try {
      const decoyPath = join(decoy.dir, 'gas-wallet-public.json');
      writeFileSync(decoyPath, JSON.stringify(decoy.manifest), { mode: 0o600 });
      const lure = Object.fromEntries(['path', 'manifest', 'manifestPath', 'gasManifest', 'file', 'dir'].map((k) => [k, decoyPath]));
      const s = await call('/gas/manifest/status', lure);
      expect(s.json).toEqual({ address: w.address, chainId: 9745, keystore: w.manifest.keystore });
      const u = await call('/gas/manifest/unlock', { passwordField: 'password', ...lure, link: KLINK, confirmAddress: w.address });
      expect(u.status).toBe(200);
      expect(svc.address()).toBe(w.address);
    } finally {
      rmSync(decoy.dir, { recursive: true, force: true });
    }
  });

  it('unlock with the password item’s link → that account’s item read once, key installed and confirmed, password never returned', async () => {
    const r = await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: w.address.toLowerCase() });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ unlocked: true, address: w.address, confirmed: true, source: { kind: 'manifest', address: w.address } });
    expect(op.argv()).toEqual(['item', 'get', KI, '--vault', KV, '--account', ACC, '--format', 'json']);
    expect(r.text).not.toContain(w.password);
    expect(changes).toEqual(['manifest-unlocked', 'confirmed']);
    const signed = await svc.sign(txFor(w.address));
    expect(signed.ok && (await recoverTransactionAddress({ serializedTransaction: signed.raw as never }))).toBe(w.address);
  });

  it.each([
    ['the account id lowercased', KLINK.replace(`a=${ACC}`, `a=${ACC.toLowerCase()}`), 400, 'op-link'],
    ['another item of the same vault', KLINK.replace(`i=${KI}`, `i=${opId('c')}`), 400, 'manifest-link'],
    ['another vault', KLINK.replace(`v=${KV}`, `v=${opId('d')}`), 400, 'manifest-link'],
  ])('a link with %s → %i %s; op does not run, nothing unlocks', async (_, link, status, kind) => {
    const r = await call('/gas/manifest/unlock', { passwordField: 'password', link, confirmAddress: w.address });
    expect([r.status, r.json.kind]).toEqual([status, kind]);
    expect(op.argv()).toBeNull();
    expect(svc.status().unlocked).toBe(false);
  });

  it.each([
    ['no confirmed address', undefined],
    ['another address', getAddress(`0x${randomBytes(20).toString('hex')}`)],
  ])('%s → 400 manifest-stale; op does not run', async (_, confirmAddress) => {
    const r = await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress });
    expect([r.status, r.json.kind]).toEqual([400, 'manifest-stale']);
    expect(op.argv()).toBeNull();
  });

  it('the manifest changed after the page showed its address → manifest-stale; the newly named wallet is not unlocked', async () => {
    const shown = (await call('/gas/manifest/status')).json.address;
    const other = syntheticGasWallet();
    try {
      writeManifest(other.manifest);
      const r = await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: shown });
      expect([r.status, r.json.kind]).toEqual([400, 'manifest-stale']);
      expect(op.argv()).toBeNull();
      expect(svc.status().unlocked).toBe(false);
    } finally {
      rmSync(other.dir, { recursive: true, force: true });
    }
  });

  it('the password of another account on the same sign-in address is never used: that link opens nothing', async () => {
    const r = await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK.replace(`a=${ACC}`, `a=${opAccountId('k2')}`), confirmAddress: w.address });
    expect([r.status, r.json.kind]).toEqual([400, 'manifest-wrong-password']);
    expect(svc.status().unlocked).toBe(false);
  });

  it.each([
    ['a byte appended (sha256 differs)', () => appendFileSync(w.manifest.keystore, ' '), 'manifest-changed'],
    ['readable by others (0644)', () => chmodSync(w.manifest.keystore, 0o644), 'manifest-keystore'],
    ['gone', () => rmSync(w.manifest.keystore), 'manifest-keystore'],
    [
      'a symlink',
      () => {
        const real = `${w.manifest.keystore}.real`;
        writeFileSync(real, '', { mode: 0o600 });
        rmSync(w.manifest.keystore);
        symlinkSync(real, w.manifest.keystore);
      },
      'manifest-keystore',
    ],
  ])('a keystore file %s → 400 %s on status and unlock; op does not run', async (_, spoil, kind) => {
    spoil();
    expect((await call('/gas/manifest/status')).json.kind).toBe(kind);
    const r = await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: w.address });
    expect([r.status, r.json.kind]).toEqual([400, kind]);
    expect(op.argv()).toBeNull();
  });

  it.each([
    ['missing', () => rmSync(manifestPath), 'manifest-missing'],
    ['for another chain', () => writeManifest({ ...w.manifest, chainId: 1 }), 'manifest-chain'],
    ['with a password reference by name', () => writeManifest({ ...w.manifest, passwordReference: 'op://Private/Gas wallet/password' }), 'manifest-malformed'],
    ['with a relative keystore path', () => writeManifest({ ...w.manifest, keystore: 'keystore.json' }), 'manifest-malformed'],
    ['not JSON', () => writeFileSync(manifestPath, 'not json'), 'manifest-malformed'],
  ])('a manifest %s → 400 %s', async (_, spoil, kind) => {
    spoil();
    const r = await call('/gas/manifest/status');
    expect([r.status, r.json.kind]).toEqual([400, kind]);
  });

  it('the wrong password in the item → 400 manifest-wrong-password; nothing unlocks', async () => {
    op.set({ accounts: accounts([{ id: 'password', label: 'password', type: 'CONCEALED', value: 'synthetic wrong password' }]) });
    const r = await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: w.address });
    expect([r.status, r.json.kind]).toEqual([400, 'manifest-wrong-password']);
    expect(svc.status().unlocked).toBe(false);
  });

  it('an item without a password field → 400 manifest-password-field; a raw-key field is never taken instead', async () => {
    op.set({ accounts: accounts([{ id: 'gaskey', label: 'Gas key', type: 'CONCEALED', value: w.privateKey }]) });
    const r = await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: w.address });
    expect([r.status, r.json.kind]).toEqual([400, 'manifest-password-field']);
    expect(svc.status().unlocked).toBe(false);
  });

  it('a keystore that opens to another key than the manifest’s address → 400 manifest-address; nothing unlocks', async () => {
    const other = getAddress(`0x${randomBytes(20).toString('hex')}`);
    writeManifest({ ...w.manifest, address: other });
    const r = await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: other });
    expect([r.status, r.json.kind]).toEqual([400, 'manifest-address']);
    expect(svc.status().unlocked).toBe(false);
  });

  it('a lock while the unlock waits on the 1Password approval → 409 op-cancelled; nothing installed; a retry works', async () => {
    op.set({ accounts: accounts(pwFields()), sleepSec: 30 });
    const pending = call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: w.address });
    await expect.poll(() => op.pid(), { timeout: 5000 }).not.toBeNull();
    await call('/gas/lock');
    const r = await pending;
    expect([r.status, r.json.kind]).toEqual([409, 'op-cancelled']);
    expect(svc.status().unlocked).toBe(false);
    op.set({ accounts: accounts(pwFields()) });
    expect((await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: w.address })).json).toMatchObject({ unlocked: true, confirmed: true });
  });

  // Regression (review): the password field is the user's explicit choice here too — none is picked for them.
  it.each([
    ['no password field chosen', {}, 'manifest-password-field'],
    ['an empty choice', { passwordField: '' }, 'manifest-password-field'],
    ['a field the item does not have', { passwordField: 'nope' }, 'manifest-password-field'],
  ])('%s → 400 %s; op does not decide for the user, nothing unlocks', async (_, pick, kind) => {
    const r = await call('/gas/manifest/unlock', { link: KLINK, confirmAddress: w.address, ...pick });
    expect([r.status, r.json.kind, svc.status().unlocked]).toEqual([400, kind, false]);
  });
  it('the chosen field is used even when a “password” field exists: a note field → manifest-wrong-password (no fallback)', async () => {
    op.set({ accounts: accounts([...pwFields(), { id: 'note', label: 'note', type: 'STRING', value: 'synthetic note' }]) });
    const r = await call('/gas/manifest/unlock', { passwordField: 'note', link: KLINK, confirmAddress: w.address });
    expect([r.status, r.json.kind, svc.status().unlocked]).toEqual([400, 'manifest-wrong-password', false]);
  });
  it('a field labelled “password” under another id is not taken for the chosen id (exact id only)', async () => {
    op.set({ accounts: accounts([{ id: 'pw2', label: 'password', type: 'CONCEALED', value: w.password }]) });
    const r = await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: w.address });
    expect([r.status, r.json.kind]).toEqual([400, 'manifest-password-field']);
    expect((await call('/gas/manifest/unlock', { passwordField: 'pw2', link: KLINK, confirmAddress: w.address })).json.unlocked).toBe(true);
  });

  // Regression (review): the pinned keystore is read again before each sign; changed or gone → refused, key dropped.
  it.each([
    ['a byte appended', () => appendFileSync(w.manifest.keystore, ' ')],
    ['removed', () => rmSync(w.manifest.keystore)],
  ])('the manifest’s keystore %s after unlock → sign refused, the key dropped (keystore-changed)', async (_, spoil) => {
    expect((await call('/gas/manifest/unlock', { passwordField: 'password', link: KLINK, confirmAddress: w.address })).json.confirmed).toBe(true);
    spoil();
    expect(await svc.sign(txFor(w.address))).toEqual({ ok: false, reason: 'the keystore file changed after its address was confirmed; open it again', code: 'keystore-changed' });
    expect([svc.status().unlocked, changes.at(-1)]).toEqual([false, 'keystore-changed']);
  });
});

// The existing gas wallet chosen by the user (AC: item path field or picked file): a SYNTHETIC keystore at a real
// (link-free) temp path, a FAKE op item whose fields hold that path and the password. Never the real wallet or app.
describe('existing gas wallet: a keystore the user chooses (item path field or picked file; synthetic)', () => {
  let w: SyntheticGasWallet;
  let ksPath: string;
  let ksText: string;
  const fields = (over: Record<string, string> = {}) => [
    { id: 'kspath', label: 'keystore_path', type: 'STRING', value: over.kspath ?? ksPath },
    { id: 'pw', label: 'password', type: 'CONCEALED', value: over.pw ?? w.password },
    { id: 'note', label: 'notesPlain', type: 'STRING', value: 'synthetic note' },
  ];
  const byField = (o: Record<string, unknown> = {}) => ({ link: LINK, passwordField: 'pw', source: { kind: 'field', field: 'kspath' }, ...o });
  const byFile = (keystore: unknown = ksText, name = 'gas-keystore.json') => ({ link: LINK, passwordField: 'pw', source: { kind: 'file', name, keystore } });
  const SOURCES = [
    ['a path field of the item', () => byField()],
    ['a picked file', () => byFile()],
  ] as const;
  const recovered = (raw: Hex) => recoverTransactionAddress({ serializedTransaction: raw as Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'] });
  const withManifest = async (m: Record<string, unknown>) => {
    const path = join(base, 'gas-wallet-public.json');
    writeFileSync(path, JSON.stringify(m), { mode: 0o600 });
    await svc.close();
    await start({ manifest: { path, chainId: 9745 } });
  };
  beforeEach(async () => {
    w = syntheticGasWallet();
    ksPath = realpathSync(w.manifest.keystore);
    ksText = readFileSync(ksPath, 'utf8');
    op.set({ stdout: item(fields()) });
    await start();
  });
  afterEach(() => rmSync(w.dir, { recursive: true, force: true }));

  it.each(SOURCES)('%s → opens unconfirmed with the derived address; confirm → the signed tx recovers to it (= the gas payer)', async (_, body) => {
    const r = await call('/gas/keystore/unlock', body());
    expect([r.status, r.json.unlocked, r.json.address, r.json.confirmed]).toEqual([200, true, w.address, false]);
    expect(await svc.sign(txFor(w.address))).toEqual({ ok: false, reason: 'confirm the gas wallet address first', code: 'sign-unconfirmed' });
    // The page re-reads a picked file for the confirmation and sends its sha256 (ignored for a path source).
    expect((await call('/gas/confirm', { keyId: kid(), address: w.address, sha256: w.manifest.keystoreSha256 })).json.confirmed).toBe(true);
    const tx = txFor(w.address);
    const s = await signWithPage(tx);
    if (!s.ok) throw new Error(s.reason);
    expect([await recovered(s.raw), getAddress(tx.from)]).toEqual([w.address, w.address]);
    expect(changes).toEqual(['keystore-unlocked', 'confirmed']);
  });

  it('the status names the source truthfully (path read from the field / picked name) and carries no password or keystore text', async () => {
    const f = await call('/gas/keystore/unlock', byField());
    expect(f.json.source).toEqual({ kind: 'keystore', origin: 'field', field: 'kspath', passwordField: 'pw', path: ksPath, sha256: w.manifest.keystoreSha256, manifest: false });
    await call('/gas/lock');
    const u = await call('/gas/keystore/unlock', byFile(ksText, 'my-gas.json'));
    expect(u.json.source).toEqual({ kind: 'keystore', origin: 'file', name: 'my-gas.json', passwordField: 'pw', sha256: w.manifest.keystoreSha256, manifest: false });
    for (const t of [f.text, u.text, JSON.stringify(svc.status())]) {
      expect(t).not.toContain(w.password);
      expect(t).not.toContain(JSON.parse(ksText).crypto.ciphertext);
    }
  });

  it('never writes: the chosen keystore is unchanged and nothing new appears beside it', async () => {
    await call('/gas/keystore/unlock', byField());
    await call('/gas/confirm', { keyId: kid(), address: w.address });
    expect(readFileSync(ksPath, 'utf8')).toBe(ksText);
    expect(readdirSync(w.dir)).toEqual(['keystore.json']);
  });

  it.each([
    ['no password field', { passwordField: undefined }, 'keystore-password-field'],
    ['the password field is the path field', { passwordField: 'kspath' }, 'keystore-password-field'],
  ])('%s → 400 %s; op does not run', async (_, o, kind) => {
    const r = await call('/gas/keystore/unlock', byField(o));
    expect([r.status, r.json.kind, op.argv()]).toEqual([400, kind, null]);
  });

  it.each([
    ['no source', { source: undefined }],
    ['an unknown source kind', { source: { kind: 'path', path: '/etc/hosts' } }],
    ['a path sent by the page', { source: { kind: 'field', path: '/etc/hosts' } }],
  ])('%s → 400; op does not run; a page cannot send a path', async (_, o) => {
    const r = await call('/gas/keystore/unlock', byField(o));
    expect([r.status, op.argv()]).toEqual([400, null]);
  });

  it.each([
    ['not a keystore', 'synthetic not a keystore', 'keystore-format'],
    ['oversized', `${'x'.repeat(17 * 1024)}`, 'keystore-size'],
    ['empty', '', 'keystore-format'],
    ['not text', { crypto: {} }, 'keystore-format'],
  ])('a picked file %s → 400 %s before 1Password is asked', async (_, keystore, kind) => {
    const r = await call('/gas/keystore/unlock', byFile(keystore));
    expect([r.status, r.json.kind, op.argv()]).toEqual([400, kind, null]);
  });

  it.each(SOURCES)('%s with the wrong password in the chosen field → 400 keystore-wrong-password; nothing unlocks', async (_, body) => {
    op.set({ stdout: item(fields({ pw: 'synthetic wrong password' })) });
    const r = await call('/gas/keystore/unlock', body());
    expect([r.status, r.json.kind, svc.status().unlocked]).toEqual([400, 'keystore-wrong-password', false]);
  });

  it('the password comes only from the chosen field: choosing the note field → wrong-password, the "password" field is not tried', async () => {
    const r = await call('/gas/keystore/unlock', byField({ passwordField: 'note' }));
    expect([r.status, r.json.kind, svc.status().unlocked]).toEqual([400, 'keystore-wrong-password', false]);
  });

  it('a chosen field no longer in the item → 400 (path / password-field); nothing unlocks', async () => {
    expect((await call('/gas/keystore/unlock', byField({ source: { kind: 'field', field: 'gone' } }))).json.kind).toBe('keystore-path');
    expect((await call('/gas/keystore/unlock', byField({ passwordField: 'gone' }))).json.kind).toBe('keystore-password-field');
    expect(svc.status().unlocked).toBe(false);
  });

  describe('a malicious or wrong path in the field', () => {
    const at = (name: string) => join(realpathSync(w.dir), name);
    it.each([
      ['a note (not a path)', () => 'synthetic note', 'keystore-path'],
      ['relative', () => 'keystore.json', 'keystore-path'],
      ['a .. segment', () => `${realpathSync(w.dir)}/../x/keystore.json`, 'keystore-path'],
      ['missing', () => at('gone.json'), 'keystore-missing'],
      ['the directory', () => realpathSync(w.dir), 'keystore-not-file'],
      ['a symbolic link to the keystore', () => (symlinkSync(ksPath, at('link.json')), at('link.json')), 'keystore-symlink'],
      ['the keystore through a linked parent directory', () => (symlinkSync(realpathSync(w.dir), join(base, 'alias')), join(base, 'alias', 'keystore.json')), 'keystore-symlink'],
      ['readable by others', () => (chmodSync(ksPath, 0o644), ksPath), 'keystore-permissions'],
      ['oversized', () => (writeFileSync(ksPath, `${ksText}${' '.repeat(17 * 1024)}`), ksPath), 'keystore-size'],
    ])('%s → 400 %s; nothing unlocks', async (_, value, kind) => {
      op.set({ stdout: item(fields({ kspath: value() })) });
      const r = await call('/gas/keystore/unlock', byField());
      expect([r.status, r.json.kind, svc.status().unlocked]).toEqual([400, kind, false]);
    });

    it('a private file that is not a keystore → 400 keystore-format; the reply carries none of its content', async () => {
      const marker = `SYNTHETIC-${randomBytes(6).toString('hex')}`;
      writeFileSync(at('notes.json'), `{"note":"${marker}"}`, { mode: 0o600 });
      op.set({ stdout: item(fields({ kspath: at('notes.json') })) });
      const r = await call('/gas/keystore/unlock', byField());
      expect([r.status, r.json.kind]).toEqual([400, 'keystore-format']);
      expect(r.text).not.toContain(marker);
    });

    it('a system file (/etc/hosts) is refused; its content never appears in the reply', async () => {
      op.set({ stdout: item(fields({ kspath: '/etc/hosts' })) });
      const r = await call('/gas/keystore/unlock', byField());
      expect(r.status).toBe(400);
      expect(['keystore-permissions', 'keystore-symlink']).toContain(r.json.kind);
      expect(r.text).not.toContain('localhost');
    });
  });

  it('a lock while the unlock waits on the 1Password approval → 409 op-cancelled; nothing installed; a retry works', async () => {
    op.set({ stdout: item(fields()), sleepSec: 30 });
    const pending = call('/gas/keystore/unlock', byField());
    await expect.poll(() => op.pid(), { timeout: 5000 }).not.toBeNull();
    await call('/gas/lock');
    expect([(await pending).status, svc.status().unlocked]).toEqual([409, false]);
    op.set({ stdout: item(fields()) });
    expect((await call('/gas/keystore/unlock', byField())).json.unlocked).toBe(true);
  });

  it.each(SOURCES)('%s: a late reply (1Password answers after a lock) installs nothing', async (_, body) => {
    op.set({ stdout: item(fields()), delaySec: 1 });
    const unlocking = call('/gas/keystore/unlock', body());
    await new Promise((r) => setTimeout(r, 300));
    await call('/gas/lock');
    const late = await unlocking;
    expect([late.status, svc.status().unlocked, svc.status().address]).toEqual([409, false, null]);
  });

  it('switching the source voids the earlier authorization: the confirmed keystore key no longer signs', async () => {
    await call('/gas/keystore/unlock', byField());
    await call('/gas/confirm', { keyId: kid(), address: w.address });
    const other = await unlockHex();
    expect([svc.status().address, svc.status().confirmed]).toEqual([other, false]);
    expect(await svc.sign(txFor(w.address))).toEqual({ ok: false, reason: 'confirm the gas wallet address first', code: 'sign-unconfirmed' });
    // And back: field → picked file opens unconfirmed again.
    await call('/gas/confirm', { keyId: kid(), address: other });
    op.set({ stdout: item(fields()) });
    expect((await call('/gas/keystore/unlock', byFile())).status).toBe(200);
    expect([svc.status().address, svc.status().confirmed, (svc.status().source as { origin?: string }).origin]).toEqual([w.address, false, 'file']);
  });

  it('the keystore file changes after confirm → sign refused, the key dropped (keystore-changed); pending tracking is the sidecar’s and untouched', async () => {
    await call('/gas/keystore/unlock', byField());
    await call('/gas/confirm', { keyId: kid(), address: w.address });
    appendFileSync(ksPath, ' ');
    expect(await svc.sign(txFor(w.address))).toEqual({ ok: false, reason: 'the keystore file changed after its address was confirmed; open it again', code: 'keystore-changed' });
    expect([svc.status().unlocked, svc.status().confirmed, changes.at(-1)]).toEqual([false, false, 'keystore-changed']);
  });

  it.each([
    ['a byte appended', () => appendFileSync(ksPath, ' ')],
    ['replaced by another keystore', () => writeFileSync(ksPath, encryptKeystoreFor(), { mode: 0o600 })],
    ['removed', () => rmSync(ksPath)],
  ])('the keystore file %s between unlock and confirm → confirm 409 keystore-changed; nothing is authorized', async (_, spoil) => {
    await call('/gas/keystore/unlock', byField());
    spoil();
    const r = await call('/gas/confirm', { keyId: kid(), address: w.address });
    expect([r.status, r.json.kind, svc.status().unlocked, svc.status().confirmed]).toEqual([409, 'keystore-changed', false, false]);
  });

  describe('a picked file stays bound to the file the page still holds (it has no path the signer can re-read)', () => {
    beforeEach(async () => {
      await svc.close();
      await start({ pickedSignWaitMs: 400 });
      op.set({ stdout: item(fields()) });
      expect((await call('/gas/keystore/unlock', byFile())).status).toBe(200);
    });
    const SHA = () => w.manifest.keystoreSha256;
    const OTHER = 'cd'.repeat(32);
    const recheck = (sha256: string, challenge: unknown = '') => call('/gas/keystore/recheck', { keyId: kid(), sha256, challenge });
    const confirmed = async () => expect((await call('/gas/confirm', { keyId: kid(), address: w.address, sha256: SHA() })).json.confirmed).toBe(true);

    it.each([
      ['without a fresh re-read of the file', {}],
      ['with another file’s sha256 (the file changed)', { sha256: OTHER }],
      ['with an empty sha256 (the file cannot be read any more)', { sha256: '' }],
    ])('confirm %s → 409 keystore-changed; the key is dropped', async (_, extra) => {
      const r = await call('/gas/confirm', { keyId: kid(), address: w.address, ...extra });
      expect([r.status, r.json.kind, svc.status().unlocked, changes.at(-1)]).toEqual([409, 'keystore-changed', false, 'keystore-changed']);
    });

    it('after confirm, a recheck reporting another sha256 → 409 keystore-changed, key dropped, sign refused', async () => {
      await confirmed();
      const r = await recheck(OTHER);
      expect([r.status, r.json.kind, svc.status().unlocked]).toEqual([409, 'keystore-changed', false]);
      expect((await svc.sign(txFor(w.address))).ok).toBe(false);
    });

    it('each sign waits for a re-read made after it was asked: an earlier matching check does not authorize it', async () => {
      await confirmed();
      const before = (await recheck(SHA())).json.challenge;
      // The file changes after that successful check; nothing re-reads it → the sign is refused, never signed.
      expect(await svc.sign(txFor(w.address))).toEqual({ ok: false, reason: 'the picked keystore file was not read again for this transaction: keep the page that picked it open', code: 'keystore-stale' });
      // A report carrying a challenge from before the sign does not answer it either.
      const signing = svc.sign(txFor(w.address));
      const r = await recheck(SHA(), before);
      expect([r.status, r.json.pending]).toEqual([200, true]);
      expect((await signing).ok).toBe(false);
    });

    it('a sign answered by a re-read with the new challenge and the same sha256 → signed; the tx recovers to the address', async () => {
      await confirmed();
      const signing = svc.sign(txFor(w.address));
      const first = await recheck(SHA());
      expect(first.json.pending).toBe(true);
      expect((await recheck(SHA(), first.json.challenge)).json.pending).toBe(false);
      const s = await signing;
      if (!s.ok) throw new Error(s.reason);
      expect(await recovered(s.raw)).toBe(w.address);
    });

    it('a sign answered by a re-read showing the file changed → refused, the key dropped (keystore-changed)', async () => {
      await confirmed();
      const signing = svc.sign(txFor(w.address));
      const c = (await recheck(SHA())).json.challenge;
      expect((await recheck(OTHER, c)).json.kind).toBe('keystore-changed');
      expect(await signing).toEqual({ ok: false, reason: 'the keystore file changed after its address was confirmed; open it again', code: 'keystore-changed' });
      expect([svc.status().unlocked, changes.at(-1)]).toEqual([false, 'keystore-changed']);
    });

    it('a sign waiting when the user locks → refused; a key unlocked meanwhile is never the one it signs with', async () => {
      await confirmed();
      const signing = svc.sign(txFor(w.address));
      await call('/gas/lock');
      op.set({ stdout: item(fields()) });
      await call('/gas/keystore/unlock', byFile());
      expect((await signing).ok).toBe(false);
    });

    it('a recheck with no picked file unlocked → 409; nothing changes', async () => {
      await call('/gas/lock');
      const r = await recheck(SHA());
      expect([r.status, svc.status().unlocked]).toEqual([409, false]);
    });
  });

  // Regression (review): a confirm / recheck is bound to the unlock it was made for. One that arrives after a lock and
  // a new unlock (same address, another source) neither confirms nor locks the new key.
  describe('a reply meant for an earlier unlock changes nothing', () => {
    let earlier: unknown;
    beforeEach(async () => {
      op.set({ stdout: item(fields()) });
      await call('/gas/keystore/unlock', byFile());
      earlier = kid();
      await call('/gas/lock');
      op.set({ stdout: item(fields()) });
      await call('/gas/keystore/unlock', byField());
      expect([svc.status().address, svc.status().confirmed, earlier === kid()]).toEqual([w.address, false, false]);
    });
    it('a late confirm of the picked file → 409; the path-sourced key stays unconfirmed', async () => {
      const r = await call('/gas/confirm', { keyId: earlier, address: w.address, sha256: w.manifest.keystoreSha256 });
      expect([r.status, svc.status().unlocked, svc.status().confirmed]).toEqual([409, true, false]);
    });
    it('a late recheck with another sha256 → 409; the current key is not locked', async () => {
      const r = await call('/gas/keystore/recheck', { keyId: earlier, sha256: 'cd'.repeat(32) });
      expect([r.status, r.json.kind, svc.status().unlocked]).toEqual([409, undefined, true]);
    });
    it('the same words as the current unlock → confirmed (the binding refuses only the earlier one)', async () => {
      expect((await call('/gas/confirm', { keyId: kid(), address: w.address })).json.confirmed).toBe(true);
    });
  });

  describe('with the Terminal signer’s manifest as an aid', () => {
    it.each(SOURCES)('%s of the pinned keystore → source.manifest true; the address is the manifest’s', async (_, body) => {
      await withManifest(w.manifest);
      const r = await call('/gas/keystore/unlock', body());
      expect([r.status, r.json.address, (r.json.source as { manifest: boolean }).manifest]).toEqual([200, w.address, true]);
    });

    it.each(SOURCES)('%s of the pinned keystore whose key is not the manifest’s address → 400 keystore-manifest-address', async (_, body) => {
      await withManifest({ ...w.manifest, address: getAddress(`0x${randomBytes(20).toString('hex')}`) });
      const r = await call('/gas/keystore/unlock', body());
      expect([r.status, r.json.kind, svc.status().unlocked]).toEqual([400, 'keystore-manifest-address', false]);
    });

    it('the manifest’s keystore path holding another file than it pinned → 400 keystore-manifest-changed; nothing unlocks', async () => {
      await withManifest({ ...w.manifest, keystoreSha256: 'ab'.repeat(32) });
      const r = await call('/gas/keystore/unlock', byField());
      expect([r.status, r.json.kind, svc.status().unlocked]).toEqual([400, 'keystore-manifest-changed', false]);
    });

    it('another keystore than the manifest’s → opens with source.manifest false (the manifest is not the only choice)', async () => {
      await withManifest(w.manifest);
      const other = syntheticGasWallet();
      try {
        op.set({ stdout: item(fields({ kspath: realpathSync(other.manifest.keystore), pw: other.password })) });
        const r = await call('/gas/keystore/unlock', byField());
        expect([r.status, r.json.address, (r.json.source as { manifest: boolean }).manifest]).toEqual([200, other.address, false]);
      } finally {
        rmSync(other.dir, { recursive: true, force: true });
      }
    });
  });

  it('without op in the runner → 400 op-missing (the hosted page cannot reach a keystore)', async () => {
    await svc.close();
    await start({ op: false });
    expect((await call('/gas/keystore/unlock', byField())).json.kind).toBe('op-missing');
  });

  const encryptKeystoreFor = () => nodeEncrypt(randomBytes(32), w.password);
});

describe('existing gas wallet mode off', () => {
  beforeEach(() => start());
  it('no manifest configured → 400 manifest-missing; status says manifestAvailable false', async () => {
    expect((await call('/gas/manifest/status')).json.kind).toBe('manifest-missing');
    expect(svc.status().manifestAvailable).toBe(false);
  });
});
