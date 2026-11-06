import { describe, expect, it } from 'vitest';
import { PAIR_CODE_TTL_MS, PAIR_MAX_FAILURES, Pairing, PairingError, parseAllowedOrigin, SESSION_IDLE_MS, SESSION_MAX_MS } from '../../../server/pairing';

// SYNTHETIC origins only: none of these is a real deployment of the website.
const SITE = 'https://site.example';
const OTHER = 'https://other.example';
const STRANGER = 'https://stranger.example';

const fakeClock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};
const setup = () => {
  const clock = fakeClock();
  const p = new Pairing([SITE, OTHER], clock);
  return { clock, p };
};
const statusOf = (f: () => unknown): number => {
  try {
    f();
    return 0;
  } catch (e) {
    if (!(e instanceof PairingError)) throw e;
    return e.status;
  }
};

describe('parseAllowedOrigin', () => {
  it.each([['https://site.example'], ['https://site.example:8443'], ['https://sub.site.example']])('accepts the exact https origin %s', (o) => {
    expect(parseAllowedOrigin(o)).toBe(o);
  });
  it.each([
    ['a path', 'https://site.example/app'],
    ['a trailing slash', 'https://site.example/'],
    ['a query', 'https://site.example?x=1'],
    ['a fragment', 'https://site.example#x'],
    ['a wildcard subdomain', 'https://*.site.example'],
    ['a bare wildcard', '*'],
    ['userinfo', 'https://user@site.example'],
    ['userinfo with password', 'https://user:pw@site.example'],
    ['plain http', 'http://site.example'],
    ['an upper-case host', 'https://SITE.example'],
    ['a default-port spelling', 'https://site.example:443'],
    ['a non-http scheme', 'ftp://site.example'],
    ['not a URL', 'site.example'],
    ['an empty string', ''],
  ])('rejects %s (400)', (_n, o) => {
    expect(statusOf(() => parseAllowedOrigin(o))).toBe(400);
  });
  it('rejects loopback http by default', () => {
    expect(statusOf(() => parseAllowedOrigin('http://127.0.0.1:4173'))).toBe(400);
  });
  it('accepts loopback http only under allowLoopbackHttp', () => {
    expect(parseAllowedOrigin('http://127.0.0.1:4173', { allowLoopbackHttp: true })).toBe('http://127.0.0.1:4173');
  });
  it('allowLoopbackHttp does not open http for a non-loopback host', () => {
    expect(statusOf(() => parseAllowedOrigin('http://site.example', { allowLoopbackHttp: true }))).toBe(400);
  });
  it('allowLoopbackHttp still rejects a path on a loopback origin', () => {
    expect(statusOf(() => parseAllowedOrigin('http://127.0.0.1:4173/', { allowLoopbackHttp: true }))).toBe(400);
  });
  it('truncates an over-long bad value in the error message', () => {
    const long = 'x'.repeat(500);
    try {
      parseAllowedOrigin(long);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message.length).toBeLessThan(200);
    }
  });
});

