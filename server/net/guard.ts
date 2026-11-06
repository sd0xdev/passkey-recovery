// Outbound connection guard for every JSON-RPC endpoint this process talks to (tech spec §3.3 SSRF).
// One path for all of them — the public default, a file-configured URL, a URL typed into the UI, the
// loopback testchain — and the fork proxy that anvil reads through, so no caller can reach the network
// around it. Rules: https only (plain http only under the explicit self-hosted exception and only to a
// local address); every address the name resolves to must pass; the connection is pinned to the address
// that was checked (custom lookup, TLS still verifies the hostname), so DNS is never asked again; no
// redirects; a fresh Agent per request so environment proxy settings cannot route around the check.
// Self-contained (node builtins only, erasable TypeScript) so a child process can load it directly.
// Error messages are fixed strings: they never contain the URL, its host or its path.
import { lookup as dnsLookup } from 'node:dns';
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export type NetGuardCode =
  | 'url-invalid'
  | 'scheme'
  | 'userinfo'
  | 'fragment'
  | 'too-long'
  | 'port'
  | 'dns'
  | 'forbidden-address'
  | 'local-needs-exception'
  | 'http-needs-local'
  | 'network'
  | 'timeout'
  | 'redirect'
  | 'too-large';

const MESSAGES: Record<NetGuardCode, string> = {
  'url-invalid': 'RPC URL is not a valid absolute URL',
  scheme: 'RPC URL must use https (http only for a self-hosted node on this machine or your LAN, with the exception confirmed)',
  userinfo: 'RPC URL must not embed a username or password',
  fragment: 'RPC URL must not contain a #fragment',
  'too-long': 'RPC URL is longer than 512 characters',
  port: 'RPC URL port is not allowed',
  dns: 'RPC host name did not resolve',
  'forbidden-address': 'RPC host resolves to an address that is never allowed (link-local/metadata, multicast, reserved, IPv4-mapped/translated IPv6)',
  'local-needs-exception': 'RPC host resolves to a loopback or private-network address; confirm the self-hosted node exception to use it',
  'http-needs-local': 'plain http is allowed only when every resolved address is local (self-hosted exception)',
  network: 'RPC endpoint unreachable',
  timeout: 'RPC endpoint timed out',
  redirect: 'RPC endpoint answered with a redirect; redirects are never followed',
  'too-large': 'RPC response exceeded the size limit',
};

export class NetGuardError extends Error {
  override name = 'NetGuardError';
  readonly code: NetGuardCode;
  constructor(code: NetGuardCode) {
    super(MESSAGES[code]);
    this.code = code;
  }
}

export type AddressScope = 'public' | 'local' | 'forbidden';

