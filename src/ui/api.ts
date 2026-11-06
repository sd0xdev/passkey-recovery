// Browser client for the runner. Two connection targets, one UI:
//  - local: the page was served by the runner/sidecar on 127.0.0.1; the session token is in its meta
//    tag (never storage/URL) and every call is a same-origin JSON POST;
//  - hosted: the static website reaches an explicitly paired runner on 127.0.0.1 (HOST-05). The pairing
//    token lives in this module's memory only; a reload pairs again.
// Responses are untrusted display data — the runner re-derives everything that matters.
export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  /** 'no-sidecar' | 'offline' | 'http' | 'unpaired'. The UI maps these to translated text. */
  readonly kind: 'no-sidecar' | 'offline' | 'http' | 'unpaired';
  /** A machine-readable class from the runner (e.g. op-locked, file-wrong-password), if any. */
  readonly code: string | null;
  constructor(status: number, message: string, kind: ApiError['kind'] = 'http', code: string | null = null) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.code = code;
  }
}

export function sidecarSession(): string | null {
  return document.querySelector('meta[name="cbpr-session"]')?.getAttribute('content') ?? null;
}

export function sidecarMode(): string | null {
  return document.querySelector('meta[name="cbpr-mode"]')?.getAttribute('content') ?? null;
}

/** The runner this page talks to when it is the hosted website. */
interface Paired {
  base: string;
  token: string;
  mode: string;
  version: string;
}
let paired: Paired | null = null;
/**
 * Why the last pairing ended: the runner refused the session (restart, idle timeout), stopped answering
 * altogether (offline), or the user disconnected.
 */
let dropped: 'runner' | 'offline' | 'user' | null = null;
/**
 * Local page only: the runner that served it stopped answering ('offline'), or a runner answers but
 * refuses this page's session ('stale': it restarted, so only a reload gets the new session). Cleared by
 * the next accepted answer.
 */
let localLost: false | 'offline' | 'stale' = false;
const setLocalLost = (v: typeof localLost) => {
  if (v === localLost) return;
  localLost = v;
  changed();
};
export const lastDrop = () => dropped;
let signerBase: string | null = null;
const listeners = new Set<() => void>();

export const RUNNER_PROTOCOL = 1;
export const isHosted = () => sidecarSession() === null;

/**
 * Where this page is, from what it holds — never from its hostname (6-recovery-atlas.md §6.2): the runner served
 * it (session meta) → 'runner'; the website build on https → 'website' (it pairs with a runner); anything else
 * without a session — `vite preview`, `npm run preview:static`, the website build on http (`wrangler dev`) —
 * → 'static-preview', because a real runner pairs with https origins only.
 */
export type PageKind = 'runner' | 'website' | 'static-preview';
export function pageKind(session: string | null = sidecarSession(), buildMode: string = import.meta.env.MODE, origin: string = location.origin): PageKind {
  if (session !== null) return 'runner';
  return buildMode === 'hosted' && origin.startsWith('https://') ? 'website' : 'static-preview';
}

/** A paired runner of another release than this page (same protocol, so it works): worth saying, not refusing. */
export const versionDiffers = (runnerVersion: string, pageVersion: string): boolean => runnerVersion.trim() !== pageVersion;
export const pairedRunner = (): Readonly<Paired> | null => paired;
/** A sidecar answers this page: it came from the runner (local) or it is paired with one (hosted). */
export const hasConnection = (): boolean => (sidecarSession() !== null && !localLost) || paired !== null;
/** The page came from the runner, and that runner has stopped answering. */
export const runnerLost = (): false | 'offline' | 'stale' => (sidecarSession() !== null ? localLost : false);
export function onConnectionChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((f) => f());

/**
 * Only a loopback runner can be paired: never a LAN or public host. The path may be `/` or `/recover` — the
 * address the runner prints when it starts — and nothing else; only the origin is used.
 */
export function runnerBase(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || !['/', '/recover'].includes(u.pathname) || u.search || u.hash || u.username || u.password) throw new ApiError(0, 'the runner address must look like http://127.0.0.1:4171/recover', 'http');
  return u.origin;
}

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  try {
    return await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch {
    // On the hosted site this is also what a denied local-network-access prompt looks like.
    throw new ApiError(0, 'cannot reach the local runner (stopped, or the browser blocked local network access)', 'offline');
  }
}

/**
 * `by`: the connection the request used — 'local' (this page's runner session), the pairing it carried, or
 * null (hello/pair: none yet). A 401 invalidates only that connection: a late answer to an old pairing
 * never ends a newer one.
 */
async function json<T>(res: Response, by: Paired | 'local' | null = null): Promise<T> {
  const j = (await res.json().catch(() => ({ error: 'bad response' }))) as T & { error?: string; kind?: string };
  if (res.status === 401) {
    // Local: the runner no longer knows this page's session (it restarted) — the same state as the sidecar's 403.
    if (by === 'local') {
      setLocalLost('stale');
      throw new ApiError(401, j.error ?? 'stale session', 'http', j.kind ?? null);
    }
    if (by && paired === by) {
      paired = null;
      dropped = 'runner';
      changed();
    }
    throw new ApiError(401, j.error ?? 'not paired', 'unpaired', j.kind ?? null);
  }
  if (!res.ok) throw new ApiError(res.status, j.error ?? `HTTP ${res.status}`, 'http', j.kind ?? null);
  return j;
}

