import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { checkApi, contentSecurityPolicy, corsHeaders, HttpError, preflight, type GuardConfig } from '../../../server/http';
import { Pairing } from '../../../server/pairing';

// SYNTHETIC origins and tokens only.
const HOST = '127.0.0.1:4173';
const SITE = 'https://site.example';
const OTHER = 'https://other.example';
const STRANGER = 'https://stranger.example';

const req = (headers: Record<string, string | undefined>, method = 'POST') => ({ method, headers }) as unknown as IncomingMessage;
const status = (f: () => unknown): number => {
  try {
    f();
    return 0;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.status;
  }
};
const fakeRes = () => {
  const out: { status?: number; headers?: Record<string, string>; ended: boolean } = { ended: false };
  const res = {
    writeHead(s: number, h: Record<string, string>) {
      out.status = s;
      out.headers = h;
      return res;
    },
    end() {
      out.ended = true;
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, out };
};

const setup = () => {
  const pairing = new Pairing([SITE, OTHER], { now: () => 5_000_000 });
  const { token } = pairing.pair(SITE, pairing.newCode().code);
  const cfg: GuardConfig = { host: HOST, sessionToken: 'local-page-session-synthetic', pairing };
  return { cfg, token, pairing };
};
const same = (cfg: GuardConfig, o: Record<string, string | undefined> = {}) => ({ host: HOST, origin: `http://${HOST}`, 'content-type': 'application/json', 'x-cbpr-session': cfg.sessionToken, 'sec-fetch-site': 'same-origin', ...o });
const cross = (token: string | undefined, o: Record<string, string | undefined> = {}) => ({ host: HOST, origin: SITE, 'content-type': 'application/json', 'x-cbpr-pair': token, 'sec-fetch-site': 'cross-site', ...o });

describe('checkApi with pairing configured', () => {
  describe.each(['none', 'exchange'] as const)("pairing: '%s'", (mode) => {
    it('same-origin with the page session → same-origin caller', () => {
      const { cfg } = setup();
      expect(checkApi(req(same(cfg)), cfg, { pairing: mode })).toEqual({ kind: 'same-origin' });
    });
    it('same-origin without x-cbpr-session → 403', () => {
      const { cfg } = setup();
      expect(status(() => checkApi(req(same(cfg, { 'x-cbpr-session': undefined })), cfg, { pairing: mode }))).toBe(403);
    });
    it('same-origin presenting only a pairing token → 403 (the page session is required)', () => {
      const { cfg, token } = setup();
      expect(status(() => checkApi(req(same(cfg, { 'x-cbpr-session': undefined, 'x-cbpr-pair': token })), cfg, { pairing: mode }))).toBe(403);
    });
    it.each(['cross-site', 'same-site'])('allowlisted cross-origin with sec-fetch-site %s → paired caller', (sfs) => {
      const { cfg, token } = setup();
      expect(checkApi(req(cross(token, { 'sec-fetch-site': sfs })), cfg, { pairing: mode })).toEqual({ kind: 'paired', origin: SITE });
    });
    it.each(['same-origin', 'none'])('allowlisted cross-origin with sec-fetch-site %s → 403', (sfs) => {
      const { cfg, token } = setup();
      expect(status(() => checkApi(req(cross(token, { 'sec-fetch-site': sfs })), cfg, { pairing: mode }))).toBe(403);
    });
    it('a cross origin carrying the local page session header → 403', () => {
      const { cfg, token } = setup();
      expect(status(() => checkApi(req(cross(token, { 'x-cbpr-session': cfg.sessionToken })), cfg, { pairing: mode }))).toBe(403);
    });
    it('a non-allowlisted origin → 403 even with a valid token', () => {
      const { cfg, token } = setup();
      expect(status(() => checkApi(req(cross(token, { origin: STRANGER })), cfg, { pairing: mode }))).toBe(403);
    });
    it('a missing Origin → 403', () => {
      const { cfg, token } = setup();
      expect(status(() => checkApi(req(cross(token, { origin: undefined })), cfg, { pairing: mode }))).toBe(403);
    });
    it.each([
      ['a DNS-rebinding Host', 'evil.example:4173'],
      ['the localhost alias', 'localhost:4173'],
      ['another port', '127.0.0.1:4174'],
    ])('%s → 421', (_n, host) => {
      const { cfg, token } = setup();
      expect(status(() => checkApi(req(cross(token, { host })), cfg, { pairing: mode }))).toBe(421);
    });
    it('a non-JSON content type → 415', () => {
      const { cfg, token } = setup();
      expect(status(() => checkApi(req(cross(token, { 'content-type': 'text/plain' })), cfg, { pairing: mode }))).toBe(415);
    });
    it('GET → 405', () => {
      const { cfg, token } = setup();
      expect(status(() => checkApi(req(cross(token), 'GET'), cfg, { pairing: mode }))).toBe(405);
    });
  });

  it("pairing 'none': an allowlisted cross-origin needs x-cbpr-pair (401 without it)", () => {
    const { cfg } = setup();
    expect(status(() => checkApi(req(cross(undefined)), cfg, { pairing: 'none' }))).toBe(401);
  });
  it("pairing 'none' is the default", () => {
    const { cfg } = setup();
    expect(status(() => checkApi(req(cross(undefined)), cfg))).toBe(401);
  });
  it("pairing 'none': a stale or foreign token → 401", () => {
    const { cfg } = setup();
    expect(status(() => checkApi(req(cross('z'.repeat(43))), cfg, { pairing: 'none' }))).toBe(401);
  });
  it("pairing 'none': SITE's token presented by OTHER (also allowlisted) → 401", () => {
    const { cfg, token } = setup();
    expect(status(() => checkApi(req(cross(token, { origin: OTHER })), cfg, { pairing: 'none' }))).toBe(401);
  });
  it("pairing 'exchange': the pairing exchange itself needs no token yet", () => {
    const { cfg } = setup();
    expect(checkApi(req(cross(undefined, { origin: OTHER })), cfg, { pairing: 'exchange' })).toEqual({ kind: 'paired', origin: OTHER });
  });
  it('a missing sec-fetch-site (older browser) is tolerated for a paired cross-origin', () => {
    const { cfg, token } = setup();
    expect(checkApi(req(cross(token, { 'sec-fetch-site': undefined })), cfg)).toEqual({ kind: 'paired', origin: SITE });
  });
  it('without a pairing config, every cross-origin is refused (403)', () => {
    const { cfg, token } = setup();
    const bare: GuardConfig = { host: cfg.host, sessionToken: cfg.sessionToken };
    expect(status(() => checkApi(req(cross(token)), bare, { pairing: 'exchange' }))).toBe(403);
  });
});

describe('corsHeaders', () => {
  it('echoes the exact origin, varies on Origin, and never allows credentials or *', () => {
    const h = corsHeaders(SITE);
    expect(h['Access-Control-Allow-Origin']).toBe(SITE);
    expect(h.Vary).toBe('Origin');
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toContain('access-control-allow-credentials');
    expect(Object.values(h)).not.toContain('*');
  });
});

describe('preflight', () => {
  const pre = (o: Record<string, string | undefined> = {}) => ({ host: HOST, origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, x-cbpr-pair', ...o });
  const run = (headers: Record<string, string | undefined>, cfg = setup().cfg) => {
    const { res, out } = fakeRes();
    preflight(req(headers, 'OPTIONS'), res, cfg);
    return out;
  };
  it('an allowlisted origin asking POST with the two allowed headers → 204 with exact CORS', () => {
    const out = run(pre());
    expect(out.status).toBe(204);
    expect(out.ended).toBe(true);
    expect(out.headers?.['Access-Control-Allow-Origin']).toBe(SITE);
    expect(out.headers?.['Access-Control-Allow-Methods']).toBe('POST');
    expect(out.headers?.['Access-Control-Allow-Headers']).toBe('content-type, x-cbpr-pair');
    expect(out.headers?.['Access-Control-Allow-Credentials']).toBeUndefined();
  });
  it('header names are matched case-insensitively', () => {
    expect(run(pre({ 'access-control-request-headers': 'Content-Type,X-CBPR-Pair' })).status).toBe(204);
  });
  it('no requested headers is allowed', () => {
    expect(run(pre({ 'access-control-request-headers': undefined })).status).toBe(204);
  });
  it.each(['GET', 'PUT', 'DELETE', undefined])('method %s → 403', (m) => {
    expect(status(() => run(pre({ 'access-control-request-method': m })))).toBe(403);
  });
  it.each(['x-cbpr-session', 'authorization', 'content-type, x-cbpr-signer', 'cookie'])('requested header %s → 403', (h) => {
    expect(status(() => run(pre({ 'access-control-request-headers': h })))).toBe(403);
  });
  it('a non-allowlisted origin → 403', () => {
    expect(status(() => run(pre({ origin: STRANGER })))).toBe(403);
  });
  it('a bad Host → 421', () => {
    expect(status(() => run(pre({ host: 'evil.example:4173' })))).toBe(421);
  });
  it('without a pairing config → 403', () => {
    const { cfg } = setup();
    expect(status(() => run(pre(), { host: cfg.host, sessionToken: cfg.sessionToken }))).toBe(403);
  });
  it('sends the Private Network header only when asked', () => {
    const asked = run(pre({ 'access-control-request-private-network': 'true' }));
    const notAsked = run(pre());
    expect(asked.headers?.['Access-Control-Allow-Private-Network']).toBe('true');
    expect(notAsked.headers?.['Access-Control-Allow-Private-Network']).toBeUndefined();
  });
  it('a non-"true" private-network request value does not grant it', () => {
    expect(run(pre({ 'access-control-request-private-network': 'yes' })).headers?.['Access-Control-Allow-Private-Network']).toBeUndefined();
  });
});

describe('contentSecurityPolicy(extra)', () => {
  it('the default keeps style-src self and the public RPC only', () => {
    const csp = contentSecurityPolicy();
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("connect-src 'self' https://rpc.plasma.to;");
    expect(csp).not.toContain('unsafe-inline');
  });
  it('accepts an exact loopback origin and appends it to connect-src only', () => {
    const csp = contentSecurityPolicy(['http://127.0.0.1:4180']);
    expect(csp).toContain("connect-src 'self' https://rpc.plasma.to http://127.0.0.1:4180;");
    expect(csp).toContain("style-src 'self';");
    expect(csp.match(/127\.0\.0\.1/g)).toHaveLength(1);
  });
  it.each([
    ['a non-loopback host', 'http://evil.example:4180'],
    ['https loopback', 'https://127.0.0.1:4180'],
    ['localhost', 'http://localhost:4180'],
    ['no port', 'http://127.0.0.1'],
    ['a trailing slash', 'http://127.0.0.1:4180/'],
    ['a path', 'http://127.0.0.1:4180/x'],
    ['a wildcard', 'http://127.0.0.1:*'],
    ['an injected directive', "http://127.0.0.1:4180; script-src 'unsafe-inline'"],
    ['a second source in one entry', 'http://127.0.0.1:4180 https://evil.example'],
    ['a newline', 'http://127.0.0.1:4180\n'],
    ['the empty string', ''],
  ])('rejects %s', (_n, o) => {
    expect(() => contentSecurityPolicy([o])).toThrow(/exact loopback origin/);
  });
});
