// RpcRegistry (open-source spec §3.3, M1): the UI-configured endpoint lifecycle. Test never switches, Use
// switches only on a verified chain, every switch bumps the epoch and notifies listeners, Clear and a page
// load drop the custom endpoint, the self-hosted exception needs the typed phrase, and no state ever
// carries the URL. Custom endpoints are SYNTHETIC transports injected through `open`; the guard's own
// address checks run for real (openUpstream is wrapped, not replaced).
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../../server/http';
import { LOCAL_EXCEPTION_PHRASE, RpcRegistry, type SwitchListener } from '../../../server/rpc/registry';
import { createUpstream, openUpstream } from '../../../server/upstream';
import { SYN_GENESIS, syntheticRpc, type SynOptions } from '../../fixtures/synthetic-rpc';

const SECRET = 'SyntheticCustomKey9876543210qrstu';
const CUSTOM = `https://custom.example.org/rpc/${SECRET}`;
const noSleep = async () => {};

/** Behaviour per hostname; the address check still runs through the real guard (fixed synthetic DNS). */
function harness(byHost: Record<string, SynOptions & { address?: string }> = {}) {
  const opened: string[] = [];
  const open: typeof openUpstream = async (url, source, resolve) => {
    const host = new URL(url).hostname;
    const o = byHost[host] ?? {};
    // Real guard decision on a synthetic DNS answer: throws for a forbidden / unconfirmed local address.
    await openUpstream(url, source, { ...resolve, lookup: async () => [{ address: o.address ?? '93.184.216.34', family: 4 }] }, { transport: async () => ({ status: 200, retryAfter: null, body: '{}' }) });
    opened.push(host);
    return createUpstream({ url, source, transport: syntheticRpc(o).transport, resolve, sleep: noSleep });
  };
  const base = createUpstream({ url: 'https://rpc.plasma.example/', source: 'default', transport: syntheticRpc().transport, sleep: noSleep });
  const reg = new RpcRegistry(base, { expectedGenesis: SYN_GENESIS, open, denyLoopbackPorts: () => [4173] });
  const events: Parameters<SwitchListener>[0][] = [];
  reg.onSwitch((e) => events.push(e));
  return { reg, events, opened };
}
const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof HttpError ? e.status : -1));