describe('Pairing code', () => {
  it('has the XXXX-XXXX format from the unambiguous alphabet', () => {
    const { p } = setup();
    for (let i = 0; i < 50; i++) expect(p.newCode().code).toMatch(/^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTVWXYZ2-9]{4}$/);
  });
  it('expires PAIR_CODE_TTL_MS after creation and reports that expiry', () => {
    const { p, clock } = setup();
    expect(p.newCode().expiresAt).toBe(clock.now() + PAIR_CODE_TTL_MS);
  });
  it('passes each new code to the onNewCode listener', () => {
    const { p } = setup();
    const seen: string[] = [];
    p.onNewCode((c) => seen.push(c));
    const { code } = p.newCode();
    expect(seen).toEqual([code]);
  });
  it('the right code from an allowlisted origin yields a token', () => {
    const { p } = setup();
    const { code } = p.newCode();
    const r = p.pair(SITE, code);
    expect(r.token.length).toBeGreaterThanOrEqual(40);
  });
  it('the session expiry returned is the idle window', () => {
    const { p, clock } = setup();
    const { code } = p.newCode();
    expect(p.pair(SITE, code).expiresAt).toBe(clock.now() + SESSION_IDLE_MS);
  });
  it('is single-use: a second pairing with the same code is 410', () => {
    const { p } = setup();
    const { code } = p.newCode();
    p.pair(SITE, code);
    expect(statusOf(() => p.pair(SITE, code))).toBe(410);
  });
  it('without any code, pairing is 410', () => {
    const { p } = setup();
    expect(statusOf(() => p.pair(SITE, 'ABCD-EFGH'))).toBe(410);
  });
  it('is still valid at exactly the TTL', () => {
    const { p, clock } = setup();
    const { code } = p.newCode();
    clock.advance(PAIR_CODE_TTL_MS);
    expect(statusOf(() => p.pair(SITE, code))).toBe(0);
  });
  it('is 410 one millisecond after the TTL', () => {
    const { p, clock } = setup();
    const { code } = p.newCode();
    clock.advance(PAIR_CODE_TTL_MS + 1);
    expect(statusOf(() => p.pair(SITE, code))).toBe(410);
  });
  it('a wrong code is 403 and leaves the right code usable', () => {
    const { p } = setup();
    const { code } = p.newCode();
    const wrong = code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA';
    expect(statusOf(() => p.pair(SITE, wrong))).toBe(403);
    expect(statusOf(() => p.pair(SITE, code))).toBe(0);
  });
  it('a code of the wrong length or type counts as wrong (403)', () => {
    const { p } = setup();
    p.newCode();
    expect(statusOf(() => p.pair(SITE, 'ABC'))).toBe(403);
    expect(statusOf(() => p.pair(SITE, 12345678))).toBe(403);
    expect(statusOf(() => p.pair(SITE, undefined))).toBe(403);
  });
  it(`${PAIR_MAX_FAILURES} wrong codes retire it: the last is 429 and the right code is then 410`, () => {
    const { p } = setup();
    const { code } = p.newCode();
    const wrong = code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA';
    const codes = Array.from({ length: PAIR_MAX_FAILURES }, () => statusOf(() => p.pair(SITE, wrong)));
    expect(codes).toEqual([...Array(PAIR_MAX_FAILURES - 1).fill(403), 429]);
    expect(statusOf(() => p.pair(SITE, code))).toBe(410);
  });
  it('a fresh code resets the failure count', () => {
    const { p } = setup();
    const first = p.newCode().code;
    const wrong = 'AAAA-AAAA' === first ? 'BBBB-BBBB' : 'AAAA-AAAA';
    for (let i = 0; i < PAIR_MAX_FAILURES - 1; i++) statusOf(() => p.pair(SITE, wrong));
    const { code } = p.newCode();
    const w2 = code === 'AAAA-AAAA' ? 'BBBB-BBBB' : 'AAAA-AAAA';
    expect(statusOf(() => p.pair(SITE, w2))).toBe(403);
  });
  it.each([
    ['lower case', (c: string) => c.toLowerCase()],
    ['no hyphen', (c: string) => c.replace('-', '')],
    ['spaces instead of the hyphen', (c: string) => c.replace('-', '  ')],
    ['mixed case with extra hyphens', (c: string) => `-${c.slice(0, 2).toLowerCase()}-${c.slice(2)}-`],
  ])('normalizes %s', (_n, f) => {
    const { p } = setup();
    const { code } = p.newCode();
    expect(statusOf(() => p.pair(SITE, f(code)))).toBe(0);
  });
  it('a non-allowlisted origin is 403 and does not consume or penalise the code', () => {
    const { p } = setup();
    const { code } = p.newCode();
    for (let i = 0; i < PAIR_MAX_FAILURES + 1; i++) expect(statusOf(() => p.pair(STRANGER, code))).toBe(403);
    expect(statusOf(() => p.pair(SITE, code))).toBe(0);
  });
  it('a missing origin is 403', () => {
    const { p } = setup();
    const { code } = p.newCode();
    expect(statusOf(() => p.pair(undefined, code))).toBe(403);
  });
  it('newCode invalidates the previous code', () => {
    const { p } = setup();
    const old = p.newCode().code;
    const fresh = p.newCode().code;
    if (old !== fresh) expect(statusOf(() => p.pair(SITE, old))).toBe(403);
    expect(statusOf(() => p.pair(SITE, fresh))).toBe(0);
  });
});

