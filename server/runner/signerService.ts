// Native signer (local runner): the secret boundary for the op and native-File gas payers. It runs as a
// child process of the runner, holds at most one unlocked gas key in memory, and signs only transactions
// the sidecar issued (over IPC, never HTTP). Its loopback HTTP endpoints exist so secret-bearing input —
// a 1Password link, a keystore password — goes from the page straight here and never through the
// keyless sidecar. Every request is authenticated by the sidecar (same page session or paired website).
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getAddress, type Address, type Hex } from 'viem';
import { SIGNER_API, type SignRefusal } from '../../src/config/signerApi';
import { checkHost, corsHeaders, HttpError, readJson, sendJson } from '../http';
import type { IssuedTx } from '../relay';
import { addressOfKey, decryptKeystoreV3, encryptKeystore, KeystoreV3Error, newPrivateKey, unlockedKey, type UnlockedKey, DEFAULT_SCRYPT } from '../../src/wallet/keystoreV3';
import { decryptKeystore, KeystoreError } from '../signer/keystore';
import { checkPasswordLink, loadGasManifest, ManifestError, readPinnedKeystore, type GasManifest } from './gasManifest';
import { currentSha256, keystorePathOf, KeystoreSourceError, readKeystoreAt, uploadedKeystore, type KeystoreBytes } from './keystoreSource';
import { Op1pError, parsePrivateLink, publicFields, readItem, type OpRunner, type PrivateLink } from './op1p';
import { KeystoreStore, StoreError } from './store';

export interface SignerServiceOptions {
  port: number;
  /** Origins that may call (the runner's own page and the allowlisted websites). */
  allowedOrigins: readonly string[];
  /** Asks the sidecar whether these headers belong to a live session of `origin`. */
  auth(origin: string, session: string | undefined, pair: string | undefined): Promise<boolean>;
  op: OpRunner | null;
  store: KeystoreStore | null;
  /** Every payer change (unlock, lock, confirm, source change) is reported so the sidecar voids plans. */
  onChange(reason: string): void;
  kdf?: { n: number; r: number; p: number };
  opTimeoutMs?: number;
  /**
   * The existing gas wallet's public manifest (keystore + 1Password password reference), fixed when the runner
   * started — a page can never name another path — and the chain it must be for. Null: that mode is off.
   */
  manifest?: { path: string; chainId: number } | null;
  /** How long a sign waits for the page's re-read of a picked keystore file (tests shorten it). */
  pickedSignWaitMs?: number;
}

/**
 * A picked keystore file has no path the signer could re-read: the page that holds it re-reads it and reports its
 * sha256 (`/gas/keystore/recheck`). Each sign of such a key issues a new challenge and waits this long for a
 * matching report that carries it — i.e. a read made after the sign was asked for. Under the runner's 15 s IPC limit.
 */
export const PICKED_SIGN_WAIT_MS = 8_000;

/** A keystore the user chose (a path from an item field, or a file picked in the page), bound to its content hash. */
type KeystoreChoice = { kind: 'keystore'; origin: 'field'; field: string; passwordField: string; path: string; sha256: string; manifest: boolean } | { kind: 'keystore'; origin: 'file'; name: string; passwordField: string; sha256: string; manifest: boolean };
// A manifest key keeps the manifest it was opened under: its pinned keystore is read again before confirm and sign.
type Source = { kind: 'op'; link: PrivateLink; field: string } | { kind: 'file'; file: string } | { kind: 'manifest'; address: Address; pin: GasManifest } | KeystoreChoice;

