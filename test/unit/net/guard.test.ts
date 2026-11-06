// SSRF guard (open-source spec §3.3): address classes, every-resolved-address rule, the self-hosted
// exception, pinned connections (no second DNS lookup → no rebinding), no redirects, no env proxy.
// All endpoints are synthetic local servers; no network.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyAddress, maskUrl, NetGuardError, pinnedPost, resolveTarget, type LookupAll } from '../../../server/net/guard';

const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof NetGuardError ? e.code : `other:${String(e)}`));
const fixed = (...addrs: string[]): LookupAll => async () => addrs.map((a) => ({ address: a, family: a.includes(':') ? 6 : 4 }));

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['104.18.0.1', 'public'],
    ['2606:4700::1111', 'public'],
    ['127.0.0.1', 'local'],
    ['127.255.0.9', 'local'],
    ['10.1.2.3', 'local'],
    ['172.16.0.1', 'local'],
    ['172.31.255.255', 'local'],
    ['192.168.1.20', 'local'],
    ['100.64.0.1', 'local'],
    ['::1', 'local'],
    ['fd12:3456::1', 'local'],
  ])('%s → %s', (ip, scope) => expect(classifyAddress(ip)).toBe(scope));

  it.each(['169.254.169.254', '169.254.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1', 'fe80::1', 'ff02::1', '::', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:7f00:1::', '2001:0:4136::1', 'fe80::1%en0', 'not-an-ip'])(
    '%s is never allowed',
    (ip) => expect(classifyAddress(ip)).toBe('forbidden'),
  );

  it('boundaries next to private ranges stay public (172.15/172.32, 100.63/100.128, 11.0.0.1)', () => {
    for (const ip of ['172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '11.0.0.1', '192.169.0.1']) expect(classifyAddress(ip)).toBe('public');
  });
});

describe('resolveTarget', () => {
  it('a public https host resolves, pins the checked address and masks to scheme://host/…', async () => {
    const t = await resolveTarget('https://rpc.example.org/v2/SyntheticKey0123456789', { allowLocal: false, lookup: fixed('93.184.216.34') });
    expect(t).toMatchObject({ protocol: 'https:', hostname: 'rpc.example.org', port: 443, path: '/v2/SyntheticKey0123456789', pinned: { address: '93.184.216.34', family: 4 }, scope: 'public' });
    expect(maskUrl(t)).toBe('https://•••/…');
  });

  it('maskUrl shows no label of a DNS hostname, wherever a key sits; keeps IP literals and ports', () => {
    const m = (hostHeader: string, keep = false) => maskUrl({ protocol: 'https:', hostHeader }, keep);
    for (const h of ['key123456789.rpc.example.org', 'rpc.key123456789.example', 'k1.example.org', 'example.org']) expect(m(h)).toBe('https://•••/…');
    expect(m('rpc.key123456789.example:8545')).toBe('https://•••:8545/…');
    expect(m('192.168.1.20:8545')).toBe('https://192.168.1.20:8545/…');
    expect(m('[fd00::5]:8545')).toBe('https://[fd00::5]:8545/…');
    expect(m('rpc.plasma.to', true)).toBe('https://rpc.plasma.to/…');
  });

  it.each([
    ['ftp://rpc.example.org/', 'scheme'],
    ['http://rpc.example.org/', 'scheme'],
    ['https://user:pw@rpc.example.org/', 'userinfo'],
    ['https://rpc.example.org/#frag', 'fragment'],
    ['not a url', 'url-invalid'],
    ['https://' + 'a'.repeat(520) + '.org/', 'too-long'],
  ])('%s → %s', async (url, want) => expect(await code(resolveTarget(url, { allowLocal: false, lookup: fixed('93.184.216.34') }))).toBe(want));

  it.each([
    ['https://127.0.0.1:8545/', 'local-needs-exception'],
    ['https://2130706433/', 'local-needs-exception'], // decimal IPv4 → 127.0.0.1 (WHATWG normalises it)
    ['https://0x7f.0.0.1/', 'local-needs-exception'],
    ['https://[::1]:8545/', 'local-needs-exception'],
    ['https://[::ffff:127.0.0.1]/', 'forbidden-address'],
    ['https://169.254.169.254/latest/meta-data/', 'forbidden-address'],
    ['https://[fe80::1]/', 'forbidden-address'],
    ['https://10.0.0.5/', 'local-needs-exception'],
  ])('IP literal %s → %s', async (url, want) => expect(await code(resolveTarget(url, { allowLocal: false }))).toBe(want));

  it('every resolved address must pass: one private address among public ones rejects the host', async () => {
    expect(await code(resolveTarget('https://mixed.example.org/', { allowLocal: false, lookup: fixed('93.184.216.34', '10.0.0.7') }))).toBe('local-needs-exception');
    expect(await code(resolveTarget('https://mixed.example.org/', { allowLocal: true, lookup: fixed('93.184.216.34', '169.254.169.254') }))).toBe('forbidden-address');
    expect(await code(resolveTarget('https://v6.example.org/', { allowLocal: false, lookup: fixed('2606:4700::1111', '::ffff:10.0.0.1') }))).toBe('forbidden-address');
  });

  it('the self-hosted exception admits loopback/LAN (https or http) but never metadata, and never plain http to a public host', async () => {
    expect((await resolveTarget('http://localhost:8545/', { allowLocal: true, lookup: fixed('127.0.0.1') })).scope).toBe('local');
    expect((await resolveTarget('https://node.lan/', { allowLocal: true, lookup: fixed('192.168.1.20') })).scope).toBe('local');
    expect(await code(resolveTarget('http://169.254.169.254/', { allowLocal: true }))).toBe('forbidden-address');
    expect(await code(resolveTarget('http://rpc.example.org/', { allowLocal: true, lookup: fixed('93.184.216.34') }))).toBe('http-needs-local');
  });

  it('loopback ports of this process (sidecar, fork proxy) are refused even with the exception', async () => {
    expect(await code(resolveTarget('http://127.0.0.1:4173/', { allowLocal: true, denyLoopbackPorts: [4173, 50001] }))).toBe('port');
    expect(await code(resolveTarget('http://127.0.0.1:8545/', { allowLocal: true, denyLoopbackPorts: [4173, 50001] }))).toBe('ok');
  });

  it('DNS failure or an empty answer → dns error with a message that never names the host', async () => {
    const e = await resolveTarget('https://SecretHost0123456789.example.org/', { allowLocal: false, lookup: async () => Promise.reject(new Error('ENOTFOUND SecretHost0123456789')) }).catch((x: Error) => x);
    expect(e).toMatchObject({ code: 'dns' });
    expect(String((e as Error).message) + (e as Error).stack).not.toContain('SecretHost');
    expect(await code(resolveTarget('https://empty.example.org/', { allowLocal: false, lookup: async () => [] }))).toBe('dns');
  });
});

// --- pinned transport against real local servers ---------------------------------------------------
let target: Server;
let other: Server;
let targetHits = 0;
let otherHits = 0;
let mode: 'json' | 'redirect' | 'big' | 'hang' = 'json';
const port = (s: Server) => (s.address() as AddressInfo).port;

beforeAll(async () => {
  target = createServer((req, res) => {
    targetHits++;
    req.resume();
    req.on('end', () => {
      if (mode === 'redirect') return res.writeHead(302, { location: `http://127.0.0.1:${port(other)}/` }).end();
      if (mode === 'big') return res.writeHead(200).end('x'.repeat(2048));
      if (mode === 'hang') return; // never answers
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ host: req.headers.host, path: req.url }));
    });
  });
  other = createServer((_req, res) => {
    otherHits++;
    res.writeHead(200).end('{}');
  });
  await Promise.all([new Promise<void>((r) => target.listen(0, '127.0.0.1', r)), new Promise<void>((r) => other.listen(0, '127.0.0.1', r))]);
});
afterAll(async () => {
  target.closeAllConnections();
  await Promise.all([new Promise((r) => target.close(r)), new Promise((r) => other.close(r))]);
});

