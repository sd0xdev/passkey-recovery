// Capability probe + reader chain identity + snapshot consistency (open-source spec §3.3, M1), all against
// the SYNTHETIC JSON-RPC fixture: no network, no real endpoint, no key.
import { describe, expect, it } from 'vitest';
import { SUPPORTED } from '../../../src/config/registry';
import { SRC_A } from '../../fixtures/accounts';

const ENTRY_POINT_V06 = SUPPORTED[0]!.entryPoint;
import { probeUpstream, type ForkCheck } from '../../../server/rpc/probe';
import { Reader } from '../../../server/reader';
import { createUpstream, UpstreamError } from '../../../server/upstream';
import { SYN_GENESIS, SYN_HEAD, syntheticRpc, type SynOptions } from '../../fixtures/synthetic-rpc';

// Synthetic "API key" in the path: must never appear in any report, error or detail string.
const SECRET = 'SyntheticKey0123456789abcdefXYZ';
const URL_WITH_SECRET = `https://rpc.example.org/v2/${SECRET}`;
const noSleep = async () => {};

function up(o: SynOptions = {}) {
  const s = syntheticRpc(o);
  return { up: createUpstream({ url: URL_WITH_SECRET, source: 'custom', transport: s.transport, sleep: noSleep }), log: s.log };
}
const okFork: ForkCheck = async () => ({ status: 'ok', detail: 'synthetic fork matched' });
const kind = (p: Promise<unknown>) => p.then(() => 'ok', (e: unknown) => (e instanceof UpstreamError ? e.kind : `other:${String(e)}`));

describe('probeUpstream', () => {
  it('a healthy synthetic endpoint → every capability ok, broadcast never probed, simulationReady', async () => {
    const { up: u, log } = up();
    const r = await probeUpstream(u, { expectedGenesis: SYN_GENESIS, forkCheck: okFork });
    expect({ chain: r.chain.status, read: r.read.status, consistency: r.consistency.status, estimate: r.estimate.status, stateOverride: r.stateOverride.status, archive: r.archive.status, fork: r.fork.status }).toEqual({
      chain: 'ok', read: 'ok', consistency: 'ok', estimate: 'ok', stateOverride: 'ok', archive: 'ok', fork: 'ok',
    });
    expect(r.broadcast.status).toBe('not-probed');
    expect(r.simulationReady).toBe(true);
    expect(r.masked).toBe('https://•••/…');
    // No method outside the read allowlist was sent (in particular nothing that broadcasts).
    expect(log.map((l) => l.method).filter((m) => /send|sign|raw/i.test(m))).toEqual([]);
  });

  it('a wrong chainId → chain unsupported, everything else skipped, not simulation-ready', async () => {
    const r = await probeUpstream(up({ chainId: 1 }).up, { expectedGenesis: SYN_GENESIS, forkCheck: okFork });
    expect(r.chain).toMatchObject({ status: 'unsupported', chainId: null });
    expect([r.read.status, r.fork.status, r.simulationReady]).toEqual(['skipped', 'skipped', false]);
  });

  it('the right chainId on a different genesis (a fork / reused id) → chain unsupported', async () => {
    const r = await probeUpstream(up({ genesis: '0x' + '0b'.repeat(32) }).up, { expectedGenesis: SYN_GENESIS, forkCheck: okFork });
    expect(r.chain.status).toBe('unsupported');
    expect(r.chain.detail).toMatch(/different genesis/);
  });

  it('a head whose hash changes between reads → consistency unsupported and the fork check is not run', async () => {
    let forkRuns = 0;
    const r = await probeUpstream(up({ blockHash: (n, k) => '0x' + (n + BigInt(k)).toString(16).padStart(64, '0') }).up, {
      expectedGenesis: SYN_GENESIS,
      forkCheck: async () => (forkRuns++, { status: 'ok', detail: '' }),
    });
    expect([r.consistency.status, r.fork.status, forkRuns, r.simulationReady]).toEqual(['unsupported', 'skipped', 0, false]);
  });

  it('unsupported estimate / pruned history / ignored override are reported per capability, reads stay ok', async () => {
    const r = await probeUpstream(up({ unsupported: ['eth_estimateGas'], errors: { eth_getBalance: 'missing trie node abc' }, overrideHonoured: false }).up, { expectedGenesis: SYN_GENESIS, forkCheck: okFork });
    expect({ read: r.read.status, estimate: r.estimate.status, archive: r.archive.status, stateOverride: r.stateOverride.status }).toEqual({ read: 'ok', estimate: 'unsupported', archive: 'unsupported', stateOverride: 'unsupported' });
    // archive is read at head − 10000, never at "latest"
    expect(r.archive.detail).toMatch(/missing trie node/);
  });

  it('a stale head is flagged in the read detail', async () => {
    const r = await probeUpstream(up({ headTimestamp: BigInt(Math.floor(Date.now() / 1000) - 3600) }).up, { expectedGenesis: SYN_GENESIS });
    expect(r.read.status).toBe('ok');
    expect(r.read.detail).toMatch(/may be lagging/);
    expect(r.fork.status).toBe('skipped'); // no fork check in this process
  });

  it('rate limiting is retried, counted and reported, and a persistent limit fails reads without hanging', async () => {
    const r = await probeUpstream(up({ rpc32005: 2 }).up, { expectedGenesis: SYN_GENESIS });
    expect([r.chain.status, r.rateLimited]).toEqual(['ok', 2]);
    const r2 = await probeUpstream(up({ http429: 100 }).up, { expectedGenesis: SYN_GENESIS });
    expect(r2.chain.status).toBe('error');
    expect(r2.chain.detail).toMatch(/rate limited/);
  });

  it('an endpoint echoing its own key in client version and errors never leaks it into the report', async () => {
    const r = await probeUpstream(up({ echo: `${URL_WITH_SECRET} key=${SECRET}`, unsupported: ['eth_estimateGas'], errors: { eth_getBalance: 'pruned' } }).up, { expectedGenesis: SYN_GENESIS, forkCheck: okFork });
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('/v2/');
    expect(r.clientVersion).toMatch(/^synthetic\/v1\.0/);
  });
});

