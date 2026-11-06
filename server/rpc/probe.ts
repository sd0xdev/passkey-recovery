// RPC capability probe (open-source spec §3.3). Read-only and synthetic: chain identity, head
// freshness, snapshot consistency, gas estimation, eth_call state override, a real anvil fork through
// the read-only proxy, and historical state (archive). Broadcast is never probed — no test transaction
// is ever sent; broadcasting belongs to the user's own EIP-1193 wallet. Every detail string is fixed
// text or upstream text passed through redactError: never the URL.
import { keccak256, toHex, type Hex } from 'viem';
import { SUPPORTED } from '../../src/config/registry';
const ENTRY_POINT_V06 = SUPPORTED[0]!.entryPoint;
import { PROBE_ESTIMATE, PROBE_OVERRIDE_CODE, PROBE_TO, Reader } from '../reader';
import { UpstreamError, type Upstream } from '../upstream';

export type CapStatus = 'ok' | 'unsupported' | 'error' | 'skipped' | 'not-probed';
export interface Cap {
  status: CapStatus;
  /** English text (reports, logs of the AI report). */
  detail: string;
  /** Which fixed message this is, so the page can show it in the user's language; vars fill it. */
  code?: string;
  vars?: Record<string, string | number>;
}

export interface CapabilityReport {
  at: string;
  masked: string;
  provider: string;
  localException: boolean;
  chain: Cap & { chainId: number | null };
  head: { block: string; hash: Hex; timestamp: string; ageSec: number } | null;
  clientVersion: string | null;
  read: Cap;
  consistency: Cap;
  estimate: Cap;
  stateOverride: Cap;
  fork: Cap;
  archive: Cap;
  broadcast: Cap;
  rateLimited: number;
  /** read + chain + consistency + fork all ok: the endpoint can back an unsigned preview and a signed simulation. */
  simulationReady: boolean;
}

export type ForkCheck = (up: Upstream, block: bigint, expect: { blockHash: Hex; entryPointCodeHash: Hex }) => Promise<Cap>;

export const ARCHIVE_DEPTH = 10_000n;
export const STALE_HEAD_SEC = 300;

const errText = (up: Upstream, e: unknown) => (e instanceof UpstreamError ? up.redactError(e.message).slice(0, 160) : 'unexpected error');
/** Errors that mean "this node does not serve that", as opposed to a transient failure. */
const UNSUPPORTED = /method not found|not supported|does not exist|unsupported|not available|missing trie node|header not found|state.*(pruned|not available)|historical state|unknown block|-32601/i;
const capFromError = (up: Upstream, e: unknown): Cap => {
  if (e instanceof UpstreamError && (e.kind === 'rate-limited' || e.kind === 'timeout' || e.kind === 'network' || e.kind === 'http')) return { status: 'error', detail: errText(up, e), code: 'upstream', vars: { text: errText(up, e) } };
  const t = errText(up, e);
  return { status: UNSUPPORTED.test(t) ? 'unsupported' : 'error', detail: t, code: 'upstream', vars: { text: t } };
};

export interface ProbeOptions {
  expectedGenesis: Hex | null;
  forkCheck?: ForkCheck;
  now?: () => number;
}