describe('Pairing.check (session)', () => {
  const paired = (origin = SITE) => {
    const s = setup();
    const { token } = s.p.pair(origin, s.p.newCode().code);
    return { ...s, token };
  };
  it('accepts the paired origin with its token', () => {
    const { p, token } = paired();
    expect(p.check(SITE, token)).toBe(true);
  });
  it("refuses another allowlisted origin presenting this origin's token", () => {
    const { p, token } = paired();
    expect(p.check(OTHER, token)).toBe(false);
  });
  it('a cross-origin attempt does not end the rightful session', () => {
    const { p, token } = paired();
    p.check(OTHER, token);
    expect(p.check(SITE, token)).toBe(true);
  });
  it('refuses a non-allowlisted origin, a missing origin and a non-string token', () => {
    const { p, token } = paired();
    expect([p.check(STRANGER, token), p.check(undefined, token), p.check(SITE, undefined), p.check(SITE, 42)]).toEqual([false, false, false, false]);
  });
  it('refuses an unknown token', () => {
    const { p } = paired();
    expect(p.check(SITE, 'x'.repeat(43))).toBe(false);
  });
  it('refuses a too-short or too-long token', () => {
    const { p } = paired();
    expect([p.check(SITE, 'short'), p.check(SITE, 'x'.repeat(101))]).toEqual([false, false]);
  });
  it('stays live at exactly the idle limit', () => {
    const { p, token, clock } = paired();
    clock.advance(SESSION_IDLE_MS);
    expect(p.check(SITE, token)).toBe(true);
  });
  it('ends after 30 min idle and stays ended', () => {
    const { p, token, clock } = paired();
    clock.advance(SESSION_IDLE_MS + 1);
    expect(p.check(SITE, token)).toBe(false);
    clock.advance(-SESSION_IDLE_MS);
    expect(p.check(SITE, token)).toBe(false);
  });
  it('use refreshes the idle timer', () => {
    const { p, token, clock } = paired();
    for (let i = 0; i < 4; i++) {
      clock.advance(SESSION_IDLE_MS - 1000);
      expect(p.check(SITE, token)).toBe(true);
    }
  });
  it('ends after the 8 h absolute limit even when used continuously', () => {
    const { p, token, clock } = paired();
    let elapsed = 0;
    while (elapsed + 20 * 60 * 1000 <= SESSION_MAX_MS) {
      clock.advance(20 * 60 * 1000);
      elapsed += 20 * 60 * 1000;
      expect(p.check(SITE, token)).toBe(true);
    }
    clock.advance(SESSION_MAX_MS - elapsed + 1);
    expect(p.check(SITE, token)).toBe(false);
  });
  it('one session per origin: re-pairing replaces the old token', () => {
    const { p, token } = paired();
    const { token: t2 } = p.pair(SITE, p.newCode().code);
    expect([p.check(SITE, token), p.check(SITE, t2)]).toEqual([false, true]);
  });
  it("re-pairing one origin keeps another origin's session", () => {
    const { p, token } = paired(SITE);
    const { token: other } = p.pair(OTHER, p.newCode().code);
    p.pair(SITE, p.newCode().code);
    expect([p.check(SITE, token), p.check(OTHER, other)]).toEqual([false, true]);
  });
  it('regression (NX-03): a restarted runner (a new Pairing) does not know any token or code of the old one', () => {
    const { p, token, clock } = paired();
    const { code } = p.newCode();
    const restarted = new Pairing([SITE, OTHER], clock);
    expect(restarted.check(SITE, token)).toBe(false);
    expect(statusOf(() => restarted.pair(SITE, code))).not.toBe(0);
  });
  it('revokeAll ends every session and the open code', () => {
    const { p, token } = paired();
    const { code } = p.newCode();
    p.revokeAll();
    expect(p.check(SITE, token)).toBe(false);
    expect(statusOf(() => p.pair(SITE, code))).toBe(410);
  });
  it('activeOrigins lists live sessions only', () => {
    const { p, clock } = paired();
    expect(p.activeOrigins()).toEqual([SITE]);
    clock.advance(SESSION_IDLE_MS + 1);
    expect(p.activeOrigins()).toEqual([]);
  });
  it('isAllowed matches the exact allowlist only', () => {
    const { p } = setup();
    expect([p.isAllowed(SITE), p.isAllowed(`${SITE}/`), p.isAllowed('https://SITE.example'), p.isAllowed(undefined)]).toEqual([true, false, false, false]);
  });
});