/** Version / capability check of a runner before pairing (HOST-06). */
export async function hello(base: string): Promise<{ protocol: number; version: string; mode: string; capabilities: Record<string, boolean> }> {
  return json(await post(`${base}/api/hello`, {}, {}));
}

/** Exchanges the code the runner printed for a session; refuses a runner speaking another protocol. */
export async function pair(base: string, code: string): Promise<void> {
  const r = await json<{ token: string; protocol: number; version: string; mode: string }>(await post(`${base}/api/pair`, {}, { code }));
  if (r.protocol !== RUNNER_PROTOCOL) throw new ApiError(0, `this runner speaks protocol ${r.protocol}; this page needs ${RUNNER_PROTOCOL} — update the runner or the page`, 'http');
  paired = { base, token: r.token, mode: r.mode, version: r.version };
  dropped = null;
  changed();
}

export function unpair(): void {
  // The runner keeps running after the page lets go of it: its signer is asked to lock first (on this pairing),
  // so no key stays unlocked there and a 1Password approval it still waits for is cancelled. Best effort.
  if (paired && signerBase) void signerApi('/gas/lock').catch(() => undefined);
  if (paired) dropped = 'user';
  paired = null;
  signerBase = null;
  changed();
}

export async function api<T = Record<string, unknown>>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  const token = sidecarSession();
  if (token) {
    const res = await post(path, { 'x-cbpr-session': token }, body).catch((e: unknown) => {
      // The runner that served this page is gone: say so everywhere (strip, Check), not only in this call.
      setLocalLost('offline');
      throw e;
    });
    // Same origin, so the only 403 is a session this runner never issued (it restarted).
    setLocalLost(res.status === 403 ? 'stale' : false);
    return json<T>(res, 'local');
  }
  if (!paired) throw new ApiError(0, 'this page is not connected to a local runner', 'no-sidecar');
  const at = paired;
  const res = await post(`${at.base}${path}`, { 'x-cbpr-pair': at.token }, body).catch((e: unknown) => {
    runnerGone(at);
    throw e;
  });
  return json<T>(res, at);
}

/**
 * The runner (its sidecar or its signer: one process tree) did not answer at all. Hosted: a stopped runner
 * cannot keep this session (a restart issues a new code), so the pairing ends and the page shows "not
 * connected" and how to connect again, instead of a "Connected" that no longer answers. Local: the page
 * marks its runner lost until the next accepted answer. `at`: the pairing the failed call used.
 */
function runnerGone(at: Paired | null): void {
  if (sidecarSession() !== null) return setLocalLost('offline');
  if (at && paired === at) {
    paired = null;
    signerBase = null;
    dropped = 'offline';
    changed();
  }
}

/**
 * Local page: asks the runner again (after the user restarted it). 'ok' when it answers this page;
 * 'restarted' when a runner answers but no longer knows this page's session (only a reload gets the new
 * one); 'offline' when nothing answers yet.
 */
export async function retryRunner(): Promise<'ok' | 'restarted' | 'offline'> {
  try {
    await api('/api/config');
    return 'ok';
  } catch (e) {
    if (localLost === 'stale') return 'restarted';
    return e instanceof ApiError && e.kind === 'offline' ? 'offline' : 'ok';
  }
}

/** The runner's native signer (secret-bearing calls go here, never through the sidecar). */
export function setSignerBase(url: string | null): void {
  const next = url && /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(url) ? url : null;
  if (next === signerBase) return;
  signerBase = next;
  // /api/config answers after the first render: the gas sheet must learn the native modes became available.
  changed();
}
export const hasNativeSigner = () => signerBase !== null;
/** The runner signer's exact loopback origin (where secret-bearing input goes), or null without a runner. */
export const signerOrigin = () => signerBase;

export async function signerApi<T = Record<string, unknown>>(path: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!signerBase) throw new ApiError(0, 'the native signer is not running (start the local runner)', 'no-sidecar');
  const token = sidecarSession();
  const at = token ? null : paired;
  const headers: Record<string, string> = token ? { 'x-cbpr-session': token } : at ? { 'x-cbpr-pair': at.token } : {};
  const res = await post(`${signerBase}${path}`, headers, body).catch((e: unknown) => {
    runnerGone(at);
    throw e;
  });
  // Local: an answer from the signer is an answer from the runner (one process tree). Its 403s have other
  // causes than a restart, so only "offline" is cleared here; "stale" waits for the sidecar's own answer.
  if (token && localLost === 'offline') setLocalLost(false);
  try {
    return await json<T>(res, token ? 'local' : at);
  } catch (e) {
    // A signer that does not know this endpoint is older than this page (it was started before an update):
    // say that, not the raw "unknown endpoint".
    if (e instanceof ApiError && e.status === 404 && e.code === null) throw new ApiError(404, e.message, 'http', 'runner-outdated');
    throw e;
  }
}
