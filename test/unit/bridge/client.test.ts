// Page side of the bridge (src/bridge/client.ts) against a SYNTHETIC extension: pairing, waiting, a single
// hand-over, refusal of malformed answers, and clean-up (cancel) whenever the page gives up.
import { describe, expect, it } from 'vitest';
import { BRIDGE_APP_ORIGIN, BridgeFailed, chromeSend, requestAssertion, type Send } from '../../../src/bridge/client';

const CHALLENGE = new Uint8Array(32).fill(0xab);
const ASSERTION = '{"format":"cbpr-assertion-v1"}'; // opaque to the client; the app verifies it like a pasted one
const noSleep = async () => {};

function fakeExtension(answers: Array<(m: Record<string, unknown>) => unknown>) {
  const seen: Record<string, unknown>[] = [];
  let i = 0;
  const send: Send = async (m) => {
    seen.push(m);
    if (m.type === 'cancel') return { ok: true };
    const a = answers[Math.min(i++, answers.length - 1)]!;
    return a(m);
  };
  return { send, seen };
}
const fail = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof BridgeFailed ? e.message : `other: ${String(e)}`));

describe('requestAssertion', () => {
  it('pairs the challenge as lowercase hex, shows the code, waits, and returns the assertion once', async () => {
    const ext = fakeExtension([() => ({ ok: true, code: 'ABCD-EF23' }), () => ({ ok: true, waiting: true }), () => ({ ok: true, assertion: ASSERTION })]);
    const codes: string[] = [];
    const out = await requestAssertion({ kind: 'proof', challenge: CHALLENGE, send: ext.send, onCode: (c) => codes.push(c), sleep: noSleep, randomId: () => 'f'.repeat(32) });
    expect(out).toBe(ASSERTION);
    expect(codes).toEqual(['ABCD-EF23']);
    expect(ext.seen[0]).toEqual({ v: 1, requestId: 'f'.repeat(32), type: 'pair', kind: 'proof', challenge: '0x' + 'ab'.repeat(32) });
    expect(ext.seen.map((m) => m.type)).toEqual(['pair', 'result', 'result']);
  });

  it('a refused pairing or a malformed code stops before waiting', async () => {
    const refused = fakeExtension([() => ({ ok: false, error: 'only the local Passkey Recovery page may use this extension' })]);
    expect(await fail(requestAssertion({ kind: 'proof', challenge: CHALLENGE, send: refused.send, onCode: () => {}, sleep: noSleep }))).toMatch(/only the local/);
    const odd = fakeExtension([() => ({ ok: true, code: '<img src=x>' })]);
    expect(await fail(requestAssertion({ kind: 'proof', challenge: CHALLENGE, send: odd.send, onCode: () => {}, sleep: noSleep }))).toMatch(/malformed pairing code/);
    expect(odd.seen.map((m) => m.type)).toEqual(['pair']);
  });

  it('an error reported after the click (e.g. cancelled on keys.coinbase.com) surfaces and the pairing is cancelled', async () => {
    const ext = fakeExtension([() => ({ ok: true, code: 'ABCD-EF23' }), () => ({ ok: false, error: 'cancelled on keys.coinbase.com' })]);
    expect(await fail(requestAssertion({ kind: 'userop', challenge: CHALLENGE, send: ext.send, onCode: () => {}, sleep: noSleep }))).toBe('cancelled on keys.coinbase.com');
    expect(ext.seen.at(-1)?.type).toBe('cancel');
  });

  it('stopping or timing out cancels the pairing in the extension', async () => {
    const ac = new AbortController();
    const ext = fakeExtension([() => ({ ok: true, code: 'ABCD-EF23' }), () => (ac.abort(), { ok: true, waiting: true })]);
    expect(await fail(requestAssertion({ kind: 'proof', challenge: CHALLENGE, send: ext.send, onCode: () => {}, sleep: noSleep, signal: ac.signal }))).toBe('stopped');
    expect(ext.seen.at(-1)?.type).toBe('cancel');
    const slow = fakeExtension([() => ({ ok: true, code: 'ABCD-EF23' }), () => ({ ok: true, waiting: true })]);
    expect(await fail(requestAssertion({ kind: 'proof', challenge: CHALLENGE, send: slow.send, onCode: () => {}, sleep: noSleep, timeoutMs: -1 }))).toMatch(/in time/);
    expect(slow.seen.at(-1)?.type).toBe('cancel');
  });

  it('a non-32-byte challenge is refused before anything is sent', async () => {
    const ext = fakeExtension([() => ({ ok: true })]);
    await expect(requestAssertion({ kind: 'proof', challenge: new Uint8Array(31), send: ext.send, onCode: () => {} })).rejects.toThrow(/32 bytes/);
    expect(ext.seen).toEqual([]);
  });
});

describe('chromeSend', () => {
  it('is null off the app origin or without chrome.runtime (the extension cannot be reached there)', () => {
    expect(chromeSend('http://127.0.0.1:4174')).toBeNull();
    expect(chromeSend(BRIDGE_APP_ORIGIN)).toBeNull(); // node: no chrome.runtime
  });
});
