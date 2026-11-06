// Hosted pairing targets (HOST-05): only http://127.0.0.1:<port>/ can be a runner or a signer base —
// never a LAN or public host, a path other than `/` or `/recover`, credentials or another scheme.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, hasConnection, hasNativeSigner, lastDrop, onConnectionChange, pageKind, pair, pairedRunner, retryRunner, runnerBase, runnerLost, RUNNER_PROTOCOL, setSignerBase, signerApi, unpair, versionDiffers } from '../../../src/ui/api';

describe('pageKind (6-recovery-atlas.md §6.2: from what the page holds, never its hostname)', () => {
  it('a session from the runner → runner page, whichever build it is', () => {
    expect(pageKind('s3ss10n-from-meta', 'production', 'http://127.0.0.1:4171')).toBe('runner');
    expect(pageKind('s3ss10n-from-meta', 'hosted', 'https://recovery.sd0x.dev')).toBe('runner');
  });
  it('no session: the website build on https → website (it pairs); any other build → static preview (nothing pairs with it)', () => {
    expect(pageKind(null, 'hosted', 'https://recovery.sd0x.dev')).toBe('website');
    expect(pageKind(null, 'hosted', 'https://127.0.0.1:4179')).toBe('website');
    expect(pageKind(null, 'production', 'https://recovery.sd0x.dev')).toBe('static-preview');
    expect(pageKind(null, 'development', 'http://127.0.0.1:5173')).toBe('static-preview');
  });
  it('the website build on http (wrangler dev, a static server) → static preview: the runner refuses http origins', () => {
    expect(pageKind(null, 'hosted', 'http://127.0.0.1:8787')).toBe('static-preview');
    expect(pageKind(null, 'hosted', 'http://localhost:4180')).toBe('static-preview');
    // The runner's own page stays the runner page on http.
    expect(pageKind('s3ss10n-from-meta', 'hosted', 'http://127.0.0.1:4171')).toBe('runner');
  });
});

describe('versionDiffers', () => {
  it('same release → no notice; another release (or stray whitespace only) → only the real difference', () => {
    expect(versionDiffers('0.2.0', '0.2.0')).toBe(false);
    expect(versionDiffers(' 0.2.0 ', '0.2.0')).toBe(false);
    expect(versionDiffers('0.1.0', '0.2.0')).toBe(true);
  });
});

describe('runnerBase', () => {
  it('loopback with a port → its origin', () => {
    expect(runnerBase(' http://127.0.0.1:4171/ ')).toBe('http://127.0.0.1:4171');
    expect(runnerBase('http://127.0.0.1:4171')).toBe('http://127.0.0.1:4171');
  });
  it('the address the runner prints (…/recover) → its origin; no other page or path is a runner address', () => {
    expect(runnerBase('http://127.0.0.1:4171/recover')).toBe('http://127.0.0.1:4171');
    for (const u of ['http://127.0.0.1:4171/recover/', 'http://127.0.0.1:4171/guide', 'http://127.0.0.1:4171/recover?x=1', 'http://127.0.0.1:4171/recover#/recover', 'http://192.168.1.5:4171/recover', 'http://:p@127.0.0.1:4171/recover']) expect(() => runnerBase(u), u).toThrow();
  });
  it.each(['http://localhost:4171/', 'http://192.168.1.5:4171/', 'https://127.0.0.1:4171/', 'http://127.0.0.1/', 'http://127.0.0.1:4171/api', 'http://127.0.0.1:4171/?x=1', 'http://u:p@127.0.0.1:4171/', 'http://0.0.0.0:4171/', 'http://[::1]:4171/'])('%s → refused', (u) => expect(() => runnerBase(u)).toThrow());
});

describe('setSignerBase', () => {
  it('accepts only an exact loopback origin', () => {
    setSignerBase('http://127.0.0.1:4172');
    expect(hasNativeSigner()).toBe(true);
    for (const bad of ['http://127.0.0.1:4172/', 'http://evil.example:4172', 'https://127.0.0.1:4172', null]) {
      setSignerBase(bad);
      expect(hasNativeSigner()).toBe(false);
    }
  });
  it('a change is announced to connection listeners (the gas sheet enables the native modes); the same value is not', () => {
    setSignerBase(null);
    let n = 0;
    const off = onConnectionChange(() => n++);
    setSignerBase('http://127.0.0.1:4172');
    setSignerBase('http://127.0.0.1:4172');
    setSignerBase(null);
    off();
    expect(n).toBe(2);
  });
});

