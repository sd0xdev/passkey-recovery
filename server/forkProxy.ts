// Loopback-only, read-only JSON-RPC proxy that anvil forks through (tech spec §4.3). It exists so
// the upstream URL (which may embed an API key) never appears in anvil's argv or logs. It forwards
// only the state reads a fork needs; every other method — eth_call, eth_estimateGas, any send — gets
// a JSON-RPC error, so the proxy can never relay a signed UserOp or broadcast anything. Forwarding uses
// the same guarded upstream as every other read (server/net/guard.ts): anvil itself never connects to
// anything but this loopback proxy (ForkManager refuses any other --fork-url).
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { UPSTREAM_READ_METHODS, UpstreamError, WRITE_METHOD_RE, type Upstream } from './upstream';

export const FORK_READ_METHODS = new Set([
  'eth_chainId',
  'net_version',
  'web3_clientVersion',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getAccount',
  'eth_getAccountInfo',
  'eth_getProof',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
]);
/** anvil probes its upstream with anvil_nodeInfo; answered locally, never forwarded. */
const LOCAL_ANSWERS: Record<string, unknown> = {};

interface Req {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export function filterForkRequest(r: Req): { ok: true; clean: { jsonrpc: '2.0'; id: unknown; method: string; params: unknown[] } } | { ok: false; error: unknown } {
  const id = typeof r.id === 'number' || typeof r.id === 'string' ? r.id : null;
  const deny = (code: number, message: string) => ({ ok: false as const, error: { jsonrpc: '2.0', id, error: { code, message } } });
  if (typeof r.method !== 'string') return deny(-32600, 'invalid request');
  if (WRITE_METHOD_RE.test(r.method) || !FORK_READ_METHODS.has(r.method) || !UPSTREAM_READ_METHODS.has(r.method)) return deny(-32601, `method ${r.method} not available through the read-only fork proxy`);
  const params = r.params === undefined ? [] : r.params;
  if (!Array.isArray(params)) return deny(-32602, 'params must be an array');
  return { ok: true, clean: { jsonrpc: '2.0', id, method: r.method, params } };
}

export interface ForkProxy {
  url: string;
  close(): Promise<void>;
  stats: { forwarded: number; refused: number };
}

const MAX_BODY = 64 * 1024;

export async function startForkProxy(up: Upstream): Promise<ForkProxy> {
  const token = randomBytes(16).toString('hex');
  const stats = { forwarded: 0, refused: 0 };
  const server: Server = createServer((req, res) => {
    const fail = (status: number) => {
      res.writeHead(status).end();
    };
    if (req.method !== 'POST' || req.url !== `/${token}`) return fail(404);
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::ffff:127.0.0.1') return fail(403);
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      void (async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return fail(400);
        }
        const batch = Array.isArray(parsed);
        const list = (batch ? parsed : [parsed]) as Req[];
        if (list.length === 0 || list.length > 50) return fail(400);
        const out: unknown[] = new Array(list.length);
        const forward: { i: number; clean: object }[] = [];
        list.forEach((r, i) => {
          if (typeof r.method === 'string' && r.method in LOCAL_ANSWERS) {
            out[i] = { jsonrpc: '2.0', id: r.id ?? null, result: LOCAL_ANSWERS[r.method] };
            return;
          }
          const f = filterForkRequest(r);
          if (f.ok) forward.push({ i, clean: f.clean });
          else {
            stats.refused++;
            out[i] = f.error;
          }
        });
        if (forward.length > 0) {
          try {
            const text = await up.raw(JSON.stringify(forward.length === 1 && !batch ? forward[0]!.clean : forward.map((f) => f.clean)));
            const resp = JSON.parse(up.redact(text)) as unknown;
            const arr = Array.isArray(resp) ? resp : [resp];
            forward.forEach((f, k) => (out[f.i] = arr[k] ?? { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'missing response' } }));
            stats.forwarded += forward.length;
          } catch (e) {
            // Fixed messages only; -32005 lets anvil apply its own rate-limit back-off.
            const err = e instanceof UpstreamError && e.kind === 'rate-limited' ? { code: -32005, message: 'upstream rate limited' } : { code: -32603, message: 'upstream unavailable' };
            forward.forEach((f) => (out[f.i] = { jsonrpc: '2.0', id: (f.clean as { id: unknown }).id, error: err }));
          }
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(batch ? out : out[0]));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/${token}`,
    stats,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