describe('pinnedPost', () => {
  it('connects to the checked address without asking DNS again (rebinding cannot redirect it), with the original Host', async () => {
    mode = 'json';
    let lookups = 0;
    // First answer: loopback (allowed under the exception). Any later answer would point elsewhere.
    const rebinding: LookupAll = async () => (++lookups === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '169.254.169.254', family: 4 }]);
    const t = await resolveTarget(`http://rebind.example.test:${port(target)}/v2/k`, { allowLocal: true, lookup: rebinding });
    const before = targetHits;
    const a = JSON.parse((await pinnedPost(t, '{}', { timeoutMs: 2000 })).body) as { host: string; path: string };
    await pinnedPost(t, '{}', { timeoutMs: 2000 });
    expect(lookups).toBe(1);
    expect(targetHits - before).toBe(2);
    expect(a).toEqual({ host: `rebind.example.test:${port(target)}`, path: '/v2/k' });
  });

  it('a redirect is an error and its Location is never requested', async () => {
    mode = 'redirect';
    const t = await resolveTarget(`http://127.0.0.1:${port(target)}/`, { allowLocal: true });
    const before = otherHits;
    expect(await code(pinnedPost(t, '{}', { timeoutMs: 2000 }))).toBe('redirect');
    expect(otherHits).toBe(before);
  });

  it('an oversized body and a silent server end as too-large / timeout', async () => {
    const t = await resolveTarget(`http://127.0.0.1:${port(target)}/`, { allowLocal: true });
    mode = 'big';
    expect(await code(pinnedPost(t, '{}', { timeoutMs: 2000, maxBytes: 1024 }))).toBe('too-large');
    mode = 'hang';
    expect(await code(pinnedPost(t, '{}', { timeoutMs: 150 }))).toBe('timeout');
    mode = 'json';
  });

  it('a closed port maps to network with a fixed message', async () => {
    const t = await resolveTarget('http://127.0.0.1:9/', { allowLocal: true });
    const e = await pinnedPost(t, '{}', { timeoutMs: 2000 }).catch((x: Error) => x);
    expect(e).toMatchObject({ code: 'network', message: 'RPC endpoint unreachable' });
  });
});