describe('pairing against a runner (NX-03)', () => {
  const BASE = 'http://127.0.0.1:4171';
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  afterEach(() => {
    unpair();
    vi.unstubAllGlobals();
  });
  // The hosted page has no local page session; api() then uses the pairing.
  const noPageSession = () => vi.stubGlobal('document', { querySelector: () => null });

  it('regression: a runner answering another protocol version is refused and nothing is paired', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(200, { token: 'synthetic-token', protocol: RUNNER_PROTOCOL + 1, version: '9.0.0', mode: 'mainnet' })));
    await expect(pair(BASE, 'ABCD-EFGH')).rejects.toThrow(/protocol/);
    expect(pairedRunner()).toBeNull();
  });
  it('regression: after a runner restart the old token gets 401 — the page drops the pairing and tells listeners', async () => {
    noPageSession();
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    let restarted = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers });
      if (url.endsWith('/api/pair')) return answer(200, { token: 'synthetic-token', protocol: RUNNER_PROTOCOL, version: '0.1.0', mode: 'testchain' });
      return restarted ? answer(401, { error: 'unknown or expired pairing (pair again)', kind: 'pairing' }) : answer(200, { ok: true });
    }));
    await pair(BASE, 'ABCD-EFGH');
    expect(pairedRunner()?.base).toBe(BASE);
    await expect(api('/api/config')).resolves.toEqual({ ok: true });
    expect(calls[1]).toMatchObject({ url: `${BASE}/api/config`, headers: { 'x-cbpr-pair': 'synthetic-token' } });
    restarted = true;
    let told = 0;
    const off = onConnectionChange(() => told++);
    const e = await api('/api/config').catch((x: unknown) => x);
    off();
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).kind).toBe('unpaired');
    expect(pairedRunner()).toBeNull();
    expect(told).toBe(1);
    // Nothing is retried with the stale token: the next call fails locally as "not connected".
    await expect(api('/api/config')).rejects.toMatchObject({ kind: 'no-sidecar' });
    expect(calls).toHaveLength(3);
  });

  it('regression: a paired runner that stops answering ends the pairing ("offline"), tells listeners once, and keeps no signer', async () => {
    noPageSession();
    let down = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (down) throw new TypeError('Failed to fetch');
      if (url.endsWith('/api/pair')) return answer(200, { token: 'synthetic-token', protocol: RUNNER_PROTOCOL, version: '0.1.0', mode: 'testchain' });
      return answer(200, { ok: true });
    }));
    await pair(BASE, 'ABCD-EFGH');
    setSignerBase('http://127.0.0.1:4172');
    down = true;
    let told = 0;
    const off = onConnectionChange(() => told++);
    await expect(api('/api/check')).rejects.toMatchObject({ kind: 'offline' });
    off();
    expect([pairedRunner(), hasConnection(), lastDrop(), hasNativeSigner(), told]).toEqual([null, false, 'offline', false, 1]);
  });

  it('regression: the paired runner\'s signer not answering ends the pairing the same way (not only the sidecar)', async () => {
    noPageSession();
    let down = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (down) throw new TypeError('Failed to fetch');
      if (url.endsWith('/api/pair')) return answer(200, { token: 'synthetic-token', protocol: RUNNER_PROTOCOL, version: '0.1.0', mode: 'testchain' });
      return answer(200, { ok: true });
    }));
    await pair(BASE, 'ABCD-EFGH');
    setSignerBase('http://127.0.0.1:4172');
    await expect(signerApi('/gas/status')).resolves.toEqual({ ok: true });
    down = true;
    let told = 0;
    const off = onConnectionChange(() => told++);
    await expect(signerApi('/gas/status')).rejects.toMatchObject({ kind: 'offline' });
    off();
    expect([pairedRunner(), hasConnection(), lastDrop(), hasNativeSigner(), told]).toEqual([null, false, 'offline', false, 1]);
  });

  it('regression: a late 401 for an old pairing leaves the newer pairing alone; a 401 for the live one ends it', async () => {
    noPageSession();
    let answerOld!: (r: Response) => void;
    let n = 0;
    const locks: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      if (url.endsWith('/api/pair')) return answer(200, { token: `synthetic-token-${++n}`, protocol: RUNNER_PROTOCOL, version: '0.1.0', mode: 'testchain' });
      // Disconnecting asks the signer to lock first, on the pairing being let go.
      if (url.endsWith('/gas/lock')) return (locks.push(init.headers['x-cbpr-pair'] ?? ''), answer(200, { unlocked: false }));
      if (init.headers['x-cbpr-pair'] === 'synthetic-token-1') return new Promise<Response>((r) => (answerOld = r));
      return answer(401, { error: 'not a live session of the runner: reload the page or pair again' });
    }));
    await pair(BASE, 'ABCD-EFGH');
    setSignerBase('http://127.0.0.1:4172');
    const old = signerApi('/gas/status').catch((x: unknown) => x);
    await vi.waitFor(() => expect(answerOld).toBeTypeOf('function'));
    unpair();
    expect(locks).toEqual(['synthetic-token-1']);
    await pair(BASE, 'JKLM-NPQR');
    answerOld(answer(401, { error: 'not a live session of the runner: reload the page or pair again' }));
    expect(await old).toMatchObject({ status: 401, kind: 'unpaired' });
    expect(pairedRunner()).toMatchObject({ base: BASE });
    await expect(api('/api/config')).rejects.toMatchObject({ status: 401 });
    expect([pairedRunner(), lastDrop()]).toEqual([null, 'runner']);
  });
});

