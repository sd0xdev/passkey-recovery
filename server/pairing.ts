// Website ↔ local runner pairing (HOST-05, NX-03). The official website is a static page; it can reach the
// runner on 127.0.0.1 only after the user (1) started the runner themselves, (2) allowed the browser's
// local-network-access prompt, and (3) typed the pairing code the runner printed. Origins are an exact
// allowlist given to the runner (no wildcard, https only, no path); the localhost UI the runner serves is
// always its own origin and never needs pairing. A pairing yields a short-lived session token bound to
// that one origin; a runner restart, a new pairing of the same origin or the idle/absolute limit ends it.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Bumped when the runner ↔ UI contract changes; a UI refuses a runner with another protocol. */
export const RUNNER_PROTOCOL = 1;
export const PAIR_CODE_TTL_MS = 5 * 60 * 1000;
export const PAIR_MAX_FAILURES = 5;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_MAX_MS = 8 * 60 * 60 * 1000;
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export class PairingError extends Error {
  override name = 'PairingError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Accepts an https origin (scheme, host and optional port) only: no path, query, fragment, userinfo or wildcard. Loopback http is
 * accepted only when `allowLoopbackHttp` (tests and the user's own local mirror), never by default.
 */
export function parseAllowedOrigin(raw: string, o: { allowLoopbackHttp?: boolean } = {}): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new PairingError(400, `not an origin: ${JSON.stringify(raw.slice(0, 80))}`);
  }
  if (raw.includes('*')) throw new PairingError(400, 'wildcard origins are not allowed');
  if (u.username || u.password) throw new PairingError(400, 'an origin has no user info');
  // The serialized origin must be exactly what was typed: this rejects any path (even "/"), query,
  // fragment, default-port spelling or upper-case host, so the allowlist compares like the browser does.
  if (raw !== u.origin) throw new PairingError(400, `write the origin exactly as the browser sends it (e.g. ${u.origin}): no path, query or fragment`);
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol === 'http:' && !(o.allowLoopbackHttp && loopback)) throw new PairingError(400, 'only https origins can be paired');
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new PairingError(400, 'only https origins can be paired');
  return u.origin;
}

interface Session {
  hash: Buffer;
  origin: string;
  createdAt: number;
  lastUsed: number;
}

export interface PairingClock {
  now(): number;
}

export class Pairing {
  private code: { hash: Buffer; expiresAt: number; failures: number } | null = null;
  private readonly sessions = new Map<string, Session>();
  private onCode: (code: string, expiresAt: number) => void = () => undefined;

  constructor(
    readonly allowed: readonly string[],
    private readonly clock: PairingClock = { now: () => Date.now() },
  ) {}

  isAllowed(origin: string | undefined): origin is string {
    return typeof origin === 'string' && this.allowed.includes(origin);
  }

  /** Called with each new code (the runner prints it to the user's Terminal; it is never served). */
  onNewCode(fn: (code: string, expiresAt: number) => void): void {
    this.onCode = fn;
  }

  /** A fresh single-use code; the previous one stops working. Only an explicit user action calls this. */
  newCode(): { code: string; expiresAt: number } {
    const raw = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    const expiresAt = this.clock.now() + PAIR_CODE_TTL_MS;
    this.code = { hash: digest(raw), expiresAt, failures: 0 };
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    this.onCode(code, expiresAt);
    return { code, expiresAt };
  }

  /** Exchanges the typed code for a session bound to `origin`. Five wrong codes retire the code. */
  pair(origin: string | undefined, typed: unknown): { token: string; expiresAt: number } {
    if (!this.isAllowed(origin)) throw new PairingError(403, 'this website is not on the runner’s allowlist (start the runner with --allow-origin)');
    const now = this.clock.now();
    const c = this.code;
    if (!c || now > c.expiresAt) throw new PairingError(410, 'no pairing code is active: create one in the runner (it prints a new code)');
    const norm = typeof typed === 'string' ? typed.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    if (norm.length !== 8 || !timingSafeEqual(digest(norm), c.hash)) {
      c.failures += 1;
      if (c.failures >= PAIR_MAX_FAILURES) {
        this.code = null;
        throw new PairingError(429, 'too many wrong codes: this code is retired; create a new one in the runner');
      }
      throw new PairingError(403, 'wrong pairing code');
    }
    this.code = null;
    // One session per origin: pairing again ends the previous session of that website.
    for (const [k, s] of this.sessions) if (s.origin === origin) this.sessions.delete(k);
    const token = randomBytes(32).toString('base64url');
    const key = digest(token).toString('hex');
    this.sessions.set(key, { hash: digest(token), origin, createdAt: now, lastUsed: now });
    return { token, expiresAt: now + SESSION_IDLE_MS };
  }

  /** True when `token` is a live session of exactly `origin`; refreshes its idle timer. */
  check(origin: string | undefined, token: unknown): boolean {
    if (!this.isAllowed(origin) || typeof token !== 'string' || token.length < 20 || token.length > 100) return false;
    const key = digest(token).toString('hex');
    const s = this.sessions.get(key);
    const now = this.clock.now();
    if (!s) return false;
    if (now - s.lastUsed > SESSION_IDLE_MS || now - s.createdAt > SESSION_MAX_MS) {
      this.sessions.delete(key);
      return false;
    }
    if (s.origin !== origin) return false;
    s.lastUsed = now;
    return true;
  }

  /** Ends every paired session (the runner's `unpair`, or a shutdown). */
  revokeAll(): void {
    this.sessions.clear();
    this.code = null;
  }

  activeOrigins(): string[] {
    const now = this.clock.now();
    return [...new Set([...this.sessions.values()].filter((s) => now - s.lastUsed <= SESSION_IDLE_MS && now - s.createdAt <= SESSION_MAX_MS).map((s) => s.origin))];
  }
}

const digest = (s: string) => createHash('sha256').update(s).digest();
