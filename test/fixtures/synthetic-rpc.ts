// SYNTHETIC JSON-RPC endpoint behaviour for unit tests (no network). Answers every read the reader and
// the capability probe make, with knobs for the failure modes M1 must handle: wrong chainId, wrong
// genesis, a block hash that changes between reads, unsupported methods, rate limiting, and an
// endpoint that echoes its own URL secret back in errors / version strings.
import type { Hex } from 'viem';
import type { Transport } from '../../server/upstream';

export const SYN_GENESIS = ('0x' + '0a'.repeat(32)) as Hex;
export const SYN_HEAD = 1_000_000n;

export interface SynOptions {
  chainId?: number;
  genesis?: string;
  /** Hash for block `n` on read number `k` of that block (default: stable). */
  blockHash?: (n: bigint, k: number) => string;
  headTimestamp?: bigint;
  unsupported?: string[];
  /** Methods answered with this JSON-RPC error message. */
  errors?: Record<string, string>;
  /** First N requests get HTTP 429. */
  http429?: number;
  /** First N requests get JSON-RPC -32005. */
  rpc32005?: number;
  /** Text the endpoint echoes in web3_clientVersion and error messages. */
  echo?: string;
  overrideHonoured?: boolean;
  /** eth_getCode result per address (default: '0x6001' everywhere). */
  codeAt?: (address: string) => string;
}

const word = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');

export function syntheticRpc(o: SynOptions = {}) {
  const reads = new Map<string, number>();
  const log: Array<{ method: string; params: unknown[] }> = [];
  let n429 = o.http429 ?? 0;
  let n32005 = o.rpc32005 ?? 0;
  const hashFor = (n: bigint) => {
    const k = (reads.get(n.toString()) ?? 0) + 1;
    reads.set(n.toString(), k);
    if (n === 0n) return o.genesis ?? SYN_GENESIS;
    return o.blockHash ? o.blockHash(n, k) : word(n + 7n);
  };
  const answer = (method: string, params: unknown[]): { result?: unknown; error?: { code: number; message: string } } => {
    if (o.unsupported?.includes(method)) return { error: { code: -32601, message: `the method ${method} does not exist/is not available` } };
    if (o.errors?.[method]) return { error: { code: -32000, message: o.errors[method]! } };
    switch (method) {
      case 'eth_chainId':
        return { result: '0x' + (o.chainId ?? 9745).toString(16) };
      case 'web3_clientVersion':
        return { result: `synthetic/v1.0${o.echo ? ' ' + o.echo : ''}` };
      case 'eth_getBlockByNumber': {
        const tag = params[0] as string;
        const n = tag === 'latest' ? SYN_HEAD : BigInt(tag);
        return { result: { number: '0x' + n.toString(16), hash: hashFor(n), timestamp: '0x' + (o.headTimestamp ?? BigInt(Math.floor(Date.now() / 1000))).toString(16), baseFeePerGas: '0x7' } };
      }
      case 'eth_getCode':
        return { result: o.codeAt ? o.codeAt(String(params[0])) : '0x6001' };
      case 'eth_getBalance':
      case 'eth_getTransactionCount':
      case 'eth_maxPriorityFeePerGas':
        return { result: '0x0' };
      case 'eth_getStorageAt':
        return { result: word(0n) };
      case 'eth_estimateGas':
        return { result: '0x5208' };
      case 'eth_call':
        if (params.length === 3) return { result: o.overrideHonoured === false ? '0x' : word(1n) };
        return { result: word(0n) };
      default:
        return { error: { code: -32601, message: 'method not found' } };
    }
  };
  const transport: Transport = async (body) => {
    if (n429 > 0) {
      n429--;
      return { status: 429, retryAfter: '1', body: 'Too Many Requests' };
    }
    const req = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    log.push({ method: req.method, params: req.params });
    if (n32005 > 0) {
      n32005--;
      return { status: 200, retryAfter: null, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32005, message: 'rate limit exceeded' } }) };
    }
    const a = answer(req.method, req.params);
    if (a.error && o.echo) a.error.message += ` (${o.echo})`;
    return { status: 200, retryAfter: null, body: JSON.stringify({ jsonrpc: '2.0', id: req.id, ...a }) };
  };
  return { transport, log };
}