export function createSignerService(o: SignerServiceOptions) {
  let key: UnlockedKey | null = null;
  let source: Source | null = null;
  let confirmed = false;
  let busy = false;
  // Which unlock a confirm / recheck is about: a new random id per installed key, so a reply meant for an earlier
  // key (or source) is refused without touching the current one.
  let keyId: string | null = null;
  // Picked file: the challenge the next re-read must carry, and the signs waiting for it.
  let challenge = '';
  let waiting: Array<(r: 'ok' | 'changed') => void> = [];
  const settle = (r: 'ok' | 'changed') => {
    const w = waiting;
    waiting = [];
    for (const f of w) f(r);
  };
  const rid = () => randomBytes(16).toString('hex');
  // Bumped by every reset (lock, mode change): an unlock still reading 1Password or decrypting when the
  // user locks must not install its key afterwards.
  let generation = 0;
  const host = `127.0.0.1:${o.port}`;

  const reset = (reason: string) => {
    generation++;
    // An inspect/unlock still waiting on a 1Password approval is ended, so approving it later reads nothing.
    void o.op?.cancelAll?.();
    key?.lock();
    key = null;
    source = null;
    keyId = null;
    confirmed = false;
    settle('changed');
    o.onChange(reason);
  };
  const lockedMeanwhile = () => new HttpError(409, 'the signer was locked while this key was being opened; nothing is unlocked');
  // A 1Password request overtaken by a lock (Stop waiting, leaving the mode) — before op started or while it ran —
  // reads nothing more and returns nothing it read.
  const opStale = (startedAt: number) => {
    if (startedAt !== generation) throw new Op1pError('cancelled', 'the request was stopped before 1Password answered; nothing was read');
  };
  const install = (k: UnlockedKey, s: Source, reason: string, startedAt: number) => {
    if (startedAt !== generation) {
      k.lock();
      throw lockedMeanwhile();
    }
    key?.lock();
    settle('changed');
    key = k;
    source = s;
    keyId = rid();
    challenge = rid();
    confirmed = false;
    o.onChange(reason);
  };
  const publicSource = (s: Source) => {
    if (s.kind === 'op') return { kind: 'op', field: s.field };
    if (s.kind === 'file') return { kind: 'file', file: s.file };
    if (s.kind === 'manifest') return { kind: 'manifest', address: s.address };
    return s.origin === 'field' ? { kind: 'keystore', origin: 'field', field: s.field, passwordField: s.passwordField, path: s.path, sha256: s.sha256, manifest: s.manifest } : { kind: 'keystore', origin: 'file', name: s.name, passwordField: s.passwordField, sha256: s.sha256, manifest: s.manifest };
  };
  const status = () => ({ api: SIGNER_API, unlocked: !!key, address: key?.address ?? null, keyId, confirmed, source: source && publicSource(source), opAvailable: !!o.op, fileAvailable: !!o.store, manifestAvailable: manifestIfAny() !== null });
  // ↑ Only a manifest that is in place and valid offers the existing-wallet choice; a configured path alone does not.
  /**
   * A chosen keystore stays bound to the bytes it was opened from. From a path: the file is read again. From a
   * picked file: the page's re-read of it (`pickedSha256`) must match; with none given (a sign), a new challenge is
   * issued and the sign waits for a matching re-read carrying it ('stale' when none comes in time — refused, not
   * reset). Not the same any more → the key is dropped and nothing is authorized.
   */
  const keystoreStillThere = async (pickedSha256?: unknown): Promise<'ok' | 'changed' | 'stale'> => {
    if (source?.kind === 'manifest') {
      try {
        readPinnedKeystore(source.pin);
        return 'ok';
      } catch {
        reset('keystore-changed');
        return 'changed';
      }
    }
    if (source?.kind !== 'keystore') return 'ok';
    const s = source;
    if (s.origin === 'file' && pickedSha256 === undefined) {
      challenge = rid();
      return new Promise((resolve) => {
        const done = (r: 'ok' | 'changed') => (clearTimeout(t), resolve(r));
        const t = setTimeout(() => {
          waiting = waiting.filter((f) => f !== done);
          resolve('stale');
        }, o.pickedSignWaitMs ?? PICKED_SIGN_WAIT_MS);
        waiting.push(done);
      });
    }
    const same = s.origin === 'field' ? (await currentSha256(s.path)) === s.sha256 : pickedSha256 === s.sha256;
    if (source !== s) return 'changed';
    if (!same) {
      reset('keystore-changed');
      return 'changed';
    }
    return 'ok';
  };
  /** A confirm / recheck names the unlock it is about; any other (an earlier key, another source) changes nothing. */
  const sameKey = (b: Record<string, unknown>) => {
    if (!key || b.keyId !== keyId) throw new HttpError(409, 'this request is about a gas key that is no longer the unlocked one; nothing changed');
  };
  const manifest = () => {
    if (!o.manifest) throw new ManifestError('missing', 'the existing gas wallet mode is off in this runner');
    return loadGasManifest(o.manifest.path, o.manifest.chainId);
  };
  /** The manifest, when one is in place and valid: an aid for a chosen keystore, whose pins are then enforced. */
  const manifestIfAny = (): GasManifest | null => {
    try {
      return o.manifest ? loadGasManifest(o.manifest.path, o.manifest.chainId) : null;
    } catch {
      return null;
    }
  };
  const realOr = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };

  /** The address of a 64-hex key, or null when it is not a valid key; the copied bytes are zeroed. */
  const publicAddressOf = (value: string): Address | null => {
    const pk = Uint8Array.from(Buffer.from(value.trim().replace(/^0x/, ''), 'hex'));
    try {
      return addressOfKey(pk);
    } catch {
      return null;
    } finally {
      pk.fill(0);
    }
  };
  /** A 64-hex value that is not a valid secp256k1 scalar (zero, ≥ n) is a classified error, never a 500. */
  const toKey = (pk: Uint8Array, bad: () => Error) => {
    try {
      return unlockedKey(pk);
    } catch {
      pk.fill(0);
      throw bad();
    }
  };
  const keyFromField = async (fields: Array<{ id: string; value: string; shape: string }>, field: string, passwordField: unknown): Promise<Uint8Array> => {
    const f = fields.find((x) => x.id === field);
    if (!f) throw new Op1pError('field', 'the selected field is not in this item any more');
    if (f.shape === 'private-key-hex') return Uint8Array.from(Buffer.from(f.value.trim().replace(/^0x/, ''), 'hex'));
    if (f.shape === 'keystore-v3') {
      const pw = fields.find((x) => x.id === passwordField);
      if (!pw || pw.id === f.id) throw new Op1pError('field-password', 'this field holds a keystore: also pick the field that holds its password');
      return decryptKeystoreV3(f.value, pw.value);
    }
    // Any field may be picked (a "password" field can hold a raw key); only its value, read again just now, decides.
    // Nothing is trimmed further, padded, guessed or taken from another field.
    throw new Op1pError('field', 'the selected field holds neither a 64-hex private key nor a v3 keystore');
  };

  // `startedAt` is the generation when the request arrived — before auth and before its body was read — so a
  // lock that lands while a slow body is still uploading also cancels that request.
  const routes: Record<string, (b: Record<string, unknown>, startedAt: number) => Promise<unknown> | unknown> = {
    '/gas/status': () => status(),
    '/gas/op/inspect': async (b, startedAt) => {
      if (!o.op) throw new Op1pError('missing', 'the 1Password mode is available only in the local runner with the op CLI');
      const link = parsePrivateLink(b.link);
      opStale(startedAt);
      const fields = await readItem(o.op, link, o.opTimeoutMs);
      if (startedAt !== generation) {
        for (const f of fields) f.value = '';
        opStale(startedAt);
      }
      // A raw-key field also gets its public address, so the user picks the field by the gas wallet it
      // unlocks (the key bytes are zeroed at once). A keystore's address is known only after decryption.
      const pub = publicFields(fields).map((f, i) => ({ ...f, address: fields[i]!.shape === 'private-key-hex' ? publicAddressOf(fields[i]!.value) : null }));
      for (const f of fields) f.value = '';
      return { fields: pub };
    },
    '/gas/op/unlock': async (b, startedAt) => {
      if (!o.op) throw new Op1pError('missing', 'the 1Password mode is available only in the local runner with the op CLI');
      const link = parsePrivateLink(b.link);
      if (typeof b.field !== 'string') throw new Op1pError('field', 'pick a field');
      opStale(startedAt);
      const fields = await readItem(o.op, link, o.opTimeoutMs);
      let pk: Uint8Array;
      try {
        pk = await keyFromField(fields, b.field, b.passwordField);
      } finally {
        for (const f of fields) f.value = '';
      }
      const k = toKey(pk, () => new Op1pError('field', 'the selected field is not a valid secp256k1 private key'));
      // "Unlock and use": the page showed this field's full address and the user pressed to use exactly
      // it. Confirmed only when the derived address is that one; any other is refused and nothing unlocks.
      const expect = b.confirmAddress;
      if (expect !== undefined && (typeof expect !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(expect) || getAddress(expect) !== k.address)) {
        k.lock();
        throw new Op1pError('changed', 'the key in this field is not the one whose address was shown: read the item again');
      }
      install(k, { kind: 'op', link, field: b.field }, 'op-unlocked', startedAt);
      if (expect !== undefined) {
        confirmed = true;
        o.onChange('confirmed');
      }
      return status();
    },
    // Existing gas wallet: what the manifest says (public) and whether its keystore file passes the checks.
    '/gas/manifest/status': () => {
      const m = manifest();
      readPinnedKeystore(m);
      return { address: m.address, chainId: m.chainId, keystore: m.keystore };
    },
    // Opens it: the password comes from the 1Password item the link names (the one the manifest's reference
    // names; the account is the link's own), it never leaves this process, and the derived address must be the
    // manifest's — the one the page showed and the user pressed to use.
    '/gas/manifest/unlock': async (b, startedAt) => {
      if (!o.op) throw new Op1pError('missing', 'the existing gas wallet needs the op CLI in the local runner');
      const m = manifest();
      const link = parsePrivateLink(b.link);
      checkPasswordLink(m, link);
      if (typeof b.confirmAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(b.confirmAddress) || getAddress(b.confirmAddress) !== m.address) throw new ManifestError('stale', 'the address shown is not the manifest’s (it changed, or none was confirmed): find the wallet again and check its full address');
      // The password field is the one the user chose, by its exact id: none is picked for them, nothing falls back.
      const passwordField = typeof b.passwordField === 'string' ? b.passwordField : '';
      if (!passwordField) throw new ManifestError('password-field', 'choose the field of the 1Password item that holds the keystore password');
      const text = readPinnedKeystore(m);
      opStale(startedAt);
      const fields = await readItem(o.op, link, o.opTimeoutMs);
      let pk: Uint8Array;
      try {
        opStale(startedAt);
        const pw = fields.find((f) => f.id === passwordField);
        if (!pw || !pw.value) throw new ManifestError('password-field', 'the field chosen for the password is not in that item, or it is empty');
        pk = await decryptKeystore(text, pw.value).catch((e: unknown) => {
          throw e instanceof KeystoreError && /MAC mismatch/.test(e.message) ? new ManifestError('wrong-password', 'the password in that 1Password item does not open this keystore') : new ManifestError('keystore', 'the keystore file cannot be decrypted here');
        });
      } finally {
        for (const f of fields) f.value = '';
      }
      const k = toKey(pk, () => new ManifestError('keystore', 'the key inside this keystore is not a valid secp256k1 private key'));
      if (k.address !== m.address) {
        k.lock();
        throw new ManifestError('address', 'the key in this keystore is not the manifest’s gas wallet');
      }
      install(k, { kind: 'manifest', address: m.address, pin: m }, 'manifest-unlocked', startedAt);
      confirmed = true;
      o.onChange('confirmed');
      return status();
    },
    // Existing gas wallet, chosen by the user: the keystore at the path a field of their item holds, or a keystore
    // file they picked (its encrypted text comes here and nowhere else). The password is the field of the same item
    // they picked. Opens unconfirmed: the page shows the derived address and the user confirms it.
    '/gas/keystore/unlock': async (b, startedAt) => {
      if (!o.op) throw new Op1pError('missing', 'the existing gas wallet needs the op CLI in the local runner');
      const link = parsePrivateLink(b.link);
      const src = b.source && typeof b.source === 'object' && !Array.isArray(b.source) ? (b.source as Record<string, unknown>) : null;
      const passwordField = b.passwordField;
      if (typeof passwordField !== 'string' || !passwordField) throw new KeystoreSourceError('password-field', 'pick the field of this item that holds the keystore password');
      let upload: (KeystoreBytes & { name: string }) | null = null;
      let pathField: string | null = null;
      if (src?.kind === 'file') upload = uploadedKeystore(src.name, src.keystore);
      else if (src?.kind === 'field' && typeof src.field === 'string' && src.field) pathField = src.field;
      else throw new HttpError(400, 'choose where the keystore is: a field of this item that holds its path, or a file');
      if (pathField === passwordField) throw new KeystoreSourceError('password-field', 'the password must come from another field than the keystore location');
      opStale(startedAt);
      const fields = await readItem(o.op, link, o.opTimeoutMs);
      const m = manifestIfAny();
      let pk: Uint8Array;
      let choice: KeystoreChoice;
      try {
        opStale(startedAt);
        const pw = fields.find((f) => f.id === passwordField);
        if (!pw) throw new KeystoreSourceError('password-field', 'the field chosen for the password is not in this item any more');
        let ks: KeystoreBytes;
        if (pathField) {
          const pf = fields.find((f) => f.id === pathField);
          if (!pf) throw new KeystoreSourceError('path', 'the field chosen for the keystore location is not in this item any more');
          const path = keystorePathOf(pf.value);
          ks = await readKeystoreAt(path);
          // The manifest's own keystore must still be the file it pinned: a differing one is refused, not used.
          if (m && path === realOr(m.keystore) && ks.sha256 !== m.keystoreSha256) throw new KeystoreSourceError('manifest-changed', 'this is the keystore the manifest names, but it differs from the one the manifest pinned');
          choice = { kind: 'keystore', origin: 'field', field: pathField, passwordField, path, sha256: ks.sha256, manifest: !!m && ks.sha256 === m.keystoreSha256 };
        } else {
          ks = upload!;
          choice = { kind: 'keystore', origin: 'file', name: upload!.name, passwordField, sha256: ks.sha256, manifest: !!m && ks.sha256 === m.keystoreSha256 };
        }
        pk = await decryptKeystore(ks.text, pw.value).catch((e: unknown) => {
          throw e instanceof KeystoreError && /MAC mismatch/.test(e.message) ? new KeystoreSourceError('wrong-password', 'the password in the chosen field does not open this keystore') : new KeystoreSourceError('format', 'this keystore cannot be decrypted here');
        });
      } finally {
        for (const f of fields) f.value = '';
      }
      const k = toKey(pk, () => new KeystoreSourceError('format', 'the key inside this keystore is not a valid secp256k1 private key'));
      // The manifest's pinned keystore must open to the manifest's address.
      if (choice.manifest && k.address !== m!.address) {
        k.lock();
        throw new KeystoreSourceError('manifest-address', 'the key in this keystore is not the gas wallet the manifest names');
      }
      install(k, choice, 'keystore-unlocked', startedAt);
      return status();
    },
    '/gas/file/list': () => {
      if (!o.store) throw new StoreError('unsafe-dir', 'native File storage is not available');
      return { dir: o.store.dir, files: o.store.list() };
    },
    '/gas/file/create': async (b, startedAt) => {
      if (!o.store) throw new StoreError('unsafe-dir', 'native File storage is not available');
      if (typeof b.password !== 'string' || b.password !== b.repeat) throw new KeystoreV3Error('the two passwords differ', 'weak-password');
      const pk = newPrivateKey();
      const address = addressOfKey(pk);
      const json = JSON.stringify(await encryptKeystore(pk, b.password, o.kdf ?? DEFAULT_SCRYPT));
      // Locked while encrypting: nothing is written and the new key is dropped.
      if (startedAt !== generation) {
        pk.fill(0);
        throw lockedMeanwhile();
      }
      const file = o.store.create(address.slice(2).toLowerCase(), json);
      install(unlockedKey(pk), { kind: 'file', file }, 'file-created', startedAt);
      return { ...status(), file };
    },
    '/gas/file/unlock': async (b, startedAt) => {
      if (!o.store) throw new StoreError('unsafe-dir', 'native File storage is not available');
      if (typeof b.file !== 'string' || typeof b.password !== 'string') throw new HttpError(400, 'file and password required');
      const pk = await decryptKeystoreV3(o.store.read(b.file), b.password);
      const k = toKey(pk, () => new KeystoreV3Error('the key inside this keystore is not a valid secp256k1 private key', 'malformed'));
      if (`gas-${k.address.slice(2).toLowerCase()}.json` !== b.file) {
        k.lock();
        throw new KeystoreV3Error('the key in this file does not match its file name', 'address-mismatch');
      }
      install(k, { kind: 'file', file: b.file }, 'file-unlocked', startedAt);
      return status();
    },
    // GAS-05: the user confirms the full derived address before anything can be signed.
    '/gas/confirm': async (b, startedAt) => {
      if (startedAt !== generation) throw lockedMeanwhile();
      if (!key) throw new HttpError(409, 'unlock a gas key first');
      sameKey(b);
      if (typeof b.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(b.address) || getAddress(b.address) !== key.address) throw new HttpError(409, 'the confirmed address is not the derived one');
      // A picked file is confirmed against the page's re-read of it at this moment (its sha256), not an older one.
      const picked = source?.kind === 'keystore' && source.origin === 'file';
      if ((await keystoreStillThere(picked ? (typeof b.sha256 === 'string' ? b.sha256 : '') : undefined)) !== 'ok') throw new KeystoreSourceError('changed', 'the keystore file changed after it was opened; nothing is unlocked');
      if (startedAt !== generation || b.keyId !== keyId) throw lockedMeanwhile();
      confirmed = true;
      o.onChange('confirmed');
      return status();
    },
    // The page holding a picked keystore file re-reads it and reports its sha256 (see PICKED_SIGN_WAIT_MS). A report
    // carrying the current challenge was read after every waiting sign asked: those signs may go ahead.
    '/gas/keystore/recheck': async (b) => {
      sameKey(b);
      if (source?.kind !== 'keystore' || source.origin !== 'file') throw new HttpError(409, 'no picked keystore file is unlocked');
      const asked = challenge;
      if ((await keystoreStillThere(typeof b.sha256 === 'string' ? b.sha256 : '')) !== 'ok') throw new KeystoreSourceError('changed', 'the picked keystore file changed or cannot be read any more; the gas wallet was locked');
      if (b.challenge === asked && asked === challenge) settle('ok');
      return { ...status(), challenge, pending: waiting.length > 0 };
    },
    // With a keyId, the lock is of that key only: a page cleaning up after a late unlock never locks a newer key.
    '/gas/lock': (b) => {
      if (b.keyId !== undefined && typeof b.keyId !== 'string') throw new HttpError(400, 'keyId must be a string when given');
      if (typeof b.keyId === 'string' && b.keyId !== keyId) return status();
      reset('locked');
      return status();
    },
  };

  const checkCaller = async (req: IncomingMessage) => {
    checkHost(req, { host, sessionToken: '' });
    if (req.method !== 'POST') throw new HttpError(405, 'POST only');
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'application/json required');
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || !o.allowedOrigins.includes(origin)) throw new HttpError(403, 'cross-origin request refused');
    const s = req.headers['x-cbpr-session'];
    const p = req.headers['x-cbpr-pair'];
    if (!(await o.auth(origin, typeof s === 'string' ? s : undefined, typeof p === 'string' ? p : undefined))) throw new HttpError(401, 'not a live session of the runner: reload the page or pair again');
  };

  const server = createServer((req, res: ServerResponse) => {
    const origin = req.headers.origin;
    const cors = typeof origin === 'string' && o.allowedOrigins.includes(origin) ? corsHeaders(origin) : {};
    const startedAt = generation;
    void (async () => {
      try {
        if (req.method === 'OPTIONS') {
          checkHost(req, { host, sessionToken: '' });
          if (!cors['Access-Control-Allow-Origin'] || req.headers['access-control-request-method'] !== 'POST') throw new HttpError(403, 'cross-origin request refused');
          const asked = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
          if (asked.some((h) => !['content-type', 'x-cbpr-session', 'x-cbpr-pair'].includes(h))) throw new HttpError(403, 'header not allowed');
          const h: Record<string, string> = { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type, x-cbpr-session, x-cbpr-pair', 'Access-Control-Max-Age': '60', 'cache-control': 'no-store' };
          if (req.headers['access-control-request-private-network'] === 'true') h['Access-Control-Allow-Private-Network'] = 'true';
          res.writeHead(204, h).end();
          return;
        }
        await checkCaller(req);
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        const r = routes[path];
        if (!r) throw new HttpError(404, 'unknown endpoint');
        // A lock is always answered, even while another request runs: that request then installs nothing.
        if (path === '/gas/lock') {
          sendJson(res, 200, await r(await readJson(req), startedAt), cors);
          return;
        }
        // A picked-file recheck only compares a hash, and a status read only reports: neither waits on the busy flag
        // (an unlock waiting on 1Password), so the page always learns the signer's version and state.
        if (path === '/gas/keystore/recheck' || path === '/gas/status') {
          sendJson(res, 200, await r(await readJson(req), startedAt), cors);
          return;
        }
        if (busy) throw new HttpError(409, 'the signer is busy with another request');
        busy = true;
        try {
          sendJson(res, 200, await r(await readJson(req), startedAt), cors);
        } finally {
          busy = false;
        }
      } catch (e) {
        if (e instanceof Op1pError) return sendJson(res, e.kind === 'link' || e.kind === 'field' || e.kind === 'field-password' ? 400 : 409, { error: e.message, kind: `op-${e.kind}` }, cors);
        if (e instanceof KeystoreV3Error) return sendJson(res, 400, { error: e.message, kind: `file-${e.code}` }, cors);
        if (e instanceof ManifestError) return sendJson(res, 400, { error: e.message, kind: `manifest-${e.kind}` }, cors);
        if (e instanceof KeystoreSourceError) return sendJson(res, e.kind === 'changed' ? 409 : 400, { error: e.message, kind: `keystore-${e.kind}` }, cors);
        if (e instanceof StoreError) return sendJson(res, e.kind === 'exists' ? 409 : 400, { error: e.message, kind: `store-${e.kind}` }, cors);
        if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message }, cors);
        sendJson(res, 500, { error: 'internal error' }, cors);
      }
    })();
  });

  /** IPC from the sidecar: sign exactly this issued transaction, or refuse with a reason. */
  const sign = async (tx: IssuedTx): Promise<{ ok: true; raw: Hex } | { ok: false; reason: string; code: SignRefusal }> => {
    if (!key) return { ok: false, reason: 'no gas key is unlocked in the runner', code: 'sign-locked' };
    if (!confirmed) return { ok: false, reason: 'confirm the gas wallet address first', code: 'sign-unconfirmed' };
    const asked = keyId;
    const still = await keystoreStillThere();
    if (still === 'changed') return { ok: false, reason: 'the keystore file changed after its address was confirmed; open it again', code: 'keystore-changed' };
    if (still === 'stale') return { ok: false, reason: 'the picked keystore file was not read again for this transaction: keep the page that picked it open', code: 'keystore-stale' };
    // The check above may have waited: only the key it was made for, still confirmed, signs.
    if (!key || keyId !== asked || !confirmed) return { ok: false, reason: 'the gas key changed while this transaction waited; confirm it again', code: 'keystore-key-changed' };
    let from: Address;
    try {
      from = getAddress(tx.from);
    } catch {
      return { ok: false, reason: 'the transaction has no valid from address', code: 'sign-bad-tx' };
    }
    if (from !== key.address) return { ok: false, reason: 'the transaction is for another gas wallet than the unlocked one', code: 'sign-other-wallet' };
    if (tx.nonce > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'nonce out of range', code: 'sign-bad-tx' };
    const raw = await key.signTransaction({ chainId: tx.chainId, to: tx.to, data: tx.data, nonce: Number(tx.nonce), gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
    return { ok: true, raw };
  };

  return {
    server,
    sign,
    status,
    address: (): Address | null => key?.address ?? null,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        const fail = (e: Error) => reject(e);
        server.once('error', fail);
        server.listen(o.port, '127.0.0.1', () => {
          server.off('error', fail);
          resolve();
        });
      }),
    close: async () => {
      key?.lock();
      key = null;
      settle('changed');
      // An inspect/unlock may be waiting on a 1Password prompt: end that `op` first, so its request finishes
      // and no `op` outlives the signer.
      await o.op?.stopAll?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
