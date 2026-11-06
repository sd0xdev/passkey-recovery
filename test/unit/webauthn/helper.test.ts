// Helper source: reviewable, only navigator.credentials.get, refuses the wrong origin, never logs the
// assertion, and still reaches copy() after the Passkey prompt resolves (SYNTHETIC run).
import { describe, expect, it, vi } from 'vitest';
import { bytesToBase64url, base64urlToBytes } from '../../../src/crypto/bytes';
import { createProofSession } from '../../../src/proof/challenge';
import { HELPER_VERSION, buildHelper } from '../../../src/webauthn/helper';
import { legacyHelperSourceV1 } from '../../fixtures/legacyHelper';

const session = createProofSession({ account: '0x5a00000000000000000000000000000000000a01', chainId: 9745, ownerIndex: 0, rpId: 'keys.coinbase.com', origin: 'https://keys.coinbase.com' }, new Date('2026-10-31T03:00:00Z'), (n: number) => new Uint8Array(n).fill(3));
const helper = buildHelper(session.challenge, 'proof');

type PublicKeyOpts = { publicKey: { challenge: Uint8Array; rpId: string; userVerification: string } };

// Runs a helper source the way the DevTools console does: `copy` resolves only through a scope that
// exists while the console's synchronous evaluation runs (`utilityLifetime: 'sync'`), and
// navigator.credentials.get returns a Promise that stays pending until the test settles it.
function runHelper(source: string, origin: string, opts: { withCopy?: boolean; utilityLifetime?: 'sync' | 'forever' } = {}) {
  const { withCopy = true, utilityLifetime = 'sync' } = opts;
  let settle: (() => void) | null = null;
  const get = vi.fn(
    (o: PublicKeyOpts) =>
      new Promise((resolve) => {
        settle = () =>
          resolve({
            rawId: new Uint8Array([1, 2]).buffer,
            response: {
              authenticatorData: new Uint8Array(37).buffer,
              clientDataJSON: new TextEncoder().encode(JSON.stringify({ challenge: bytesToBase64url(o.publicKey.challenge) })).buffer,
              signature: new Uint8Array([0x30]).buffer,
              userHandle: null,
            },
          });
      }),
  );
  const copy = vi.fn();
  let utilitiesInScope = withCopy;
  const utilities = new Proxy({} as Record<string, unknown>, {
    has: (_t, key) => key === 'copy' && utilitiesInScope,
    get: (_t, key) => (key === 'copy' && utilitiesInScope ? copy : undefined),
  });
  const consoleSpy = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dir: vi.fn(), table: vi.fn() };
  const fn = new Function('location', 'navigator', 'console', '__utilities', `with (__utilities) { return ${source}; }`) as (...a: unknown[]) => Promise<string>;
  const done = fn({ origin }, { credentials: { get } }, consoleSpy, utilities);
  if (utilityLifetime === 'sync') utilitiesInScope = false; // the console's synchronous evaluation has ended
  const resolveCredential = async () => {
    await Promise.resolve();
    expect(settle).not.toBeNull();
    settle!();
    return done;
  };
  return { get, copy, consoleSpy, done, resolveCredential };
}

const silent = (spy: Record<string, ReturnType<typeof vi.fn>>) => Object.values(spy).every((f) => f.mock.calls.length === 0);

describe('buildHelper', () => {
  it('is short enough to type by hand and embeds the exact challenge and version', () => {
    expect(helper.source.split('\n').length).toBeLessThanOrEqual(10);
    expect(helper.source).toContain(`d("${bytesToBase64url(session.challenge)}")`);
    expect(helper.source).toContain(`"${HELPER_VERSION}: assertion copied to clipboard (not printed)"`);
    expect(helper.sha256Hex).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(['console', 'fetch', 'XMLHttpRequest', 'import', 'cookie', 'localStorage', 'sessionStorage', 'indexedDB', 'eval', 'postMessage', 'allowCredentials', 'create('])(
    'contains no %s',
    (word) => expect(helper.source).not.toContain(word),
  );

  it('looks copy up only before the await, and calls the captured reference after it', () => {
    const [beforeAwait, afterAwait] = helper.source.split('await navigator.credentials.get');
    expect(beforeAwait).toMatch(/const cp = typeof copy === "function" \? copy : null;/);
    expect(afterAwait).not.toMatch(/\bcopy\b/);
    expect(afterAwait).toContain('cp(JSON.stringify(');
  });

  it('on keys.coinbase.com: survives the short-lived copy() across a pending Passkey prompt and copies only a string', async () => {
    const { get, copy, consoleSpy, done, resolveCredential } = runHelper(helper.source, 'https://keys.coinbase.com');
    let settled = false;
    void done.then(() => (settled = true), () => (settled = true));
    await Promise.resolve();
    expect(get).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false); // genuinely pending until the authenticator answers
    expect(await resolveCredential()).toBe(`${HELPER_VERSION}: assertion copied to clipboard (not printed)`);
    const opts = get.mock.calls[0]![0].publicKey;
    expect(opts.rpId).toBe('keys.coinbase.com');
    expect(opts.userVerification).toBe('required');
    expect(bytesToBase64url(opts.challenge)).toBe(bytesToBase64url(session.challenge));
    expect(copy).toHaveBeenCalledTimes(1);
    expect(typeof copy.mock.calls[0]![0]).toBe('string');
    const out = JSON.parse(copy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(out).toMatchObject({ format: 'cbpr-assertion-v1', kind: 'proof', origin: 'https://keys.coinbase.com', userHandle: null });
    expect(base64urlToBytes(out.credentialId as string)).toEqual(new Uint8Array([1, 2]));
    expect(silent(consoleSpy)).toBe(true);
  });

  it('regression: the v1 helper fails the same harness with "copy is not defined" after the Passkey resolves', async () => {
    const legacy = runHelper(legacyHelperSourceV1(session.challenge, 'proof'), 'https://keys.coinbase.com');
    await expect(legacy.resolveCredential()).rejects.toThrow(/copy is not defined/);
    expect(legacy.get).toHaveBeenCalledTimes(1);
    expect(legacy.copy).not.toHaveBeenCalled();
    expect(silent(legacy.consoleSpy)).toBe(true);
  });

  it('control: with a utility that never expires, v1 and v2 both copy (the harness, not luck, separates them)', async () => {
    for (const source of [legacyHelperSourceV1(session.challenge, 'proof'), helper.source]) {
      const run = runHelper(source, 'https://keys.coinbase.com', { utilityLifetime: 'forever' });
      await run.resolveCredential();
      expect(run.copy).toHaveBeenCalledTimes(1);
    }
  });

  it('without DevTools copy(): throws before calling get(), prints nothing', async () => {
    const { get, consoleSpy, done } = runHelper(helper.source, 'https://keys.coinbase.com', { withCopy: false });
    await expect(done).rejects.toThrow(/copy\(\) unavailable/);
    expect(get).not.toHaveBeenCalled();
    expect(silent(consoleSpy)).toBe(true);
  });

  it.each(['http://127.0.0.1:4173', 'https://wallet.coinbase.com', 'https://keys.coinbase.com.evil.example'])(
    'on %s: throws before calling get()',
    async (origin) => {
      const { get, done } = runHelper(helper.source, origin);
      await expect(done).rejects.toThrow(/Run only on https:\/\/keys\.coinbase\.com/);
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('refuses a non-32-byte challenge', () => expect(() => buildHelper(new Uint8Array(31), 'proof')).toThrow());
});
