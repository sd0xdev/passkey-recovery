// What the runner answers for a non-API path (design guidelines §13.3): the pure classifier, then the real
// sidecar serving a synthetic build — pages with the session, the HTML 404 for document navigations only,
// speculative loads refused before any page routing, and the RPC reset only on a document GET.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyStatic, isDocumentNavigation, safePath } from '../../../server/staticRoute';
import { startSidecar } from '../../../server/sidecar';

const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,*/*' };
const files = new Set(['index.html', '404.html', 'assets/app-1.js', 'passkey-recovery-0.3.0.tgz', 'favicon.svg']);
const has = (rel: string) => files.has(rel);

describe('safePath', () => {
  it('decodes ordinary paths and keeps the query out', () => {
    expect(safePath('/guide?x=1#y')).toBe('/guide');
    expect(safePath('/assets/a%20b.js')).toBe('/assets/a b.js');
  });
  it('refuses traversal and separators on the raw text, before anything normalises them', () => {
    for (const p of ['/%2e%2e/x', '/assets/../../etc/passwd', '/./guide', '/a%2fb', '/a%5cb', '/a%00', '/%E0%A4%A', 'guide', '']) expect(safePath(p), p).toBeNull();
  });
});

describe('isDocumentNavigation', () => {
  it('Fetch Metadata decides when present; Accept only when it is absent', () => {
    expect(isDocumentNavigation(NAV)).toBe(true);
    expect(isDocumentNavigation({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'text/html' })).toBe(false);
    expect(isDocumentNavigation({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' })).toBe(false);
    expect(isDocumentNavigation({ accept: 'text/html' })).toBe(true);
    expect(isDocumentNavigation({ accept: 'application/json' })).toBe(false);
  });
});

describe('classifyStatic', () => {
  it('the six page paths → page, with or without a trailing slash', () => {
    for (const p of ['/', '/recover', '/guide/', '/how-it-works', '/security', '/download?x=1']) expect(classifyStatic(p, {}, has).kind, p).toBe('page');
  });
  it('a speculative load is refused before the page allowlist (Sec-Purpose or Purpose)', () => {
    expect(classifyStatic('/recover', { ...NAV, 'sec-purpose': 'prefetch;prerender' }, has).kind).toBe('speculative');
    expect(classifyStatic('/', { purpose: 'prefetch' }, has).kind).toBe('speculative');
    // The same header words that are not a prefetch: an ordinary page load.
    expect(classifyStatic('/', { 'sec-purpose': 'none' }, has).kind).toBe('page');
  });
  it('a bad raw path wins over everything', () => {
    expect(classifyStatic('/%2e%2e/recover', { ...NAV, purpose: 'prefetch' }, has).kind).toBe('bad');
  });
  it('snapshotted files are served; an .html file never is (only through the page routes or as the 404 page)', () => {
    expect(classifyStatic('/assets/app-1.js', NAV, has)).toEqual({ kind: 'file', rel: 'assets/app-1.js' });
    expect(classifyStatic('/passkey-recovery-0.3.0.tgz', NAV, has)).toEqual({ kind: 'file', rel: 'passkey-recovery-0.3.0.tgz' });
    expect(classifyStatic('/index.html', {}, has).kind).toBe('notFound');
    expect(classifyStatic('/404.html', NAV, has).kind).toBe('notFound');
  });
  it('unknown path: the HTML 404 page only for a document navigation to an extension-less, unreserved path', () => {
    expect(classifyStatic('/nope', NAV, has).kind).toBe('notFoundPage');
    expect(classifyStatic('/guide/deeper', { accept: 'text/html' }, has).kind).toBe('notFoundPage');
    for (const p of ['/api', '/api/nope', '/signer/x', '/assets', '/assets/missing', '/missing.js', '/nope.tgz']) expect(classifyStatic(p, NAV, has).kind, p).toBe('notFound');
    expect(classifyStatic('/nope', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }, has).kind).toBe('notFound');
    // "api" as an ordinary path segment elsewhere is not reserved.
    expect(classifyStatic('/apis', NAV, has).kind).toBe('notFoundPage');
  });
});

describe('the sidecar serves pages on real paths', () => {
  let dir = '';
  let port = 0;
  let s: Awaited<ReturnType<typeof startSidecar>>;
  const go = (method: string, path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string; type: string; cache: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), type: String(res.headers['content-type'] ?? ''), cache: String(res.headers['cache-control'] ?? '') }));
      });
      r.on('error', reject);
      r.end();
    });
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cbpr-routes-'));
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'index.html'), '<html><head></head><body>app</body></html>');
    writeFileSync(join(dir, '404.html'), '<html><head></head><body>not-found-page</body></html>');
    writeFileSync(join(dir, 'assets', 'app-1.js'), 'js');
    port = 45000 + Math.floor(Math.random() * 2000);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('no network in this test'))));
    s = await startSidecar({ port, root: process.cwd(), dist: dir, anvilBin: 'anvil-not-used' });
  });
  afterAll(async () => {
    await s?.close();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('every page path → index.html with the session, no-store; a document GET resets the custom RPC', async () => {
    const clear = vi.spyOn(s.rpc, 'clear');
    for (const p of ['/', '/recover', '/guide', '/how-it-works/', '/security', '/download?lang=zh']) {
      const r = await go('GET', p, NAV);
      expect([p, r.status, r.body.includes('name="cbpr-session"'), r.cache]).toEqual([p, 200, true, 'no-store']);
    }
    expect(clear).toHaveBeenCalledTimes(6);
    expect(clear).toHaveBeenLastCalledWith('page-load');
    clear.mockRestore();
  });
  it('a GET of a page path that is not a document navigation (a script fetch) serves it but resets nothing', async () => {
    const clear = vi.spyOn(s.rpc, 'clear');
    const r = await go('GET', '/recover', { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: '*/*' });
    expect(r.status).toBe(200);
    expect((await go('GET', '/guide', { accept: 'application/json' })).status).toBe(200);
    expect(clear).not.toHaveBeenCalled();
    clear.mockRestore();
  });
  it('HEAD answers like GET without a body and without resetting the RPC', async () => {
    const clear = vi.spyOn(s.rpc, 'clear');
    const r = await go('HEAD', '/recover', NAV);
    expect([r.status, r.body, r.cache]).toEqual([200, '', 'no-store']);
    expect((await go('HEAD', '/nope', NAV)).status).toBe(404);
    expect(clear).not.toHaveBeenCalled();
    clear.mockRestore();
  });
  it('a prefetch / prerender gets 503 no-store: no page, no session, no RPC reset', async () => {
    const clear = vi.spyOn(s.rpc, 'clear');
    const r = await go('GET', '/recover', { ...NAV, 'sec-purpose': 'prefetch;prerender' });
    expect([r.status, r.body, r.cache]).toEqual([503, '', 'no-store']);
    expect((await go('GET', '/', { purpose: 'prefetch' })).status).toBe(503);
    expect(clear).not.toHaveBeenCalled();
    clear.mockRestore();
  });
  it('an unknown document path → the 404 page (status 404, HTML, no session); other misses keep the JSON 404', async () => {
    const page = await go('GET', '/nope', NAV);
    expect([page.status, page.type.startsWith('text/html'), page.body.includes('not-found-page'), page.body.includes('cbpr-session')]).toEqual([404, true, true, false]);
    // The API answers its own paths before any page routing (here 405 for a GET): never the HTML page.
    const api = await go('GET', '/api/nope', NAV);
    expect([api.status >= 400, api.type.startsWith('application/json'), api.body.includes('not-found-page')]).toEqual([true, true, false]);
    for (const p of ['/assets/missing.js', '/nope.js', '/index.html']) {
      const r = await go('GET', p, NAV);
      expect([p, r.status, r.type.startsWith('application/json')]).toEqual([p, 404, true]);
    }
    expect((await go('GET', '/nope', { accept: 'application/json' })).type.startsWith('application/json')).toBe(true);
  });
  it('assets are served as files; a raw traversal is refused before normalisation', async () => {
    expect((await go('GET', '/assets/app-1.js')).body).toBe('js');
    for (const p of ['/%2e%2e/recover', '/assets/../index.html', '/assets/%2e%2e/index.html']) expect((await go('GET', p, NAV)).status, p).toBe(400);
  });
  it('a raw traversal into /api or /signer is refused before any route sees it (URL parsing would fold it in)', async () => {
    const session = { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-cbpr-session': s.cfg.sessionToken };
    for (const p of ['/%2e%2e/api/rpc/state', '/x/%2E%2E/api/rpc/state', '/api/%2e%2e/api/rpc/state', '/%2e%2e/signer/claim']) {
      const r = await go('POST', p, session);
      expect([p, r.status, r.body.includes('bad path')]).toEqual([p, 400, true]);
    }
    // Control: the same request on the plain path reaches the API.
    expect((await go('POST', '/api/rpc/state', session)).status).toBe(200);
  });
  it('a document GET of the 404 page also starts a new UI session (custom RPC reset); its HEAD does not', async () => {
    const clear = vi.spyOn(s.rpc, 'clear');
    await go('HEAD', '/nope', NAV);
    expect(clear).not.toHaveBeenCalled();
    await go('GET', '/nope', NAV);
    expect(clear).toHaveBeenCalledWith('page-load');
    clear.mockRestore();
  });
});
