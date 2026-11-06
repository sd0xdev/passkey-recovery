// Request guards for the loopback sidecar (tech spec §4.1). DNS rebinding: exact Host. CSRF: exact
// Origin + per-process session token from the served page + JSON content-type. The signer channel
// (/signer/*) is for the user's Terminal CLI only: no Origin header allowed, one-time code required.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MAX_BODY_BYTES = 32 * 1024;
/** Only the two relay routes take a signed transaction (hex: 2 chars a byte) up to relay.ts MAX_RAW_TX_BYTES. */
export const MAX_RELAY_BODY_BYTES = 2 * 128 * 1024 + 4 * 1024;
export const RELAY_ROUTES: ReadonlySet<string> = new Set(['/api/deploy/send', '/api/transfer/relay']);

export class HttpError extends Error {
  override name = 'HttpError';
  readonly status: number;
  /** A stable machine-readable class the page translates (e.g. keystore-stale), sent as `kind`. */
  readonly kind: string | null;
  constructor(status: number, message: string, kind: string | null = null) {
    super(message);
    this.status = status;
    this.kind = kind;
  }
}

export interface GuardConfig {
  host: string; // "127.0.0.1:4173"
  sessionToken: string;
  /** Website pairing (server/pairing.ts); absent → same-origin only, exactly as before. */
  pairing?: { isAllowed(origin: string | undefined): origin is string; check(origin: string | undefined, token: unknown): boolean };
}

/** Who made an /api request: the page this sidecar served, or a paired website (exact origin). */
export type Caller = { kind: 'same-origin' } | { kind: 'paired'; origin: string };

export function checkHost(req: IncomingMessage, cfg: GuardConfig): void {
  if (req.headers.host !== cfg.host) throw new HttpError(421, 'unexpected Host');
}

export function checkApi(req: IncomingMessage, cfg: GuardConfig, o: { pairing?: 'none' | 'exchange' } = {}): Caller {
  checkHost(req, cfg);
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'application/json required');
  const origin = req.headers.origin;
  const sfs = req.headers['sec-fetch-site'];
  if (origin === `http://${cfg.host}`) {
    if (sfs !== undefined && sfs !== 'same-origin') throw new HttpError(403, 'cross-site request refused');
    if (req.headers['x-cbpr-session'] !== cfg.sessionToken) throw new HttpError(403, 'missing or stale session (reload the page)');
    return { kind: 'same-origin' };
  }
  // A website reaches the runner only from an exact allowlisted origin, and (except for the pairing
  // exchange itself) only with the token that pairing returned. A browser always sends Origin on a
  // cross-origin POST, so a missing Origin is refused too.
  if (!cfg.pairing || !cfg.pairing.isAllowed(origin)) throw new HttpError(403, 'cross-origin request refused');
  if (sfs !== undefined && sfs !== 'cross-site' && sfs !== 'same-site') throw new HttpError(403, 'unexpected fetch site');
  if (req.headers['x-cbpr-session'] !== undefined) throw new HttpError(403, 'a website never holds the local page session');
  if (o.pairing !== 'exchange' && !cfg.pairing.check(origin, req.headers['x-cbpr-pair'])) throw new HttpError(401, 'not paired, or the pairing ended (idle 30 min, runner restart): pair again');
  return { kind: 'paired', origin };
}

/**
 * CORS for a paired website: the exact origin is echoed (never "*"), credentials are never allowed (the
 * pairing token travels in a header), and only the two custom headers the UI sends are allowed.
 */
export function corsHeaders(origin: string): Record<string, string> {
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Expose-Headers': 'content-type' };
}

/** Answers an OPTIONS preflight. Only an allowlisted origin asking for POST with our headers gets a 204. */
export function preflight(req: IncomingMessage, res: ServerResponse, cfg: GuardConfig): void {
  checkHost(req, cfg);
  const origin = req.headers.origin;
  if (!cfg.pairing || !cfg.pairing.isAllowed(origin)) throw new HttpError(403, 'cross-origin request refused');
  if (req.headers['access-control-request-method'] !== 'POST') throw new HttpError(403, 'POST only');
  const asked = String(req.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((h) => h.trim()).filter(Boolean);
  if (asked.some((h) => !PAIRED_HEADERS.includes(h))) throw new HttpError(403, 'header not allowed');
  const h: Record<string, string> = { ...corsHeaders(origin), 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': PAIRED_HEADERS.join(', '), 'Access-Control-Max-Age': '60', 'cache-control': 'no-store' };
  // Chromium's Private/Local Network Access may ask explicitly; answered only for the allowlisted origin.
  if (req.headers['access-control-request-private-network'] === 'true') h['Access-Control-Allow-Private-Network'] = 'true';
  res.writeHead(204, h).end();
}
const PAIRED_HEADERS = ['content-type', 'x-cbpr-pair'];

export function checkSigner(req: IncomingMessage, cfg: GuardConfig): void {
  checkHost(req, cfg);
  if (req.method !== 'POST') throw new HttpError(405, 'POST only');
  if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers.referer !== undefined) throw new HttpError(403, 'signer channel is not reachable from a browser');
  if (req.headers['x-cbpr-signer'] !== '1') throw new HttpError(403, 'signer header missing');
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'application/json required');
}

export async function readJson(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  let v: unknown;
  try {
    v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new HttpError(400, 'expected a JSON object');
  return v as Record<string, unknown>;
}

/** The page CSP. `extraConnect` adds exact loopback origins (the runner's native signer), nothing else. */
export function contentSecurityPolicy(extraConnect: readonly string[] = []): string {
  for (const o of extraConnect) if (!/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(o)) throw new Error('extra connect-src must be an exact loopback origin');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    ["connect-src 'self' https://rpc.plasma.to", ...extraConnect].join(' '),
    "img-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * The hosted static website (HOST-01/02): same UI, no API of its own. It may reach only a loopback runner
 * the user paired (any port — the user picks it), plus the public RPC the local page also allows. Served
 * by Cloudflare static assets from `_headers`; style-src stays 'self', no inline script.
 */
export function hostedContentSecurityPolicy(): string {
  return contentSecurityPolicy().replace("connect-src 'self' https://rpc.plasma.to", "connect-src 'self' https://rpc.plasma.to http://127.0.0.1:*");
}

/** Cloudflare `_headers` for the hosted build: one rule for every path. */
export function hostedHeadersFile(): string {
  const h: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Security-Policy': hostedContentSecurityPolicy(), 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()', 'Strict-Transport-Security': 'max-age=31536000' };
  return `/*\n${Object.entries(h).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n`;
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': contentSecurityPolicy(),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** JSON with bigint → decimal string. */
export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { ...SECURITY_HEADERS, ...extra, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(text);
}