describe('the runner that served this page (local)', () => {
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const pageSession = () => vi.stubGlobal('document', { querySelector: (q: string) => (q.includes('cbpr-session') ? { getAttribute: () => 'synthetic-page-session' } : null) });
  afterEach(async () => {
    // Leave the module answered (not lost) for the next test.
    vi.stubGlobal('fetch', vi.fn(async () => answer(200, { ok: true })));
    await api('/api/config').catch(() => undefined);
    vi.unstubAllGlobals();
  });

  it('regression: no answer → lost (not connected, listeners told once); the next answer → connected again, told once', async () => {
    pageSession();
    let down = true;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (down) throw new TypeError('Failed to fetch');
      return answer(200, { ok: true });
    }));
    let told = 0;
    const off = onConnectionChange(() => told++);
    await expect(api('/api/check')).rejects.toMatchObject({ kind: 'offline' });
    await expect(api('/api/check')).rejects.toMatchObject({ kind: 'offline' });
    expect([hasConnection(), runnerLost(), told]).toEqual([false, 'offline', 1]);
    down = false;
    await expect(api('/api/check')).resolves.toEqual({ ok: true });
    off();
    expect([hasConnection(), runnerLost(), told]).toEqual([true, false, 2]);
  });

  it('regression: the local signer not answering → lost too; its next answer → connected again', async () => {
    pageSession();
    let down = true;
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (down) throw new TypeError('Failed to fetch');
      return answer(200, { ok: true });
    }));
    setSignerBase('http://127.0.0.1:4172');
    let told = 0;
    const off = onConnectionChange(() => told++);
    await expect(signerApi('/gas/status')).rejects.toMatchObject({ kind: 'offline' });
    expect([hasConnection(), runnerLost(), told]).toEqual([false, 'offline', 1]);
    down = false;
    await expect(signerApi('/gas/status')).resolves.toEqual({ ok: true });
    off();
    setSignerBase(null);
    expect([hasConnection(), runnerLost(), told]).toEqual([true, false, 2]);
  });

  it('regression: the local signer refusing this page\'s session (401: the runner restarted) → lost as restarted, not connected', async () => {
    pageSession();
    vi.stubGlobal('fetch', vi.fn(async () => answer(401, { error: 'not a live session of the runner: reload the page or pair again' })));
    setSignerBase('http://127.0.0.1:4172');
    let told = 0;
    const off = onConnectionChange(() => told++);
    await expect(signerApi('/gas/op/inspect')).rejects.toMatchObject({ status: 401 });
    off();
    setSignerBase(null);
    expect([hasConnection(), runnerLost(), told]).toEqual([false, 'stale', 1]);
  });

  it('retryRunner: nothing answers → offline; a runner refusing this session (restarted) → restarted; an answer → ok', async () => {
    pageSession();
    let reply: 'down' | 'stale' | 'ok' = 'down';
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (reply === 'down') throw new TypeError('Failed to fetch');
      return reply === 'stale' ? answer(403, { error: 'missing or stale session (reload the page)' }) : answer(200, { ok: true });
    }));
    expect(await retryRunner()).toBe('offline');
    reply = 'stale';
    expect(await retryRunner()).toBe('restarted');
    // A refused session is not a connection: still not connected, and known as such without a retry.
    expect([hasConnection(), runnerLost()]).toEqual([false, 'stale']);
    reply = 'ok';
    expect(await retryRunner()).toBe('ok');
    expect(hasConnection()).toBe(true);
  });
});