describe('environment proxy settings', () => {
  // Child process so NODE_USE_ENV_PROXY / HTTP(S)_PROXY are read at startup the way a user's shell sets them.
  const runChild = (script: string, env: NodeJS.ProcessEnv) =>
    new Promise<string>((resolve, reject) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      c.stdout.on('data', (d: Buffer) => (out += d));
      c.stderr.on('data', (d: Buffer) => (err += d));
      c.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`child exit ${code}: ${err.slice(0, 400)}`))));
    });

  it('the guarded transport ignores HTTP_PROXY even with NODE_USE_ENV_PROXY=1; global fetch (control) would use it', async () => {
    // Counts both proxy styles: absolute-URI forwarding ('request') and CONNECT tunnelling ('connect').
    let proxyHits = 0;
    const proxy = createServer((req, res) => {
      proxyHits++;
      req.resume();
      res.writeHead(502).end();
    });
    proxy.on('connect', (_req, socket: import('node:net').Socket) => {
      proxyHits++;
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    const proxyUrl = `http://127.0.0.1:${port(proxy)}`;
    // Hostname (not 127.0.0.1) so NO_PROXY-style loopback exemptions cannot explain the result.
    const url = `http://proxied.example.test:${port(target)}/`;
    const env = { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, http_proxy: proxyUrl, NODE_USE_ENV_PROXY: '1', NO_PROXY: '', no_proxy: '' };
    const guardUrl = new URL('../../../server/net/guard.ts', import.meta.url).href;
    mode = 'json';
    try {
      const before = targetHits;
      const guarded = await runChild(
        `const g = await import(${JSON.stringify(guardUrl)});
         const t = await g.resolveTarget(${JSON.stringify(url)}, { allowLocal: true, lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
         const r = await g.pinnedPost(t, '{}', { timeoutMs: 3000 });
         process.stdout.write(r.body);`,
        env,
      );
      expect(JSON.parse(guarded)).toMatchObject({ host: `proxied.example.test:${port(target)}` });
      expect(targetHits - before).toBe(1);
      expect(proxyHits).toBe(0);
      // Control: the same environment does send Node's global fetch to the proxy (which refuses it), and not to the target.
      const fetchBefore = targetHits;
      await runChild(`await fetch(${JSON.stringify(url)}, { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) }).catch(() => {});`, env);
      expect({ proxyHits: proxyHits >= 1, targetHits: targetHits - fetchBefore }).toEqual({ proxyHits: true, targetHits: 0 });
    } finally {
      proxy.closeAllConnections();
      await new Promise((r) => proxy.close(r));
    }
  }, 15_000);
});