describe('Reader chain identity and snapshot consistency', () => {
  const undeployed = { codeAt: (a: string) => (a.toLowerCase() === ENTRY_POINT_V06.toLowerCase() ? '0x6001' : '0x') };

  it('expectedGenesis null learns the first endpoint, then refuses a different genesis', async () => {
    const r = new Reader(up().up, { expectedGenesis: null });
    expect((await r.verifyChain()).genesisHash).toBe(SYN_GENESIS);
    expect(r.chainVerified).toBe(true);
    expect(await kind(new Reader(up({ genesis: '0x' + '0c'.repeat(32) }).up, { expectedGenesis: SYN_GENESIS }).verifyChain())).toBe('chain-mismatch');
  });

  it('a snapshot over stable reads returns the head block; a hash change mid-snapshot → inconsistent', async () => {
    const snap = await new Reader(up(undeployed).up, { expectedGenesis: SYN_GENESIS }).snapshot(SRC_A);
    expect(snap.block).toBe(SYN_HEAD);
    // Second read of the head block (the closing consistency check) reports a different hash.
    const flaky = up({ ...undeployed, blockHash: (n, k) => '0x' + (n * 10n + BigInt(k > 1 ? 1 : 0)).toString(16).padStart(64, '0') }).up;
    expect(await kind(new Reader(flaky, { expectedGenesis: SYN_GENESIS }).snapshot(SRC_A))).toBe('inconsistent');
  });

  it('every snapshot re-checks genesis: the same upstream re-pinned to another backend is refused', async () => {
    const a = syntheticRpc(undeployed);
    const b = syntheticRpc({ ...undeployed, genesis: '0x' + '0c'.repeat(32) });
    let backend = a;
    const u = createUpstream({ url: URL_WITH_SECRET, source: 'custom', transport: (body) => backend.transport(body), sleep: noSleep });
    const r = new Reader(u, { expectedGenesis: SYN_GENESIS });
    expect((await r.snapshot(SRC_A)).block).toBe(SYN_HEAD);
    backend = b; // same upstream id, other backend (what a DNS re-pin can do)
    expect(await kind(r.snapshot(SRC_A))).toBe('chain-mismatch');
    expect(b.log.some((l) => l.method === 'eth_getCode')).toBe(false);
  });

  it('a snapshot on the wrong chain fails before reading any state', async () => {
    const { up: u, log } = up({ ...undeployed, chainId: 8453 });
    expect(await kind(new Reader(u, { expectedGenesis: SYN_GENESIS }).snapshot(SRC_A))).toBe('chain-mismatch');
    expect(log.some((l) => l.method === 'eth_getCode')).toBe(false);
  });
});
