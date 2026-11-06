// UI-configured RPC end to end on SYNTHETIC anvil testchains (open-source spec §3.3, M1): the real guard,
// the real capability probe and the real anvil fork check, a custom endpoint whose URL carries a synthetic
// secret path (behind a local recording reverse proxy, admitted through the self-hosted exception), plan
// invalidation on switch, and a second chain with the same chainId but another genesis. No network.
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { diagnose, type KnownAccount } from '../../server/diagnose';
import { ForkManager } from '../../server/fork';
import { startForkProxy, type ForkProxy } from '../../server/forkProxy';
import { HttpError } from '../../server/http';
import { Reader } from '../../server/reader';
import { anvilForkCheck, LOCAL_EXCEPTION_PHRASE, RpcRegistry } from '../../server/rpc/registry';
import { TransferService } from '../../server/transfer';
import { createUpstream } from '../../server/upstream';
import { startTestchain, type Testchain } from '../support/testchain';
import { DEP, startWorld, type SynthAccount, type World } from '../support/world';

const RCPT: Address = '0x5A000000000000000000000000000000000C0C03';

const SECRET = 'SyntheticPathSecret0123456789abcdef';
let tc: Testchain;
let other: Testchain;
let rev: Server;
let revHits = 0;
let revBadPath = 0;
let reg: RpcRegistry;
let proxy: ForkProxy;
let svc: TransferService;
let w: World;
let A: SynthAccount;
const accounts = new Map<Address, KnownAccount>();
const preview = () => svc.preview({ source: A.address, recipient: RCPT, asset: 'native', amount: '1', gasWallet: w.gasWallet, ownerIndex: 0 }) as Promise<{ id: string; state: string; intentHash: string }>;

const status = (p: Promise<unknown>) => p.then(() => 0, (e: unknown) => (e instanceof HttpError ? e.status : -1));
const customUrl = () => `http://127.0.0.1:${(rev.address() as AddressInfo).port}/rpc/${SECRET}`;

/** Every anvil command line visible to `ps` while `fn` runs (sampled every 50 ms). */
async function anvilArgvDuring<T>(fn: () => Promise<T>): Promise<{ result: T; argv: string[] }> {
  const seen = new Set<string>();
  const sample = () => {
    for (const l of execFileSync('ps', ['-axo', 'args='], { encoding: 'utf8' }).split('\n')) if (/anvil/.test(l) && !/ps -axo/.test(l)) seen.add(l.trim());
  };
  const t = setInterval(sample, 50);
  try {
    const result = await fn();
    sample();
    return { result, argv: [...seen] };
  } finally {
    clearInterval(t);
  }
}

beforeAll(async () => {
  w = await startWorld();
  tc = w.tc;
  A = await w.account({ passkeys: [{ index: 0, seed: 0x41 }] });
  await w.fundNative(A.address, 5n * 10n ** 18n);
  // Same chainId 9745, different genesis (another genesis timestamp).
  other = await startTestchain(undefined, ['--timestamp', '1000000']);
  // Local "provider" whose URL path is the secret: forwards only the exact secret path to the testchain.
  rev = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      if (req.url !== `/rpc/${SECRET}`) {
        revBadPath++;
        return res.writeHead(404).end();
      }
      revHits++;
      const r = await fetch(tc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) });
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(await r.text());
    });
  });
  await new Promise<void>((r) => rev.listen(0, '127.0.0.1', r));

  const base = createUpstream({ url: tc.url, source: 'testchain', resolve: { allowLocal: true } });
  reg = new RpcRegistry(base, { expectedGenesis: null, forkCheck: anvilForkCheck('anvil') });
  proxy = await startForkProxy(reg);
  const reader = new Reader(reg, { expectedGenesis: null, deployment: DEP });
  const forks = new ForkManager({ anvilBin: 'anvil', upstreamProxyUrl: proxy.url, hardfork: 'prague' });
  const d = await diagnose(reader, forks, w.infra, { account: A.address });
  accounts.set(A.address, d.known!);
  svc = new TransferService(reader, forks, w.infra, accounts);
  svc.bindRpc(reg);
}, 60_000);
afterAll(async () => {
  await proxy?.close();
  rev?.closeAllConnections();
  await new Promise((r) => rev?.close(r));
  await other?.stop();
  await w?.tc.stop();
});

describe('UI-configured RPC on synthetic testchains', () => {
  it('probing the base testchain runs a real anvil fork through the loopback proxy: simulation-ready', async () => {
    const s = await reg.probeActive();
    expect([s.capabilities?.chain.status, s.capabilities?.consistency.status, s.capabilities?.fork.status, s.capabilities?.simulationReady]).toEqual(['ok', 'ok', 'ok', true]);
    expect(s.capabilities?.broadcast.status).toBe('not-probed');
    expect(s.epoch).toBe(1); // a re-check re-pins, so it counts as a switch for plans
  }, 60_000);

  it('a private-node URL without the typed exception is refused before any connection', async () => {
    const before = revHits + revBadPath;
    expect(await status(reg.test({ url: customUrl() }))).toBe(400);
    expect(revHits + revBadPath).toBe(before);
  });

  it('a plan built on the base endpoint is discarded when the custom endpoint is put in use, and cannot be signed', async () => {
    const plan = await preview();
    expect(plan.state).toBe('previewed');
    const { result: s, argv } = await anvilArgvDuring(() => reg.use({ url: customUrl(), allowLocal: true, confirm: LOCAL_EXCEPTION_PHRASE }));
    expect([s.active, s.epoch, s.upstream.localException, s.capabilities?.fork.status]).toEqual(['custom', 2, true, 'ok']);
    // The fork check ran anvil against the loopback proxy, never against the custom URL or its path.
    expect(argv.some((l) => l.includes('--fork-url'))).toBe(true);
    expect(argv.filter((l) => l.includes(SECRET) || l.includes(`:${(rev.address() as AddressInfo).port}`))).toEqual([]);
    expect(revHits).toBeGreaterThan(0);
    expect(await status(svc.submitSignature({ planId: plan.id, intentHash: plan.intentHash, assertion: '{}' }))).toBe(409);
    expect(svc.plan(plan.id).discardReason).toMatch(/RPC endpoint changed/);
  }, 90_000);

  it('reads now go through the custom endpoint, and Clear returns to the base endpoint and discards again', async () => {
    const hits = revHits;
    const plan = await preview();
    expect(revHits).toBeGreaterThan(hits);
    const s = reg.clear();
    expect([s.active, s.epoch]).toEqual(['base', 3]);
    expect(await status(svc.submitSignature({ planId: plan.id, intentHash: plan.intentHash, assertion: '{}' }))).toBe(409);
  }, 90_000);

  it('a second chain with chainId 9745 but another genesis is refused (409) and nothing switches', async () => {
    expect(await status(reg.use({ url: other.url, allowLocal: true, confirm: LOCAL_EXCEPTION_PHRASE }))).toBe(409);
    expect([reg.state().active, reg.epoch]).toEqual(['base', 3]);
  });

  it('no registry state or report carries the secret path', () => {
    expect(JSON.stringify(reg.state())).not.toContain(SECRET);
    expect(revBadPath).toBe(0);
  });
});
