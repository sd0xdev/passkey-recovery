// The sidecar serves the UI built when its process started: a rebuild on disk never reaches a running runner,
// so the page always matches the signer in that process (the "unknown endpoint" mix of a new page and old signer).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SNAPSHOT_BYTES, snapshotDist } from '../../../server/staticSnapshot';
import { startSidecar } from '../../../server/sidecar';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cbpr-dist-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('snapshotDist', () => {
  it('reads every regular file once, by relative path; a symlink is left out', () => {
    const d = tmp();
    mkdirSync(join(d, 'assets'));
    writeFileSync(join(d, 'index.html'), '<html><head></head></html>');
    writeFileSync(join(d, 'assets', 'app-1.js'), 'console.log(1)');
    writeFileSync(join(tmpdir(), 'cbpr-outside.txt'), 'outside');
    symlinkSync(join(tmpdir(), 'cbpr-outside.txt'), join(d, 'assets', 'link.txt'));
    const s = snapshotDist(d);
    expect([...s.keys()].sort()).toEqual(['assets/app-1.js', 'index.html']);
    expect(s.get('assets/app-1.js')!.toString()).toBe('console.log(1)');
  });
  it('no build yet → empty (every page request answers 404)', () => {
    expect(snapshotDist(join(tmp(), 'missing')).size).toBe(0);
  });
  it('a tree larger than the cap is refused', () => {
    const d = tmp();
    writeFileSync(join(d, 'big.bin'), Buffer.alloc(MAX_SNAPSHOT_BYTES + 1));
    expect(() => snapshotDist(d)).toThrow(/larger than/);
  });
});

describe('the sidecar serves the build it started with', () => {
  const get = (port: number, path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      r.on('error', reject);
      r.end();
    });
  it('a rebuild after start (new index, new asset) changes nothing served until a restart', async () => {
    const d = tmp();
    mkdirSync(join(d, 'assets'));
    writeFileSync(join(d, 'index.html'), '<html><head></head><body>build-A</body></html>');
    writeFileSync(join(d, 'assets', 'a.js'), 'A');
    const port = 41000 + Math.floor(Math.random() * 2000);
    // Serving the page reaches no RPC: any outbound fetch would be a test defect.
    const outbound = vi.fn(async () => Promise.reject(new Error('no network in this test')));
    vi.stubGlobal('fetch', outbound);
    const s = await startSidecar({ port, root: process.cwd(), dist: d, anvilBin: 'anvil-not-used' }).catch((e: unknown) => e as Error);
    if (s instanceof Error) return expect.fail(`sidecar did not start: ${s.message}`);
    try {
      writeFileSync(join(d, 'index.html'), '<html><head></head><body>build-B</body></html>');
      writeFileSync(join(d, 'assets', 'b.js'), 'B');
      const page = await get(port, '/');
      expect([page.status, page.body.includes('build-A'), page.body.includes('build-B')]).toEqual([200, true, false]);
      expect((await get(port, '/assets/b.js')).status).toBe(404);
      expect((await get(port, '/assets/a.js')).body).toBe('A');
      expect((await get(port, '/assets/../../etc/passwd')).status).toBe(400);
    } finally {
      await s.close();
      vi.unstubAllGlobals();
    }
    expect(outbound).not.toHaveBeenCalled();
  });

  it('stopping does not wait for a browser connection still open (a tab mid-request): close() resolves', async () => {
    const d = tmp();
    writeFileSync(join(d, 'index.html'), '<html><head></head></html>');
    const port = 43000 + Math.floor(Math.random() * 2000);
    const s = await startSidecar({ port, root: process.cwd(), dist: d, anvilBin: 'anvil-not-used' }).catch((e: unknown) => e as Error);
    if (s instanceof Error) return expect.fail(`sidecar did not start: ${s.message}`);
    // A request whose headers never finish: the connection stays active, as an open tab's can.
    const sock = connect(port, '127.0.0.1');
    await new Promise<void>((r) => sock.once('connect', () => r()));
    sock.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    await new Promise((r) => setTimeout(r, 100));
    const ended = new Promise<void>((r) => sock.once('close', () => r()));
    const outcome = await Promise.race([s.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('still waiting'), 3000))]);
    expect(outcome).toBe('closed');
    await ended;
    sock.destroy();
  });
  it('a port already in use rejects with EADDRINUSE instead of crashing the process', async () => {
    const d = tmp();
    writeFileSync(join(d, 'index.html'), '<html><head></head></html>');
    const { createServer } = await import('node:net');
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as { port: number }).port;
    try {
      const e = await startSidecar({ port, root: process.cwd(), dist: d, anvilBin: 'anvil-not-used' }).then(
        async (s) => (await s.close(), null),
        (err: unknown) => err as NodeJS.ErrnoException,
      );
      expect(e?.code).toBe('EADDRINUSE');
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
