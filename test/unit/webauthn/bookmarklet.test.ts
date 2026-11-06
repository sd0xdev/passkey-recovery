// The product bookmarklet (ADR-004): static code, a request CODE as its only input, only
// navigator.credentials.get, refuses other origins and malformed codes, clipboard first with a prompt
// fallback, never logs. Run the way a browser runs a javascript: bookmark (SYNTHETIC credential).
import { describe, expect, it, vi } from 'vitest';
import { bytesToBase64url } from '../../../src/crypto/bytes';
import { BOOKMARKLET_SHA256, BOOKMARKLET_SOURCE, BOOKMARKLET_URL, BOOKMARKLET_VERSION, parseRequestCode, requestCode } from '../../../src/webauthn/bookmarklet';

const challenge = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 0xff);

function runBookmark(o: { origin: string; answer: string | null; clipboard: 'ok' | 'refused' | 'missing' }) {
  const alerts: string[] = [];
  const prompts: Array<{ message: string; value?: string }> = [];
  const writeText = vi.fn(async (_text: string) => {
    if (o.clipboard === 'refused') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  });
  const get = vi.fn(async (opts: { publicKey: { challenge: Uint8Array; rpId: string; userVerification: string } }) => ({
    rawId: new Uint8Array([9, 9]).buffer,
    response: { authenticatorData: new Uint8Array(37).buffer, clientDataJSON: new TextEncoder().encode(JSON.stringify({ challenge: bytesToBase64url(opts.publicKey.challenge) })).buffer, signature: new Uint8Array([0x30, 1]).buffer, userHandle: null },
  }));
  const consoleSpy = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const nav = { credentials: { get }, ...(o.clipboard === 'missing' ? {} : { clipboard: { writeText } }) };
  const body = decodeURIComponent(BOOKMARKLET_URL.slice('javascript:'.length)).replace(/;void 0$/, '');
  const fn = new Function('location', 'navigator', 'console', 'alert', 'prompt', `return ${body};`) as (...a: unknown[]) => Promise<void>;
  const done = fn({ origin: o.origin }, nav, consoleSpy, (m: string) => alerts.push(m), (message: string, value?: string) => {
    prompts.push({ message, ...(value !== undefined ? { value } : {}) });
    return prompts.length === 1 ? o.answer : null;
  });
  return { done, alerts, prompts, get, writeText, consoleSpy };
}

describe('request code', () => {
  it('round-trips kind and the exact 32-byte challenge', () => {
    const code = requestCode(challenge, 'userop');
    expect(code).toBe(`cbpr1:userop:${bytesToBase64url(challenge)}`);
    expect(parseRequestCode(code)).toEqual({ kind: 'userop', challenge });
  });
  it.each(['', 'cbpr1:userop:', 'cbpr1:sign:' + 'A'.repeat(43), 'cbpr2:proof:' + 'A'.repeat(43), 'cbpr1:proof:' + 'A'.repeat(42), 'cbpr1:proof:' + 'A'.repeat(43) + ';alert(1)'])('malformed %j → null', (c) => expect(parseRequestCode(c)).toBeNull());
  it('a challenge that is not 32 bytes → throws', () => expect(() => requestCode(new Uint8Array(31), 'proof')).toThrow());
});

describe('bookmarklet source', () => {
  it('is one static bookmark: no challenge baked in, versioned, hashed', () => {
    expect(BOOKMARKLET_URL.startsWith('javascript:')).toBe(true);
    expect(BOOKMARKLET_SOURCE).not.toContain(bytesToBase64url(challenge));
    expect(BOOKMARKLET_SOURCE).toContain(BOOKMARKLET_VERSION);
    expect(BOOKMARKLET_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each(['console', 'fetch', 'XMLHttpRequest', 'import(', 'cookie', 'localStorage', 'sessionStorage', 'indexedDB', 'eval', 'postMessage', 'opener', 'create(', 'Function'])('contains no %s', (w) => expect(BOOKMARKLET_SOURCE).not.toContain(w));
});

describe('running the bookmark', () => {
  const code = requestCode(challenge, 'userop');

  it('on keys.coinbase.com with clipboard → signs the pasted challenge and copies the assertion, never logs', async () => {
    const r = runBookmark({ origin: 'https://keys.coinbase.com', answer: code, clipboard: 'ok' });
    await r.done;
    expect(r.get).toHaveBeenCalledTimes(1);
    expect(r.get.mock.calls[0]![0].publicKey).toMatchObject({ rpId: 'keys.coinbase.com', userVerification: 'required', challenge });
    const out = JSON.parse(r.writeText.mock.calls[0]![0]);
    expect(out).toMatchObject({ format: 'cbpr-assertion-v1', kind: 'userop', rpId: 'keys.coinbase.com', origin: 'https://keys.coinbase.com' });
    expect(r.alerts.at(-1)).toMatch(/clipboard/);
    expect(Object.values(r.consoleSpy).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it.each(['refused', 'missing'] as const)('clipboard %s → the result is shown once in a prompt to copy by hand', async (clipboard) => {
    const r = runBookmark({ origin: 'https://keys.coinbase.com', answer: code, clipboard });
    await r.done;
    expect(r.prompts).toHaveLength(2);
    expect(JSON.parse(r.prompts[1]!.value!)).toMatchObject({ format: 'cbpr-assertion-v1', kind: 'userop' });
    expect(r.alerts).toEqual([]);
  });

  it('on another origin → refuses before asking for a code or a Passkey', async () => {
    const r = runBookmark({ origin: 'https://keys.coinbase.com.evil.example', answer: code, clipboard: 'ok' });
    await r.done;
    expect(r.prompts).toEqual([]);
    expect(r.get).not.toHaveBeenCalled();
    expect(r.alerts[0]).toMatch(/open https:\/\/keys\.coinbase\.com first/);
  });

  it.each(['alert(document.cookie)', 'cbpr1:userop:short', `${code} extra`])('pasted %j (not a request code) → refused, nothing signed', async (answer) => {
    const r = runBookmark({ origin: 'https://keys.coinbase.com', answer, clipboard: 'ok' });
    await r.done;
    expect(r.get).not.toHaveBeenCalled();
    expect(r.alerts[0]).toMatch(/not a request code/);
  });

  it('cancelled prompt → nothing happens', async () => {
    const r = runBookmark({ origin: 'https://keys.coinbase.com', answer: null, clipboard: 'ok' });
    await r.done;
    expect(r.get).not.toHaveBeenCalled();
    expect(r.alerts).toEqual([]);
  });
});
