import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { checkApi, checkSigner, HttpError, MAX_BODY_BYTES, MAX_RELAY_BODY_BYTES, readJson, RELAY_ROUTES, SECURITY_HEADERS } from '../../../server/http';
import { MAX_RAW_TX_BYTES } from '../../../server/relay';

const cfg = { host: '127.0.0.1:4173', sessionToken: 'tok-synthetic' };
const req = (headers: Record<string, string>, method = 'POST') => ({ method, headers }) as unknown as IncomingMessage;
const api = { host: cfg.host, origin: 'http://127.0.0.1:4173', 'content-type': 'application/json', 'x-cbpr-session': cfg.sessionToken, 'sec-fetch-site': 'same-origin' };
const status = (f: () => void) => {
  try {
    f();
    return 0;
  } catch (e) {
    return (e as HttpError).status;
  }
};

describe('browser API guard', () => {
  it('accepts the served page', () => expect(status(() => checkApi(req(api), cfg))).toBe(0));
  it.each([
    ['DNS-rebinding Host', { ...api, host: 'evil.example:4173' }, 421],
    ['localhost alias Host', { ...api, host: 'localhost:4173' }, 421],
    ['foreign Origin', { ...api, origin: 'https://evil.example' }, 403],
    ['missing Origin', { ...api, origin: '' }, 403],
    ['cross-site fetch', { ...api, 'sec-fetch-site': 'cross-site' }, 403],
    ['form content type', { ...api, 'content-type': 'text/plain' }, 415],
    ['stale session token', { ...api, 'x-cbpr-session': 'old' }, 403],
  ])('refuses %s', (_, h, code) => expect(status(() => checkApi(req(h as Record<string, string>), cfg))).toBe(code));
  it('refuses GET', () => expect(status(() => checkApi(req(api, 'GET'), cfg))).toBe(405));
});

describe('Terminal signer channel guard', () => {
  const sig = { host: cfg.host, 'x-cbpr-signer': '1', 'content-type': 'application/json' };
  it('accepts the CLI shape', () => expect(status(() => checkSigner(req(sig), cfg))).toBe(0));
  it.each([
    ['any Origin (browser)', { ...sig, origin: 'http://127.0.0.1:4173' }],
    ['Sec-Fetch-Site (browser)', { ...sig, 'sec-fetch-site': 'same-origin' }],
    ['Referer (browser)', { ...sig, referer: 'http://127.0.0.1:4173/' }],
    ['missing signer header', { host: cfg.host, 'content-type': 'application/json' }],
  ])('refuses %s', (_, h) => expect(status(() => checkSigner(req(h as Record<string, string>), cfg))).toBe(403));
});

it('security headers keep CSP, no-referrer, nosniff and CORP', () => {
  expect(SECURITY_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
  expect(SECURITY_HEADERS['Referrer-Policy']).toBe('no-referrer');
  expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
  expect(SECURITY_HEADERS['Cross-Origin-Resource-Policy']).toBe('same-origin');
});

describe('readJson body limits (relay routes carry a whole signed transaction)', () => {
  const body = (bytes: number) => Readable.from([Buffer.from(JSON.stringify({ raw: `0x${'ab'.repeat(Math.max(0, (bytes - 12) / 2))}` }))]) as unknown as IncomingMessage;
  const status = (p: Promise<unknown>) => p.then(() => 200, (e: unknown) => (e instanceof HttpError ? e.status : 500));
  it('the default limit refuses a body over MAX_BODY_BYTES (413) and takes one under it', async () => {
    expect(await status(readJson(body(MAX_BODY_BYTES + 2)))).toBe(413);
    expect(await status(readJson(body(MAX_BODY_BYTES - 64)))).toBe(200);
  });
  it('the relay limit takes a hex-encoded transaction of MAX_RAW_TX_BYTES and refuses past its own cap', async () => {
    expect(await status(readJson(body(2 * MAX_RAW_TX_BYTES + 64), MAX_RELAY_BODY_BYTES))).toBe(200);
    expect(await status(readJson(body(MAX_RELAY_BODY_BYTES + 2), MAX_RELAY_BODY_BYTES))).toBe(413);
  });
  it('a contract-creation step (EIP-3860 initcode, 49,152 bytes) fits under the raw cap', () => {
    expect(MAX_RAW_TX_BYTES).toBeGreaterThanOrEqual(49_152 + 1024);
    expect(MAX_RELAY_BODY_BYTES).toBeGreaterThanOrEqual(2 * MAX_RAW_TX_BYTES + 2);
  });
  it('only the deploy and transfer relay routes get the larger limit', () => {
    expect([...RELAY_ROUTES].sort()).toEqual(['/api/deploy/send', '/api/transfer/relay']);
  });
});
