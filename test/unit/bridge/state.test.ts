// Bridge state machine (extension/bridge.js, ADR-002): one-time pairing, in-flight tracking, once-only result,
// all under one lock. The fake store yields between every read and write, so an unserialized read-modify-write
// would interleave. SYNTHETIC values only.
import { describe, expect, it } from 'vitest';
import { createBridge, INFLIGHT_TTL_MS } from '../../../extension/bridge.js';
import { APP_ORIGIN, hexToBase64url } from '../../../extension/protocol.js';

const RID = '0123456789abcdef0123456789abcdef';
const RID2 = 'fedcba9876543210fedcba9876543210';
const CH = '0x' + 'ab'.repeat(32);
const CH2 = '0x' + 'cd'.repeat(32);
const SENDER = { origin: APP_ORIGIN, url: `${APP_ORIGIN}/`, frameId: 0 };
const KEYS = 'https://keys.coinbase.com/connect';
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function assertionFor(challenge: string, kind = 'proof') {
  const client = { type: 'webauthn.get', challenge: hexToBase64url(challenge), origin: 'https://keys.coinbase.com', crossOrigin: false };
  return JSON.stringify({ format: 'cbpr-assertion-v1', kind, rpId: 'keys.coinbase.com', origin: 'https://keys.coinbase.com', credentialId: 'AAEC', authenticatorData: 'AAEC', clientDataJSON: Buffer.from(JSON.stringify(client)).toString('base64url'), signature: 'AAEC', userHandle: null });
}

function setup() {
  const data: Record<string, unknown> = {};
  const clock = { t: 1_000_000 };
  const store = {
    async get(keys: string[]) {
      await tick();
      return Object.fromEntries(keys.filter((k) => data[k] !== undefined).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items: Record<string, unknown>) {
      await tick();
      Object.assign(data, structuredClone(items));
    },
  };
  const bridge = createBridge({ store, now: () => clock.t });
  const send = (m: Record<string, unknown>) => bridge.handle({ v: 1, ...m }, SENDER);
  const pair = (requestId = RID, challenge = CH) => send({ type: 'pair', requestId, kind: 'proof', challenge });
  /** A sign() the test resolves by hand, standing in for the open passkey prompt. */
  const prompt = () => {
    let calls = 0;
    let finish!: (json: string) => void;
    const sign = () => {
      calls++;
      return new Promise<{ ok: boolean; json: string }>((r) => (finish = (json) => r({ ok: true, json })));
    };
    return { sign, done: (json: string) => finish(json), calls: () => calls };
  };
  return { data, clock, bridge, send, pair, prompt };
}

describe('bridge state machine', () => {
  it('pair → click → result hands the bound assertion over once', async () => {
    const { bridge, send, pair } = setup();
    expect(await pair()).toMatchObject({ ok: true, code: expect.stringMatching(/^.{4}-.{4}$/) });
    expect(await bridge.click(KEYS, async () => ({ ok: true, json: assertionFor(CH) }))).toBe('stored');
    expect(await send({ type: 'result', requestId: RID })).toEqual({ ok: true, assertion: assertionFor(CH) });
    expect(await send({ type: 'result', requestId: RID })).toMatchObject({ ok: false, error: /no such request/ });
  });

  it('two simultaneous result requests: exactly one gets the assertion', async () => {
    const { bridge, send, pair } = setup();
    await pair();
    await bridge.click(KEYS, async () => ({ ok: true, json: assertionFor(CH) }));
    const both = await Promise.all([send({ type: 'result', requestId: RID }), send({ type: 'result', requestId: RID })]);
    expect(both.filter((r) => (r as { assertion?: string }).assertion).length).toBe(1);
  });

  it('two simultaneous clicks spend the pairing once: one prompt, the other finds nothing', async () => {
    const { bridge, pair, prompt } = setup();
    await pair();
    const p = prompt();
    const a = bridge.click(KEYS, p.sign);
    const b = bridge.click(KEYS, p.sign);
    expect(await b).toBe('nothing');
    p.done(assertionFor(CH));
    expect(await a).toBe('stored');
    expect(p.calls()).toBe(1);
  });

  it('while the passkey prompt is open the app is told to keep waiting', async () => {
    const { bridge, send, pair, prompt } = setup();
    await pair();
    const p = prompt();
    const c = bridge.click(KEYS, p.sign);
    await tick(); await tick(); await tick(); await tick();
    expect(await send({ type: 'result', requestId: RID })).toEqual({ ok: true, waiting: true });
    p.done(assertionFor(CH));
    await c;
  });

  it('a cancel during the prompt drops what it signs; nothing is kept for that request', async () => {
    const { bridge, send, pair, prompt, data } = setup();
    await pair();
    const p = prompt();
    const c = bridge.click(KEYS, p.sign);
    await tick(); await tick(); await tick(); await tick();
    expect(await send({ type: 'cancel', requestId: RID })).toEqual({ ok: true });
    p.done(assertionFor(CH));
    expect(await c).toBe('dropped');
    expect(data.result ?? null).toBeNull();
    expect(await send({ type: 'result', requestId: RID })).toMatchObject({ ok: false, error: /no such request/ });
  });

  it('a newer pairing during the prompt replaces it: the old signature is dropped, the new pairing stays', async () => {
    const { bridge, send, pair, prompt } = setup();
    await pair();
    const p = prompt();
    const c = bridge.click(KEYS, p.sign);
    await tick(); await tick(); await tick(); await tick();
    await pair(RID2, CH2);
    p.done(assertionFor(CH));
    expect(await c).toBe('dropped');
    expect(await send({ type: 'result', requestId: RID })).toMatchObject({ ok: false });
    expect(await send({ type: 'result', requestId: RID2 })).toEqual({ ok: true, waiting: true });
  });

  it('a prompt that outlives the in-flight window is dropped', async () => {
    const { bridge, send, pair, prompt, clock } = setup();
    await pair();
    const p = prompt();
    const c = bridge.click(KEYS, p.sign);
    await tick(); await tick(); await tick(); await tick();
    clock.t += INFLIGHT_TTL_MS + 1;
    p.done(assertionFor(CH));
    expect(await c).toBe('dropped');
    expect(await send({ type: 'result', requestId: RID })).toMatchObject({ ok: false, error: /no such request/ });
  });

  it('a click on another page signs nothing and keeps the pairing; an unbound assertion is stored as an error', async () => {
    const { bridge, send, pair, prompt } = setup();
    await pair();
    const p = prompt();
    expect(await bridge.click('https://keys.coinbase.com/', p.sign)).toBe('wrong-page');
    expect(p.calls()).toBe(0);
    expect(await send({ type: 'result', requestId: RID })).toEqual({ ok: true, waiting: true });
    expect(await bridge.click(KEYS, async () => ({ ok: true, json: assertionFor(CH2) }))).toBe('stored');
    expect(await send({ type: 'result', requestId: RID })).toMatchObject({ ok: false, error: /different challenge/ });
  });

  it('refuses another sender before touching state', async () => {
    const { bridge, data } = setup();
    await expect(bridge.handle({ v: 1, type: 'pair', requestId: RID, kind: 'proof', challenge: CH }, { origin: 'http://127.0.0.1:4174', url: 'http://127.0.0.1:4174/', frameId: 0 })).rejects.toThrow(/only the local/);
    expect(Object.keys(data)).toEqual([]);
  });
});