export async function probeUpstream(up: Upstream, opts: ProbeOptions): Promise<CapabilityReport> {
  const now = opts.now ?? Date.now;
  const reader = new Reader(up, { expectedGenesis: opts.expectedGenesis });
  const skipped: Cap = { status: 'skipped', detail: 'not run: chain identity or basic reads failed', code: 'skippedBasic' };
  const rlBefore = up.stats.rateLimited;
  const report: CapabilityReport = {
    at: new Date(now()).toISOString(),
    masked: up.info.masked,
    provider: up.info.provider,
    localException: up.info.localException,
    chain: { status: 'error', detail: '', chainId: null },
    head: null,
    clientVersion: null,
    read: skipped,
    consistency: skipped,
    estimate: skipped,
    stateOverride: skipped,
    fork: skipped,
    archive: skipped,
    broadcast: { status: 'not-probed', detail: 'never probed: no test transaction is sent; broadcasting is done by your own wallet (EIP-1193) through its own RPC', code: 'broadcastNever' },
    rateLimited: 0,
    simulationReady: false,
  };
  const finish = () => {
    report.rateLimited = up.stats.rateLimited - rlBefore;
    report.simulationReady = report.chain.status === 'ok' && report.read.status === 'ok' && report.consistency.status === 'ok' && report.fork.status === 'ok';
    return report;
  };

  try {
    const id = await reader.verifyChain();
    report.chain = { status: 'ok', detail: `chainId ${id.chainId}, genesis ${id.genesisHash.slice(0, 10)}… matches`, code: 'chainOk', vars: { chainId: id.chainId, genesis: `${id.genesisHash.slice(0, 10)}…` }, chainId: id.chainId };
  } catch (e) {
    report.chain = { ...capFromError(up, e), status: e instanceof UpstreamError && e.kind === 'chain-mismatch' ? 'unsupported' : 'error', chainId: null };
    return finish();
  }
  try {
    const v = await up.call('web3_clientVersion', []);
    report.clientVersion = typeof v === 'string' ? up.redactError(v).replace(/[^\x20-\x7e]/g, '').slice(0, 64) : null;
  } catch {
    report.clientVersion = null;
  }

  let block: bigint;
  let blockHash: Hex;
  let epCodeHash: Hex;
  try {
    const blk = (await reader.rpc('eth_getBlockByNumber', ['latest', false])) as Record<string, string> | null;
    if (!blk || typeof blk.number !== 'string' || typeof blk.hash !== 'string') throw new UpstreamError('bad-response', 'block header missing');
    block = BigInt(blk.number);
    blockHash = blk.hash as Hex;
    const ts = BigInt(blk.timestamp ?? '0x0');
    const ageSec = Math.max(0, Math.round(now() / 1000 - Number(ts)));
    report.head = { block: block.toString(), hash: blockHash, timestamp: ts.toString(), ageSec };
    const code = (await reader.rpc('eth_getCode', [ENTRY_POINT_V06, toHex(block)])) as string;
    if (typeof code !== 'string' || !/^0x[0-9a-fA-F]*$/.test(code)) throw new UpstreamError('bad-response', 'eth_getCode result is not hex');
    epCodeHash = keccak256(code as Hex);
    report.read = { status: 'ok', detail: ageSec > STALE_HEAD_SEC ? `head ${block} is ${ageSec}s old: this node may be lagging` : `head ${block}, ${ageSec}s old`, code: ageSec > STALE_HEAD_SEC ? 'readStale' : 'readOk', vars: { block: String(block), age: ageSec } };
  } catch (e) {
    report.read = capFromError(up, e);
    return finish();
  }

  try {
    const again = (await reader.rpc('eth_getBlockByNumber', [toHex(block), false])) as Record<string, string> | null;
    const chainAgain = await reader.chainId();
    report.consistency =
      again?.hash === blockHash && chainAgain === report.chain.chainId
        ? { status: 'ok', detail: `block ${block} hash stable across reads`, code: 'consistencyOk', vars: { block: String(block) } }
        : { status: 'unsupported', detail: `block ${block} returned a different hash on a second read (inconsistent backends or reorg)`, code: 'consistencyBad', vars: { block: String(block) } };
  } catch (e) {
    report.consistency = capFromError(up, e);
  }

  try {
    const g = await reader.rpc('eth_estimateGas', [{ ...PROBE_ESTIMATE }]);
    report.estimate = typeof g === 'string' && /^0x[0-9a-f]+$/i.test(g) ? { status: 'ok', detail: `eth_estimateGas → ${BigInt(g)} gas for a synthetic transfer`, code: 'estimateOk', vars: { gas: BigInt(g).toString() } } : { status: 'error', detail: 'eth_estimateGas result is not hex', code: 'notHex', vars: { method: 'eth_estimateGas' } };
  } catch (e) {
    report.estimate = capFromError(up, e);
  }

  try {
    const r = await reader.rpc('eth_call', [{ to: PROBE_TO, data: '0x' }, toHex(block), { [PROBE_TO]: { code: PROBE_OVERRIDE_CODE } }]);
    report.stateOverride =
      typeof r === 'string' && /^0x0*1$/i.test(r) ? { status: 'ok', detail: 'eth_call honoured a code override on a synthetic address', code: 'overrideOk' } : { status: 'unsupported', detail: 'eth_call ignored the state override', code: 'overrideIgnored' };
  } catch (e) {
    report.stateOverride = capFromError(up, e);
  }

  try {
    const old = block > ARCHIVE_DEPTH ? block - ARCHIVE_DEPTH : 0n;
    const b = await reader.rpc('eth_getBalance', [ENTRY_POINT_V06, toHex(old)]);
    report.archive = typeof b === 'string' && /^0x[0-9a-f]+$/i.test(b) ? { status: 'ok', detail: `state at block ${old} (head − ${ARCHIVE_DEPTH}) readable`, code: 'archiveOk', vars: { block: String(old), depth: String(ARCHIVE_DEPTH) } } : { status: 'error', detail: 'balance result is not hex', code: 'notHex', vars: { method: 'eth_getBalance' } };
  } catch (e) {
    report.archive = capFromError(up, e);
  }

  if (!opts.forkCheck) report.fork = { status: 'skipped', detail: 'fork check not available in this process', code: 'forkUnavailable' };
  else if (report.consistency.status !== 'ok') report.fork = { status: 'skipped', detail: 'not run: snapshot consistency failed', code: 'skippedConsistency' };
  else {
    try {
      report.fork = await opts.forkCheck(up, block, { blockHash, entryPointCodeHash: epCodeHash });
    } catch (e) {
      report.fork = capFromError(up, e);
    }
  }
  return finish();
}
