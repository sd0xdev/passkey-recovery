// The one outbound JSON-RPC channel to Plasma (tech spec §4.2, open-source spec §3.3). The endpoint URL
// may carry an API key (a URL read from a 0600 file or typed into the UI), so it never appears in argv,
// logs, responses, errors or stacks: every failure is mapped to a fixed UpstreamError whose message is
// built here. Every request goes through server/net/guard.ts (resolved + checked + pinned address, no
// redirect, no proxy); there is no other transport. Callers must pass a method from an allowlist; this
// module refuses any write method outright. HTTP 429 / JSON-RPC -32005 back off 500 ms, 1 s, 2 s.
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { maskUrl, NetGuardError, pinnedPost, resolveTarget, type PostResult, type ResolveOptions, type RpcTarget } from './net/guard';

export type UpstreamErrorKind = 'timeout' | 'network' | 'http' | 'rpc-error' | 'bad-response' | 'not-allowed' | 'config' | 'rate-limited' | 'chain-mismatch' | 'inconsistent';

export class UpstreamError extends Error {
  override name = 'UpstreamError';
  readonly kind: UpstreamErrorKind;
  constructor(kind: UpstreamErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Never forwarded upstream by anything in this process, whatever the caller's allowlist says. */
export const WRITE_METHOD_RE = /^(eth_send|eth_sign|personal_|wallet_|eth_submit|debug_|trace_|admin_|miner_|txpool_|engine_|anvil_|hardhat_|evm_|alchemy_|eth_simulate|eth_callBundle|flashbots_|pm_|bundler_|rundler_|eth_estimateUserOperationGas)/i;

/** Positive allowlist for upstream.call (state reads only); the reader narrows params further. */
export const UPSTREAM_READ_METHODS = new Set([
  'eth_chainId', 'net_version', 'web3_clientVersion', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBalance', 'eth_getTransactionCount', 'eth_getCode', 'eth_getStorageAt',
  'eth_getAccount', 'eth_getAccountInfo', 'eth_getProof', 'eth_getTransactionByHash', 'eth_getTransactionReceipt', 'eth_call',
  // Tracking only: the reader admits EntryPoint UserOperationEvent by one userOpHash over a bounded range.
  'eth_getLogs',
  // Capability probe only: the reader allowlist admits exactly one fixed synthetic payload (no UserOp data).
  'eth_estimateGas',
]);

export interface UpstreamInfo {
  /** 'alchemy' | 'public-plasma' | 'testchain' | 'custom' — derived from the host, never the URL itself. */
  provider: string;
  source: 'file' | 'default' | 'testchain' | 'custom';
  /** scheme://host/… — never the path or query. */
  masked: string;
  /** True when the self-hosted (loopback / private network) exception is in effect. */
  localException: boolean;
}

export interface UpstreamStats {
  requests: number;
  rateLimited: number;
  lastRateLimitedAt: number | null;
}

export interface Upstream {
  /** Random per-instance id: changes whenever the endpoint changes (lets readers re-verify chain identity). */
  readonly id: string;
  info: UpstreamInfo;
  stats: UpstreamStats;
  call(method: string, params: unknown[]): Promise<unknown>;
  /** Raw passthrough for the fork proxy: body already validated by the caller. Returns response text. */
  raw(body: string): Promise<string>;
  /** Re-resolves and re-checks the host and pins the new address (explicit re-test only). */
  repin(): Promise<void>;
  /** Replace the URL's secret parts; safe on whole response bodies. */
  redact(text: string): string;
  /** redact() plus masking of long non-hex tokens; for error text only. */
  redactError(text: string): string;
}

export type Transport = (body: string) => Promise<PostResult>;

export interface UpstreamOptions {
  url: string;
  source: UpstreamInfo['source'];
  /** Production: how to resolve and check the host (resolved lazily on first use, then pinned). */
  resolve?: ResolveOptions;
  /** An already resolved target (UI-configured endpoints are resolved before they are accepted). */
  target?: RpcTarget;
  /** Tests only: replaces the guarded network transport. */
  transport?: Transport;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

export const RETRY_DELAYS_MS = [500, 1000, 2000] as const;

function fromGuard(e: unknown): UpstreamError {
  if (e instanceof UpstreamError) return e;
  if (e instanceof NetGuardError) {
    const kind: UpstreamErrorKind = e.code === 'timeout' ? 'timeout' : e.code === 'network' ? 'network' : e.code === 'redirect' ? 'http' : e.code === 'too-large' ? 'bad-response' : 'config';
    return new UpstreamError(kind, e.message);
  }
  return new UpstreamError('network', 'upstream RPC unreachable');
}

const isRateLimitedRpc = (err: { code?: unknown; message?: unknown } | undefined) => !!err && (err.code === -32005 || err.code === 429 || /rate.?limit|too many requests/i.test(String(err.message ?? '')));

/** Reads a single-line https URL from a file that only the owner can read. The URL is returned, never printed. */
export function readUrlFile(path: string): string {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new UpstreamError('config', 'RPC URL file is missing or unreadable');
  }
  if (!st.isFile()) throw new UpstreamError('config', 'RPC URL file is not a regular file');
  if ((st.mode & 0o077) !== 0) throw new UpstreamError('config', 'RPC URL file must not be group/world accessible (chmod 600)');
  const text = readFileSync(path, 'utf8').trim();
  if (text.includes('\n') || text.length > 512) throw new UpstreamError('config', 'RPC URL file must hold exactly one URL line');
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    throw new UpstreamError('config', 'RPC URL file does not contain a valid URL');
  }
  if (u.protocol !== 'https:') throw new UpstreamError('config', 'RPC URL must use https');
  if (u.username || u.password) throw new UpstreamError('config', 'RPC URL must not embed credentials in userinfo');
  return text;
}

export function providerOf(url: string, source: UpstreamInfo['source']): string {
  if (source === 'testchain') return 'testchain';
  const host = new URL(url).hostname.toLowerCase();
  if (host.endsWith('.alchemy.com') || host === 'alchemy.com') return 'alchemy';
  if (host === 'rpc.plasma.to') return 'public-plasma';
  return 'custom';
}

/** Resolves and checks the URL now (UI-configured endpoints), then builds the upstream on the pinned address. */
export async function openUpstream(url: string, source: UpstreamInfo['source'], resolve: ResolveOptions, extra: Partial<UpstreamOptions> = {}): Promise<Upstream> {
  const target = await resolveTarget(url, resolve);
  return createUpstream({ ...extra, url, source, resolve, target });
}

export function createUpstream(opts: UpstreamOptions): Upstream {
  const url = opts.url;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const delays = opts.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (!opts.transport && !opts.resolve && !opts.target) throw new UpstreamError('config', 'upstream needs a guarded target (internal error)');
  const u = new URL(url);
  const secrets = [url, u.host + u.pathname, u.pathname, u.search].filter((s) => s.length > 6);
  for (const seg of u.pathname.split('/')) if (seg.length >= 6) secrets.push(seg, decodeURIComponent(seg));
  for (const v of u.searchParams.values()) if (v.length >= 6) secrets.push(v, encodeURIComponent(v));
  secrets.sort((a, b) => b.length - a.length);
  // Known URL parts only: safe on whole JSON-RPC bodies (the fork proxy), never alters field names.
  const redact = (text: string): string => {
    let out = text;
    for (const s of secrets) out = out.split(s).join('[redacted]');
    return out;
  };
  // Error text shown to a person is untrusted too: also mask any long token-like run that is not 0x-hex,
  // so a key echoed back in another form does not survive.
  const redactError = (text: string): string => redact(text).replace(/(?<![0-9A-Za-z_-])(?!0x)[A-Za-z0-9_-]{16,}(?![0-9A-Za-z_-])/g, '[redacted]');
  let id = 0;
  const stats: UpstreamStats = { requests: 0, rateLimited: 0, lastRateLimitedAt: null };

  let target: RpcTarget | null = opts.target ?? null;
  const getTarget = async (): Promise<RpcTarget> => {
    if (!target) {
      try {
        target = await resolveTarget(url, opts.resolve!);
      } catch (e) {
        throw fromGuard(e);
      }
    }
    return target;
  };
  const send: Transport = opts.transport ?? (async (body) => pinnedPost(await getTarget(), body, { timeoutMs }));

  const noteRateLimit = () => {
    stats.rateLimited++;
    stats.lastRateLimitedAt = Date.now();
  };

  /** One POST with the 429 back-off. Returns the body text of a 2xx response. */
  async function post(body: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      stats.requests++;
      let r: PostResult;
      try {
        r = await send(body);
      } catch (e) {
        // The transport error text never includes the URL; still never forward foreign text.
        throw fromGuard(e);
      }
      if (r.status === 429) {
        noteRateLimit();
        if (attempt < delays.length) {
          await sleep(delays[attempt]!);
          continue;
        }
        throw new UpstreamError('rate-limited', `upstream RPC rate limited (HTTP 429, ${delays.length} retries); try again later or use your own RPC`);
      }
      if (r.status < 200 || r.status >= 300) throw new UpstreamError('http', `upstream RPC HTTP ${r.status}`);
      return r.body;
    }
  }

