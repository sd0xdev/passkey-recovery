// EIP-6963 discovery (GAS-01): every announced wallet is listed, OKX first, re-announces de-duplicated,
// malformed announcements dropped, names sanitised, icons never used.
import { describe, expect, it } from 'vitest';
import { discoverWallets, OKX_RDNS, parseAnnouncement, sanitizeName, type Announced } from '../../../src/wallet/eip6963';

const provider = { request: async () => null };
const info = (uuid: string, name: string, rdns: string) => ({ info: { uuid, name, rdns, icon: 'data:image/svg+xml,<svg onload=alert(1)>' }, provider });
const U1 = '11111111-2222-4333-8444-555555555555';
const U2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const U3 = '99999999-8888-4777-8666-555555555555';

describe('parseAnnouncement', () => {
  it('valid announcement → uuid/rdns lower-cased, no icon kept', () => {
    const a = parseAnnouncement(info(U1.toUpperCase(), 'OKX Wallet', 'COM.OKEX.WALLET'))!;
    expect(a).toEqual({ uuid: U1, name: 'OKX Wallet', rdns: OKX_RDNS, provider });
    expect(a).not.toHaveProperty('icon');
  });
  it.each([
    ['null', null],
    ['no provider', { info: { uuid: U1, name: 'x', rdns: 'io.x' } }],
    ['provider without request', { info: { uuid: U1, name: 'x', rdns: 'io.x' }, provider: {} }],
    ['bad uuid', info('not-a-uuid', 'x', 'io.x')],
    ['bad rdns', info(U1, 'x', 'javascript:alert(1)')],
    ['single-label rdns', info(U1, 'x', 'localhost')],
  ])('%s → null', (_n, d) => expect(parseAnnouncement(d)).toBeNull());
});

describe('sanitizeName', () => {
  it('strips control and bidi characters and caps length', () => {
    expect(sanitizeName('Evil‮Wallet\u0000')).toBe('EvilWallet');
    expect(sanitizeName('x'.repeat(100))).toHaveLength(40);
  });
  it('non-string or empty → a neutral placeholder', () => {
    expect(sanitizeName(42)).toBe('Unnamed wallet');
    expect(sanitizeName('   ')).toBe('Unnamed wallet');
  });
});

describe('discoverWallets', () => {
  it('requests announcements, lists all, OKX first, de-duplicates by uuid', () => {
    const t = new EventTarget();
    let requested = 0;
    t.addEventListener('eip6963:requestProvider', () => requested++);
    let last: Announced[] = [];
    const stop = discoverWallets((l) => (last = l), t);
    expect(requested).toBe(1);
    const announce = (d: unknown) => t.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: d }));
    announce(info(U2, 'Alpha Wallet', 'io.alpha'));
    announce(info(U1, 'OKX Wallet', OKX_RDNS));
    announce(info(U2, 'Alpha Wallet v2', 'io.alpha'));
    announce({ junk: true });
    expect(last.map((w) => w.name)).toEqual(['OKX Wallet', 'Alpha Wallet v2']);
    stop();
    announce(info(U3, 'Late', 'io.late'));
    expect(last).toHaveLength(2);
  });
});