function v4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return (((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!) >>> 0;
}

function v6ToBigInt(ip: string): bigint {
  let s = ip.toLowerCase();
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4) → two hex groups.
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    const n = v4ToInt(m[2]!);
    s = `${m[1]}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.includes('::') ? (s.split('::') as [string, string]) : [s, undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...new Array<string>(8 - h.length - t.length).fill('0'), ...t];
  let v = 0n;
  for (const g of groups) v = (v << 16n) + BigInt(parseInt(g || '0', 16));
  return v;
}

const V4_RULES: Array<[string, number, AddressScope]> = [
  ['0.0.0.0', 8, 'forbidden'], // "this network"
  ['10.0.0.0', 8, 'local'],
  ['100.64.0.0', 10, 'local'], // CGNAT
  ['127.0.0.0', 8, 'local'], // loopback
  ['169.254.0.0', 16, 'forbidden'], // link-local, cloud metadata 169.254.169.254
  ['172.16.0.0', 12, 'local'],
  ['192.0.0.0', 24, 'forbidden'], // IETF protocol assignments
  ['192.0.2.0', 24, 'forbidden'], // documentation
  ['192.88.99.0', 24, 'forbidden'], // 6to4 relay anycast
  ['192.168.0.0', 16, 'local'],
  ['198.18.0.0', 15, 'forbidden'], // benchmarking
  ['198.51.100.0', 24, 'forbidden'],
  ['203.0.113.0', 24, 'forbidden'],
  ['224.0.0.0', 4, 'forbidden'], // multicast
  ['240.0.0.0', 4, 'forbidden'], // reserved + broadcast
];

const V6_RULES: Array<[string, number, AddressScope]> = [
  ['::', 128, 'forbidden'], // unspecified
  ['::1', 128, 'local'], // loopback
  ['::', 96, 'forbidden'], // IPv4-compatible (deprecated)
  ['::ffff:0:0', 96, 'forbidden'], // IPv4-mapped: refuse outright rather than re-classify
  ['64:ff9b::', 96, 'forbidden'], // NAT64
  ['64:ff9b:1::', 48, 'forbidden'], // local-use NAT64
  ['100::', 64, 'forbidden'], // discard
  ['2001::', 32, 'forbidden'], // Teredo
  ['2001:db8::', 32, 'forbidden'], // documentation
  ['2002::', 16, 'forbidden'], // 6to4
  ['fc00::', 7, 'local'], // unique local
  ['fe80::', 10, 'forbidden'], // link-local
  ['fec0::', 10, 'forbidden'], // site-local (deprecated)
  ['ff00::', 8, 'forbidden'], // multicast
];

/** Scope of one literal IP address. Anything not parseable as an IP is 'forbidden'. */
export function classifyAddress(ip: string): AddressScope {
  if (ip.includes('%')) return 'forbidden'; // zone ids are link-local by definition
  const fam = isIP(ip);
  if (fam === 4) {
    const n = v4ToInt(ip);
    for (const [base, len, scope] of V4_RULES) {
      const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
      if ((n & mask) >>> 0 === (v4ToInt(base) & mask) >>> 0) return scope;
    }
    return 'public';
  }
  if (fam === 6) {
    const n = v6ToBigInt(ip);
    // Most specific first: the /128 rules must win over ::/96.
    for (const [base, len, scope] of [...V6_RULES].sort((a, b) => b[1] - a[1])) {
      const shift = BigInt(128 - len);
      if (n >> shift === v6ToBigInt(base) >> shift) return scope;
    }
    return 'public';
  }
  return 'forbidden';
}

export interface LookupAddress {
  address: string;
  family: number;
}
export type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

export const systemLookup: LookupAll = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addrs) => (err ? reject(err) : resolve(addrs)));
  });

export interface RpcTarget {
  readonly protocol: 'https:' | 'http:';
  /** Hostname as typed (brackets stripped for IPv6 literals); used for TLS SNI/certificate and Host. */
  readonly hostname: string;
  readonly hostHeader: string;
  readonly port: number;
  readonly path: string;
  /** The one address the connection is pinned to; every resolved address passed the check. */
  readonly pinned: LookupAddress;
  /** 'local' when every resolved address is loopback/private (only possible with the exception). */
  readonly scope: 'public' | 'local';
  readonly allowLocal: boolean;
}

export interface ResolveOptions {
  /** The user-confirmed self-hosted node exception: loopback/private addresses become acceptable. */
  allowLocal: boolean;
  lookup?: LookupAll;
  /** Loopback ports that are never an RPC target (this sidecar, its fork proxy). */
  denyLoopbackPorts?: readonly number[];
}

export const MAX_URL_LENGTH = 512;

/** Parses, resolves and checks an RPC URL. Throws NetGuardError with a fixed message. */
export async function resolveTarget(raw: string, opts: ResolveOptions): Promise<RpcTarget> {
  if (typeof raw !== 'string' || raw.length === 0) throw new NetGuardError('url-invalid');
  if (raw.length > MAX_URL_LENGTH) throw new NetGuardError('too-long');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new NetGuardError('url-invalid');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new NetGuardError('scheme');
  if (u.username || u.password) throw new NetGuardError('userinfo');
  if (u.hash || raw.includes('#')) throw new NetGuardError('fragment');
  if (!u.hostname) throw new NetGuardError('url-invalid');
  const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new NetGuardError('port');
  const hostname = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
  let addrs: LookupAddress[];
  if (isIP(hostname)) addrs = [{ address: hostname, family: isIP(hostname) }];
  else {
    try {
      addrs = await (opts.lookup ?? systemLookup)(hostname);
    } catch {
      throw new NetGuardError('dns');
    }
    if (!Array.isArray(addrs) || addrs.length === 0) throw new NetGuardError('dns');
  }
  let allLocal = true;
  for (const a of addrs) {
    const scope = classifyAddress(a.address);
    if (scope === 'forbidden') throw new NetGuardError('forbidden-address');
    if (scope === 'local') {
      if (!opts.allowLocal) throw new NetGuardError('local-needs-exception');
      if (/^(127\.|::1$)/.test(a.address) && (opts.denyLoopbackPorts ?? []).includes(port)) throw new NetGuardError('port');
    } else allLocal = false;
  }
  if (u.protocol === 'http:' && !(opts.allowLocal && allLocal)) throw new NetGuardError(opts.allowLocal ? 'http-needs-local' : 'scheme');
  return {
    protocol: u.protocol,
    hostname,
    hostHeader: u.host,
    port,
    path: (u.pathname || '/') + u.search,
    pinned: { address: addrs[0]!.address, family: addrs[0]!.family === 6 ? 6 : 4 },
    scope: allLocal ? 'local' : 'public',
    allowLocal: opts.allowLocal,
  };
}

export interface PostResult {
  status: number;
  retryAfter: string | null;
  body: string;
}

export interface PostOptions {
  timeoutMs: number;
  maxBytes?: number;
}

/** POSTs a JSON body to the pinned address. Never resolves DNS, never follows redirects, never uses a proxy. */
export function pinnedPost(t: RpcTarget, body: string, opts: PostOptions): Promise<PostResult> {
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const pinnedLookup = (_host: string, o: { all?: boolean } | number | undefined, cb: (...a: unknown[]) => void) => {
    const all = typeof o === 'object' && o !== null && o.all === true;
    if (all) cb(null, [{ address: t.pinned.address, family: t.pinned.family }]);
    else cb(null, t.pinned.address, t.pinned.family);
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (e: NetGuardError | null, r?: PostResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e) reject(e);
      else resolve(r!);
    };
    const common = {
      method: 'POST',
      hostname: t.hostname,
      port: t.port,
      path: t.path,
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), host: t.hostHeader, accept: 'application/json' },
      lookup: pinnedLookup as never,
    };
    const onResponse = (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        return done(new NetGuardError('redirect'));
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) {
          res.destroy();
          done(new NetGuardError('too-large'));
        } else chunks.push(c);
      });
      res.on('end', () => {
        const ra = res.headers['retry-after'];
        done(null, { status, retryAfter: typeof ra === 'string' ? ra : null, body: Buffer.concat(chunks).toString('utf8') });
      });
      res.on('error', () => done(new NetGuardError('network')));
    };
    // A fresh Agent per request: the global agent may be configured from HTTP(S)_PROXY / NODE_USE_ENV_PROXY.
    const req =
      t.protocol === 'https:'
        ? httpsRequest({ ...common, agent: new HttpsAgent({ keepAlive: false }), servername: isIP(t.hostname) ? undefined : t.hostname }, onResponse)
        : httpRequest({ ...common, agent: new HttpAgent({ keepAlive: false }) }, onResponse);
    const timer = setTimeout(() => {
      req.destroy();
      done(new NetGuardError('timeout'));
    }, opts.timeoutMs);
    req.on('error', () => done(new NetGuardError('network')));
    req.end(body);
  });
}

/**
 * Display form of a URL: scheme + host only, never the path or query (which may carry an API key).
 * A DNS hostname can carry a key in any label, of any length (`<key>.rpc.example.org`, `rpc.<key>.example`),
 * so no label of it is shown: `https://•••/…`. The provider is named separately from a fixed list. IP
 * literals and the port stay (not secrets; a self-hosted node is recognised by them). `keepHost` is only for
 * endpoints whose URL is public (the built-in default and the local testchain).
 */
export function maskUrl(t: Pick<RpcTarget, 'protocol' | 'hostHeader'>, keepHost = false): string {
  if (keepHost) return `${t.protocol}//${t.hostHeader}/…`;
  const m = /^(\[[^\]]*\]|[^:]+)(:\d+)?$/.exec(t.hostHeader);
  const name = m?.[1] ?? '';
  const port = m?.[2] ?? '';
  const literal = name.startsWith('[') || isIP(name) !== 0;
  return `${t.protocol}//${literal ? name : '•••'}${port}/…`;
}