  const masked = maskUrl({ protocol: u.protocol === 'http:' ? 'http:' : 'https:', hostHeader: u.host }, opts.source === 'default' || opts.source === 'testchain');
  return {
    id: randomBytes(8).toString('hex'),
    info: { provider: providerOf(url, opts.source), source: opts.source, masked, localException: !!(opts.target?.allowLocal ?? opts.resolve?.allowLocal) && opts.source !== 'testchain' },
    stats,
    redact,
    redactError,
    raw: post,
    async repin() {
      if (opts.transport) return;
      try {
        target = await resolveTarget(url, opts.resolve ?? { allowLocal: target?.allowLocal ?? false });
      } catch (e) {
        throw fromGuard(e);
      }
    },
    async call(method, params) {
      if (WRITE_METHOD_RE.test(method) || !UPSTREAM_READ_METHODS.has(method)) throw new UpstreamError('not-allowed', `${method} is never sent upstream`);
      for (let attempt = 0; ; attempt++) {
        const myId = ++id;
        const text = await post(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }));
        let b: { id?: unknown; result?: unknown; error?: { message?: unknown; code?: unknown } };
        try {
          b = JSON.parse(text);
        } catch {
          throw new UpstreamError('bad-response', `${method}: response is not JSON`);
        }
        if (typeof b !== 'object' || b === null || b.id !== myId) throw new UpstreamError('bad-response', `${method}: mismatched JSON-RPC id`);
        if (b.error && isRateLimitedRpc(b.error)) {
          noteRateLimit();
          if (attempt < delays.length) {
            await sleep(delays[attempt]!);
            continue;
          }
          throw new UpstreamError('rate-limited', `${method}: upstream RPC rate limited (${delays.length} retries); try again later or use your own RPC`);
        }
        if (b.error) throw new UpstreamError('rpc-error', `${method}: ${redactError(String(b.error.message ?? 'error')).slice(0, 200)}`);
        return b.result;
      }
    },
  };
}
