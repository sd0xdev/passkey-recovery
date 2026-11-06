// Bridge protocol v1 (ADR-002): the extension's own checks, run on the same module the service worker loads
// (extension/protocol.js). SYNTHETIC values only — no real assertion, key or challenge.
import { describe, expect, it } from 'vitest';
import { APP_ORIGIN, BridgeError, checkAssertionBinding, hexToBase64url, isSignPage, pairingCode, parseRequest, senderAllowed } from '../../../extension/protocol.js';

const RID = '0123456789abcdef0123456789abcdef';
const CH = '0x' + 'ab'.repeat(32);
const b64u = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function assertion(o: { kind?: string; client?: Record<string, unknown>; extra?: Record<string, unknown> } = {}) {
  const client = { type: 'webauthn.get', challenge: hexToBase64url(CH), origin: 'https://keys.coinbase.com', crossOrigin: false, ...o.client };
  return JSON.stringify({
    format: 'cbpr-assertion-v1', kind: o.kind ?? 'userop', rpId: 'keys.coinbase.com', origin: 'https://keys.coinbase.com',
    credentialId: 'AAEC', authenticatorData: 'AAEC', clientDataJSON: b64u(JSON.stringify(client)), signature: 'AAEC', userHandle: null, ...o.extra,
  });
}
const pending = { kind: 'userop', challenge: CH };
const why = (f: () => unknown) => {
  try {
    f();
    return 'accepted';
  } catch (e) {
    return e instanceof BridgeError ? e.message : `other: ${String(e)}`;
  }
};

describe('senderAllowed', () => {
  it('only the local app origin, top frame', () => {
    expect(senderAllowed({ origin: APP_ORIGIN, url: `${APP_ORIGIN}/`, frameId: 0 })).toBe(true);
    expect(senderAllowed({ origin: 'http://127.0.0.1:4174', url: 'http://127.0.0.1:4174/', frameId: 0 })).toBe(false);
    expect(senderAllowed({ origin: 'http://localhost:4173', url: 'http://localhost:4173/', frameId: 0 })).toBe(false);
    expect(senderAllowed({ origin: APP_ORIGIN, url: `${APP_ORIGIN}/`, frameId: 3 })).toBe(false);
    expect(senderAllowed({ origin: APP_ORIGIN, url: 'https://evil.example/' })).toBe(false);
    expect(senderAllowed({ origin: 'http://127.0.0.1:4174', url: `${APP_ORIGIN}/` })).toBe(false); // origin and URL must both match
    expect(senderAllowed(undefined)).toBe(false);
  });
});

describe('parseRequest', () => {
  it('accepts exactly the three request shapes', () => {
    expect(parseRequest({ v: 1, type: 'pair', requestId: RID, kind: 'proof', challenge: CH })).toEqual({ type: 'pair', requestId: RID, kind: 'proof', challenge: CH });
    expect(parseRequest({ v: 1, type: 'result', requestId: RID })).toEqual({ type: 'result', requestId: RID });
    expect(parseRequest({ v: 1, type: 'cancel', requestId: RID })).toEqual({ type: 'cancel', requestId: RID });
  });

  it.each([
    [{ v: 2, type: 'pair', requestId: RID, kind: 'proof', challenge: CH }, /version/],
    [{ v: 1, type: 'pair', requestId: RID, kind: 'proof', challenge: CH, rpId: 'evil.example' }, /unexpected fields/],
    [{ v: 1, type: 'pair', requestId: RID, kind: 'transfer', challenge: CH }, /kind/],
    [{ v: 1, type: 'pair', requestId: RID, kind: 'proof', challenge: '0x' + 'ab'.repeat(31) }, /32 bytes/],
    [{ v: 1, type: 'pair', requestId: RID, kind: 'proof', challenge: CH.toUpperCase().replace('0X', '0x') }, /lowercase/],
    [{ v: 1, type: 'result', requestId: RID.slice(1) }, /requestId/],
    [{ v: 1, type: 'sign', requestId: RID }, /unknown request type/],
    [['pair'], /object/],
  ])('refuses %j', (msg, re) => {
    expect(why(() => parseRequest(msg))).toMatch(re);
  });
});

describe('pairingCode / isSignPage', () => {
  it('the code is deterministic per request and challenge, 4-4 from an unambiguous alphabet', async () => {
    const a = await pairingCode(RID, CH);
    expect(a).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(await pairingCode(RID, CH)).toBe(a);
    expect(await pairingCode(RID, '0x' + 'ac'.repeat(32))).not.toBe(a);
  });

  it('signs only on exactly https://keys.coinbase.com/connect', () => {
    expect(isSignPage('https://keys.coinbase.com/connect')).toBe(true);
    expect(isSignPage('https://keys.coinbase.com/connect?x=1')).toBe(true);
    for (const u of ['https://keys.coinbase.com/', 'https://keys.coinbase.com/connect/x', 'http://keys.coinbase.com/connect', 'https://keys.coinbase.com.evil.example/connect', 'https://wallet.coinbase.com/connect', undefined, 'not a url']) expect(isSignPage(u)).toBe(false);
  });
});

describe('checkAssertionBinding', () => {
  it('accepts an assertion bound to the paired challenge on the real origin', () => {
    expect(why(() => checkAssertionBinding(assertion(), pending))).toBe('accepted');
  });

  it.each([
    ['another challenge', { client: { challenge: hexToBase64url('0x' + 'cd'.repeat(32)) } }, /different challenge/],
    ['another origin', { client: { origin: 'https://keys.coinbase.com.evil.example' } }, /origin/],
    ['cross-origin iframe', { client: { crossOrigin: true } }, /cross-origin/],
    ['topOrigin present', { client: { topOrigin: 'https://evil.example' } }, /cross-origin/],
    ['a create ceremony', { client: { type: 'webauthn.create' } }, /type/],
    ['another kind', { kind: 'proof' }, /kind/],
    ['an extra field', { extra: { note: 'x' } }, /fields/],
  ])('refuses %s', (_name, o, re) => {
    expect(why(() => checkAssertionBinding(assertion(o), pending))).toMatch(re);
  });

  it('refuses non-JSON and oversized input', () => {
    expect(why(() => checkAssertionBinding('{', pending))).toMatch(/not JSON/);
    expect(why(() => checkAssertionBinding('x'.repeat(20_000), pending))).toMatch(/too large/);
  });
});