describe('RpcRegistry', () => {
  it('Test probes a candidate without switching, notifying, or keeping it', async () => {
    const { reg, events } = harness();
    const report = await reg.test({ url: CUSTOM });
    expect([report.chain.status, report.masked]).toEqual(['ok', 'https://•••/…']);
    expect([reg.state().active, reg.epoch, events.length]).toEqual(['base', 0, 0]);
  });

  it('Use switches to a verified endpoint: epoch +1, listeners told, reads go through it', async () => {
    const { reg, events } = harness();
    const s = await reg.use({ url: CUSTOM });
    expect([s.active, s.epoch, s.upstream.masked, s.upstream.provider]).toEqual(['custom', 1, 'https://•••/…', 'custom']);
    expect(events).toEqual([{ epoch: 1, reason: 'custom-set' }]);
    expect(await reg.call('eth_chainId', [])).toBe('0x2611');
  });

  it('Use refuses a wrong chain / wrong genesis with 409 and stays on the base endpoint', async () => {
    const { reg, events } = harness({ 'wrong.example.org': { chainId: 1 }, 'fork.example.org': { genesis: '0x' + '0d'.repeat(32) } });
    expect(await status(reg.use({ url: 'https://wrong.example.org/' }))).toBe(409);
    expect(await status(reg.use({ url: 'https://fork.example.org/' }))).toBe(409);
    expect([reg.state().active, events.length]).toEqual(['base', 0]);
  });

  it('Clear and a page load each drop the custom endpoint with their own reason; clearing twice is a no-op', async () => {
    const { reg, events } = harness();
    await reg.use({ url: CUSTOM });
    reg.clear();
    await reg.use({ url: CUSTOM });
    reg.clear('page-load');
    reg.clear('page-load');
    expect(events.map((e) => e.reason)).toEqual(['custom-set', 'custom-cleared', 'custom-set', 'page-load']);
    expect([reg.state().active, reg.epoch]).toEqual(['base', 4]);
  });

  it('a loopback / private node needs allowLocal plus the typed phrase; metadata addresses never pass', async () => {
    const { reg, opened } = harness({ 'node.lan': { address: '192.168.1.20' }, 'meta.example.org': { address: '169.254.169.254' } });
    expect(await status(reg.test({ url: 'https://node.lan/' }))).toBe(400); // no exception requested
    expect(await status(reg.test({ url: 'https://node.lan/', allowLocal: true, confirm: 'my own node' }))).toBe(400); // wrong phrase
    const s = await reg.use({ url: 'https://node.lan/', allowLocal: true, confirm: LOCAL_EXCEPTION_PHRASE });
    expect([s.upstream.localException, opened]).toEqual([true, ['node.lan']]);
    expect(await status(reg.test({ url: 'https://meta.example.org/', allowLocal: true, confirm: LOCAL_EXCEPTION_PHRASE }))).toBe(400);
  });

  it("this sidecar's own loopback port is refused even with the exception", async () => {
    const { reg } = harness({ '127.0.0.1': { address: '127.0.0.1' } });
    expect(await status(reg.test({ url: 'http://127.0.0.1:4173/', allowLocal: true, confirm: LOCAL_EXCEPTION_PHRASE }))).toBe(400);
  });

  it('no state, report or error ever carries the URL path / key', async () => {
    const { reg } = harness({ 'echo.example.org': { echo: `${CUSTOM} ${SECRET}`, errors: { eth_getBalance: 'pruned' } } });
    const texts: string[] = [];
    texts.push(JSON.stringify(await reg.test({ url: `https://echo.example.org/rpc/${SECRET}` })));
    texts.push(JSON.stringify(await reg.use({ url: `https://echo.example.org/rpc/${SECRET}` })));
    texts.push(JSON.stringify(await reg.probeActive()));
    texts.push(await reg.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] })));
    const bad = await reg.use({ url: `https://wrong.example.org/rpc/${SECRET}`, allowLocal: true }).catch((e: Error) => e.message);
    texts.push(String(bad));
    for (const t of texts) expect(t).not.toContain(SECRET);
  });

  it('a non-string url is a 400, not a crash', async () => {
    expect(await status(harness().reg.test({ url: 42 }))).toBe(400);
  });
});

describe('RpcRegistry on the testchain (expectedGenesis null)', () => {
  const build = (custom: SynOptions, baseOpts: SynOptions = {}) => {
    const open: typeof openUpstream = async (url, source, resolve) => createUpstream({ url, source, transport: syntheticRpc(custom).transport, resolve, sleep: noSleep });
    const base = createUpstream({ url: 'http://127.0.0.1:8545/', source: 'testchain', transport: syntheticRpc(baseOpts).transport, sleep: noSleep });
    return new RpcRegistry(base, { expectedGenesis: null, open });
  };

  it('the expected genesis is learned from the base endpoint, so a custom endpoint on another genesis is refused', async () => {
    expect(await status(build({ genesis: '0x' + '0e'.repeat(32) }).use({ url: CUSTOM }))).toBe(409);
    expect((await build({}).use({ url: CUSTOM })).active).toBe('custom');
  });

  it('an unverifiable base endpoint makes custom checks fail closed (503), never learn from the candidate', async () => {
    expect(await status(build({}, { chainId: 1 }).test({ url: CUSTOM }))).toBe(503);
  });

  it('a Use still being checked when the page reloads (or Clear is pressed) is refused and never lands', async () => {
    const { reg, events } = harness();
    const pending = status(reg.use({ url: CUSTOM }));
    reg.clear('page-load'); // the base endpoint was active: nothing to drop, but the page session ended
    expect(await pending).toBe(409);
    expect([reg.state().active, events.length]).toEqual(['base', 0]);
    const p2 = status(reg.use({ url: CUSTOM }));
    reg.clear();
    expect([await p2, reg.state().active]).toEqual([409, 'base']);
    expect((await reg.use({ url: CUSTOM })).active).toBe('custom'); // a Use after the reload still works
  });

  it('an explicit re-check (re-pin) bumps the epoch so plans read from the previous backend are discarded', async () => {
    const { reg, events } = harness();
    const s = await reg.probeActive();
    expect([s.epoch, s.active, s.capabilities?.chain.status]).toEqual([1, 'base', 'ok']);
    expect(events).toEqual([{ epoch: 1, reason: 'endpoint-rechecked' }]);
  });
});
