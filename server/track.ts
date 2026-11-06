// Stateless tracking from a record the browser kept (M3): survives a page refresh and a sidecar restart,
// and carries no signature. A send counts as done only when a mined handleOps holds an op with exactly
// this userOpHash whose callData decodes to exactly the recorded intent, and the UserOperationEvent
// reports success; finality is the registry's confirmation depth on a block hash that is still canonical.
// Unknown is never failure: no hash, a dropped hash, or an incomplete event scan stay "unknown"/"pending"
// with the reason, and the scan resumes from its cursor (≤ 2000 blocks per chunk, ≤ 25 chunks per call).
import { decodeEventLog, decodeFunctionData, getAddress, toHex, type Address, type Hex } from 'viem';
import { assetOf } from '../src/config/registry';
import { addressDigest, addressShort, decodeTransferCall, formatUnits, parseAddress, type TransferIntent } from '../src/transfer/intent';
import { userOpHash } from '../src/userop/hash';
import { EP_ABI } from './abi';
import { HttpError } from './http';
import { MAX_LOG_RANGE, type Reader } from './reader';
import { transferLogs } from './sim';

export const MAX_CHUNKS = 25;

/**
 * How much one call may scan. Production always uses the defaults; a smaller budget is a test seam (a
 * caller in code, never the HTTP body) so a multi-chunk scan and its cursor can be exercised on a short
 * chain. Values are clamped: at least 1, at most the defaults.
 */
export interface ScanBudget {
  chunks?: number;
  range?: bigint;
}

/**
 * The one canonical tracking record (the shape `cbpr-track-v1` the browser stores and `parseTrackRecord`
 * reads), built from full addresses that never enter it: the sidecar's plan and the Terminal signer both
 * build theirs here, so the two cannot drift apart.
 */
export function buildTrackRecord(x: { chainId: number; deploymentId: string; userOpHash: Hex; source: Address; recipient: Address; asset: TransferIntent['asset']; amount: bigint; nonce: bigint; gasWallet: Address; gasWalletNonce: bigint | null; inputHash: Hex | null; txHash: Hex | null; fromBlock: bigint }) {
  return {
    format: 'cbpr-track-v1' as const,
    chainId: x.chainId,
    deploymentId: x.deploymentId,
    entryPoint: null as Address | null,
    userOpHash: x.userOpHash,
    senderHash: addressDigest(x.source),
    senderShort: addressShort(x.source),
    nonce: x.nonce.toString(),
    intent: { chainId: x.chainId, deploymentId: x.deploymentId, recipientHash: addressDigest(x.recipient), recipientShort: addressShort(x.recipient), asset: x.asset, amount: x.amount.toString() },
    gasWalletHash: addressDigest(x.gasWallet),
    gasWalletNonce: x.gasWalletNonce?.toString() ?? null,
    inputHash: x.inputHash,
    txHash: x.txHash,
    fromBlock: x.fromBlock.toString(),
  };
}

/**
 * What the browser keeps (architecture §6.3): addresses only as digests. The full sender, recipient and
 * gas wallet come from verified chain data (the mined op, its event) or from a hint the page sends for
 * this one request — the account it is checking, the wallet it is connected to — accepted only when it
 * matches the recorded digest.
 */
export interface TrackRecord {
  userOpHash: Hex;
  senderHash: Hex;
  nonce: bigint;
  intent: { recipientHash: Hex; asset: TransferIntent['asset']; amount: bigint };
  gasWalletHash: Hex;
  gasWalletNonce: bigint | null;
  inputHash: Hex | null;
  txHash: Hex | null;
  fromBlock: bigint;
}

export interface TrackHints {
  sender: Address | null;
  gasWallet: Address | null;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function parseTrackRecord(reader: Reader, b: Record<string, unknown>): TrackRecord {
  const r = (b.record ?? b) as Record<string, unknown>;
  const bad = (m: string): never => {
    throw new HttpError(400, `tracking record: ${m}`);
  };
  if (r.format !== 'cbpr-track-v1') bad('format must be cbpr-track-v1');
  if (r.chainId !== reader.dep.chainId || r.deploymentId !== reader.dep.id) bad('record is for another chain or deployment');
  const hash = (v: unknown, m: string) => (typeof v === 'string' && HASH.test(v) ? (v.toLowerCase() as Hex) : bad(m));
  const i = r.intent as Record<string, unknown> | undefined;
  if (!i || typeof i !== 'object') bad('intent');
  const asset = assetOf(reader.dep, String(i!.asset));
  if (!asset) bad('asset');
  if (typeof i!.amount !== 'string' || !/^[1-9][0-9]{0,77}$/.test(i!.amount)) bad('intent: amount');
  const big = (v: unknown, m: string) => (typeof v === 'string' && /^(0|[1-9][0-9]{0,30})$/.test(v) ? BigInt(v) : bad(m));
  const optHash = (v: unknown, m: string) => (v === null || v === undefined ? null : hash(v, m));
  return {
    userOpHash: hash(r.userOpHash, 'userOpHash'),
    senderHash: hash(r.senderHash, 'senderHash'),
    nonce: big(r.nonce, 'nonce'),
    intent: { recipientHash: hash(i!.recipientHash, 'intent: recipientHash'), asset: asset!.id, amount: BigInt(i!.amount as string) },
    gasWalletHash: hash(r.gasWalletHash, 'gasWalletHash'),
    gasWalletNonce: r.gasWalletNonce === null || r.gasWalletNonce === undefined ? null : big(r.gasWalletNonce, 'gasWalletNonce'),
    inputHash: optHash(r.inputHash, 'inputHash'),
    txHash: optHash(r.txHash, 'txHash'),
    fromBlock: big(r.fromBlock, 'fromBlock'),
  };
}

/** Optional full addresses for this request; refused when they do not match the record's digests. */
export function parseTrackHints(rec: TrackRecord, b: Record<string, unknown>): TrackHints {
  const one = (v: unknown, digest: Hex, name: string): Address | null => {
    if (v === undefined || v === null) return null;
    let a: Address;
    try {
      a = parseAddress(v, name);
    } catch (e) {
      throw new HttpError(400, `tracking hint: ${(e as Error).message}`);
    }
    if (addressDigest(a) !== digest) throw new HttpError(400, `tracking hint: ${name} is not the address this record was made for`);
    return a;
  };
  return { sender: one(b.sender, rec.senderHash, 'sender'), gasWallet: one(b.gasWallet, rec.gasWalletHash, 'gasWallet') };
}

export type TrackState = 'pending' | 'unknown' | 'mismatch' | 'reverted' | 'inner-failed' | 'confirmed' | 'final' | 'reorged';

export interface TrackResult {
  state: TrackState;
  detail: string;
  txHash: Hex | null;
  block: bigint | null;
  confirmations: bigint | null;
  finalityDepth: number;
  scan: { cursor: bigint; head: bigint; complete: boolean } | null;
  /**
   * `bundler` is the outer transaction's `from` (it paid the network fee); `beneficiary` the address handleOps
   * pays the UserOp's gas cost to (decoded from the call). Two roles that are often, not always, one address.
   */
  receipt: { gasUsed: bigint; effectiveGasPrice: bigint | null; outerFeeWei: bigint | null; actualGasCost: bigint; actualGasUsed: bigint; amount: string; symbol: string; sender: Address; recipient: Address; bundler: Address | null; beneficiary: Address | null } | null;
  /** The account's EntryPoint nonce now; null when the tracker does not know the account's full address. */
  nonceNow: bigint | null;
  /**
   * The nonce at the finality depth below the head (null when unknown, or the chain is shorter than the
   * depth). A nonce used only in shallow blocks can still be reorged back, making the signed op runnable.
   */
  nonceFinal: bigint | null;
}

type Log = { address: string; topics: Hex[]; data: Hex };

/** Verifies one mined tx against the record; null when this tx does not carry the op at all. */
async function verifyTx(reader: Reader, rec: TrackRecord, txHash: Hex, head: bigint, seen: { sender?: Address } = {}): Promise<Omit<TrackResult, 'scan' | 'nonceNow' | 'nonceFinal' | 'finalityDepth'> | null> {
  const dep = reader.dep;
  const tx = await reader.tx(txHash);
  if (!tx) return null;
  if (typeof tx.to !== 'string' || getAddress(tx.to) !== getAddress(dep.entryPoint) || typeof tx.input !== 'string') return { state: 'mismatch', detail: 'the transaction is not an EntryPoint call', txHash, block: null, confirmations: null, receipt: null };
  let ops;
  let beneficiary: Address | null = null;
  try {
    const d = decodeFunctionData({ abi: EP_ABI, data: tx.input as Hex });
    if (d.functionName !== 'handleOps') throw new Error('x');
    ops = d.args[0];
    beneficiary = getAddress(d.args[1]);
  } catch {
    return { state: 'mismatch', detail: 'the transaction is not handleOps', txHash, block: null, confirmations: null, receipt: null };
  }
  const op = ops.find((o) => userOpHash({ ...o }, dep.entryPoint, dep.chainId).toLowerCase() === rec.userOpHash);
  if (!op) return { state: 'mismatch', detail: 'the transaction does not carry this UserOp', txHash, block: null, confirmations: null, receipt: null };
  let decoded: TransferIntent;
  try {
    decoded = decodeTransferCall(dep, getAddress(op.sender), op.callData);
  } catch (e) {
    return { state: 'mismatch', detail: `the UserOp call is not the recorded transfer (${(e as Error).message})`, txHash, block: null, confirmations: null, receipt: null };
  }
  const sender = getAddress(op.sender);
  if (addressDigest(sender) === rec.senderHash) seen.sender = sender;
  const same = addressDigest(sender) === rec.senderHash && decoded.asset === rec.intent.asset && decoded.amount === rec.intent.amount && addressDigest(decoded.recipient) === rec.intent.recipientHash;
  if (!same || op.nonce !== rec.nonce) return { state: 'mismatch', detail: 'the UserOp differs from the recorded intent or nonce', txHash, block: null, confirmations: null, receipt: null };
  const r = await reader.receipt(txHash);
  if (!r) return { state: 'pending', detail: 'known to the RPC, not mined yet', txHash, block: null, confirmations: null, receipt: null };
  const block = BigInt(r.blockNumber as string);
  const canonical = await reader.blockHash(block);
  if (!canonical || canonical !== String(r.blockHash).toLowerCase()) return { state: 'reorged', detail: `block ${block} was replaced (reorg): the transaction may be re-included; keep tracking`, txHash, block, confirmations: null, receipt: null };
  const confirmations = head - block + 1n;
  if (r.status !== '0x1') return { state: 'reverted', detail: 'the outer transaction reverted (its fee was spent; the transfer did not happen)', txHash, block, confirmations, receipt: null };
  const logs = (r.logs as Log[]) ?? [];
  // EntryPoint events in receipt order, with their position among all logs.
  const epEvents = logs.flatMap((l, i) => {
    if (getAddress(l.address) !== getAddress(dep.entryPoint)) return [];
    try {
      return [{ i, e: decodeEventLog({ abi: EP_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data }) }];
    } catch {
      return [];
    }
  });
  const own = epEvents.find((x) => x.e.eventName === 'UserOperationEvent' && (x.e.args as { userOpHash: Hex }).userOpHash.toLowerCase() === rec.userOpHash);
  const ev = own?.e;
  if (!ev || !own) return { state: 'inner-failed', detail: 'no UserOperationEvent for this UserOp in the receipt', txHash, block, confirmations, receipt: null };
  const a = ev.args as { success: boolean; sender: Address; actualGasCost: bigint; actualGasUsed: bigint };
  if (!a.success || getAddress(a.sender) !== sender) return { state: 'inner-failed', detail: 'UserOperationEvent.success is false: the inner transfer reverted (the prefund was still charged)', txHash, block, confirmations, receipt: null };
  if (rec.intent.asset !== 'native') {
    // Only this op's own execution: after the previous op's UserOperationEvent (or BeforeExecution, for the
    // first op) and before its own. Another op of the same wallet in the same bundle is not this one.
    const start = epEvents.filter((x) => x.i < own.i && (x.e.eventName === 'UserOperationEvent' || x.e.eventName === 'BeforeExecution')).at(-1)?.i ?? -1;
    const t = transferLogs(logs.slice(start + 1, own.i), rec.intent.asset).filter((x) => getAddress(x.from) === sender);
    if (t.length !== 1 || getAddress(t[0]!.to) !== decoded.recipient || t[0]!.value !== rec.intent.amount) return { state: 'inner-failed', detail: 'the token Transfer log is not exactly source → recipient for the amount', txHash, block, confirmations, receipt: null };
  }
  const asset = assetOf(dep, rec.intent.asset)!;
  const gasUsed = BigInt(r.gasUsed as string);
  const egp = typeof r.effectiveGasPrice === 'string' ? BigInt(r.effectiveGasPrice) : null;
  const final = confirmations >= BigInt(dep.finalityDepth);
  return {
    state: final ? 'final' : 'confirmed',
    detail: final ? `${confirmations} confirmations (tool finality depth ${dep.finalityDepth})` : `${confirmations} confirmation(s); final at ${dep.finalityDepth}`,
    txHash,
    block,
    confirmations,
    receipt: { gasUsed, effectiveGasPrice: egp, outerFeeWei: egp === null ? null : gasUsed * egp, actualGasCost: a.actualGasCost, actualGasUsed: a.actualGasUsed, amount: formatUnits(rec.intent.amount, asset.decimals), symbol: asset.symbol, sender, recipient: decoded.recipient, bundler: typeof tx.from === 'string' ? getAddress(tx.from) : null, beneficiary },
  };
}

/**
 * A reported transaction whose result does not end the search: the same signed op may still run
 * elsewhere. A pending one too — another transaction may already have executed the op, and its result is
 * kept only when the bounded scan finds no verified execution.
 */
const KEEP_LOOKING = new Set<TrackState>(['reverted', 'mismatch', 'pending']);

/**
 * Reorg margin. After a reorg seen mid-check, the scan restarts this many blocks before where the check
 * began; and the search never starts later than this many blocks below the head recorded at send time —
 * a short reorg can put the op into a replacement block under that height.
 */
const REORG_RESCAN = 64n;

export async function track(reader: Reader, body: Record<string, unknown>, budget: ScanBudget = {}): Promise<TrackResult> {
  const maxChunks = Math.max(1, Math.min(MAX_CHUNKS, Math.floor(budget.chunks ?? MAX_CHUNKS)));
  const range = budget.range !== undefined && budget.range >= 1n && budget.range < MAX_LOG_RANGE ? budget.range : MAX_LOG_RANGE;
  const rec = parseTrackRecord(reader, body);
  const hints = parseTrackHints(rec, body);
  const dep = reader.dep;
  // Every conclusion below (events, receipts, nonces) is about this deployment's chain: an endpoint that
  // now answers for another chain (a custom node restarted on another network at the same URL) must not
  // settle anything — it throws, so the record stays unresolved and cannot be removed (the UI keeps polling).
  await reader.verifyChain();
  const h = await reader.head();
  const head = h.number;
  const tag = toHex(head);
  const depth = BigInt(dep.finalityDepth);
  const deepTag = head >= depth ? toHex(head - depth) : null;
  // Unreadable (an empty answer) → null, never 0n, at the head and at depth alike: no gate opens and nothing
  // is settled on a nonce that could not be read.
  const nonceOf = async (a: Address | null) => (a ? await reader.uintCall({ kind: 'epNonce', account: a }, tag) : null);
  const nonceDeep = async (a: Address | null) => (a && deepTag ? await reader.uintCall({ kind: 'epNonce', account: a }, deepTag) : null);
  const nonces = async (a: Address | null) => ({ nonceNow: await nonceOf(a), nonceFinal: await nonceDeep(a) });
  const base = (n: { nonceNow: bigint | null; nonceFinal: bigint | null }) => ({ finalityDepth: dep.finalityDepth, ...n });
  // The reported hash first. A revert of that outer transaction (or a hash that does not carry this op)
  // is not the end: another transaction — a duplicate handleOps, any bundler — may have executed the
  // same signed op, so the event scan below still runs before that result is returned.
  // The account's full address, from a verified op if one is seen, else the page's hint.
  const seen: { sender?: Address } = {};
  let reported: Awaited<ReturnType<typeof verifyTx>> = null;
  if (rec.txHash) {
    reported = await verifyTx(reader, rec, rec.txHash, head, seen);
    if (reported && !KEEP_LOOKING.has(reported.state)) return { ...reported, scan: null, ...base(await nonces(seen.sender ?? hints.sender)) };
  }
  const floor = rec.fromBlock > REORG_RESCAN ? rec.fromBlock - REORG_RESCAN : 0n;
  const cursorIn = typeof body.scanCursor === 'string' && /^(0|[1-9][0-9]{0,30})$/.test(body.scanCursor) ? BigInt(body.scanCursor) : floor;
  let cursor = cursorIn < floor ? floor : cursorIn;
  for (let i = 0; i < maxChunks && cursor <= head; i++) {
    const to = cursor + range - 1n > head ? head : cursor + range - 1n;
    let logs: Awaited<ReturnType<Reader['userOpEvents']>>;
    try {
      logs = await reader.userOpEvents(rec.userOpHash, cursor, to);
    } catch {
      // The RPC refused the event search (no eth_getLogs, or not over this range). Never an error the page
      // cannot act on: the outcome stays unknown, the transaction hash from the wallet can still be pasted,
      // and the search resumes from here on the next poll. The RPC's own message is not repeated (it may
      // name the endpoint).
      const why = reported ? `the transaction your wallet reported is ${reported.state} (${reported.detail}); ` : '';
      return { state: 'unknown', detail: `${why}the RPC refused the event search from block ${cursor}: if your wallet shows a transaction hash for this transfer, paste it; the search is retried`, txHash: rec.txHash, block: null, confirmations: null, receipt: null, scan: null, ...base(await nonces(seen.sender ?? hints.sender)) };
    }
    for (const l of logs) {
      if (rec.txHash && l.transactionHash.toLowerCase() === rec.txHash && reported) continue;
      const v = await verifyTx(reader, rec, l.transactionHash, head, seen);
      if (v && !KEEP_LOOKING.has(v.state))
        return { ...v, detail: `${v.detail} (found by event scan${rec.txHash && l.transactionHash.toLowerCase() !== rec.txHash ? '; carried by a different transaction than the one your wallet reported' : ''})`, scan: { cursor: to + 1n, head, complete: true }, ...base(await nonces(seen.sender ?? hints.sender)) };
    }
    cursor = to + 1n;
  }
  const ns = await nonces(seen.sender ?? hints.sender);
  const nonceNow = ns.nonceNow;
  // The scan and the nonce read must describe one chain. If the head block was replaced meanwhile, a
  // nonce read on the new branch could pair with a scan of the old one ("no event, nonce used" while the
  // new branch executed this op): conclude nothing, and scan the recent blocks again.
  const still = await reader.blockHash(head);
  if (!still || still !== h.hash.toLowerCase()) {
    const back = cursorIn - REORG_RESCAN > floor ? cursorIn - REORG_RESCAN : floor;
    return { state: 'unknown', detail: `block ${head} was replaced while this was checked (reorg): scanning again`, txHash: rec.txHash, block: null, confirmations: null, receipt: null, scan: { cursor: back, head, complete: false }, ...base(ns) };
  }
  const complete = cursor > head;
  const scan = { cursor, head, complete };
  if (reported) {
    // A revert (or a hash not carrying this op) of the reported transaction is about that transaction only:
    // until the search for the same op elsewhere is complete, the transfer itself is not known to have failed.
    if (!complete && reported.state !== 'pending')
      return { state: 'unknown', detail: `the transaction your wallet reported is ${reported.state} (${reported.detail}); the same signed op may still have run in another transaction — the event scan is not complete yet (continue scanning)`, txHash: rec.txHash, block: null, confirmations: null, receipt: null, scan, ...base(ns) };
    return { ...reported, scan, ...base(ns) };
  }
  const noAccount = !(seen.sender ?? hints.sender) ? ' Check this wallet in step 1 so the tracker can also compare its nonce.' : nonceNow === null ? ' The account nonce could not be read; it is compared again on the next check.' : '';
  if (nonceNow !== null && nonceNow > rec.nonce) {
    return { state: 'unknown', detail: complete ? `the account's nonce moved past ${rec.nonce} but no event for this UserOp was found since block ${floor}: another operation used the nonce — this transfer did not execute with it` : `the nonce moved past ${rec.nonce}; the event scan is not complete yet (continue scanning)`, txHash: rec.txHash, block: null, confirmations: null, receipt: null, scan, ...base(ns) };
  }
  if (rec.txHash) {
    let replaced = '';
    if (rec.gasWalletNonce !== null && hints.gasWallet && (await reader.txCount(hints.gasWallet, tag)) > rec.gasWalletNonce) replaced = ' Your gas wallet has since used that transaction nonce: the reported transaction was likely replaced or cancelled.';
    return { state: 'pending', detail: `the RPC does not know the reported hash (not propagated, dropped or replaced) and the UserOp was not found in the scanned range.${replaced} The signed op stays valid until its nonce is used.${noAccount}`, txHash: rec.txHash, block: null, confirmations: null, receipt: null, scan, ...base(ns) };
  }
  return { state: 'unknown', detail: complete ? `no transaction hash, and no event for this UserOp so far: it may not have been broadcast. It stays executable until its nonce is used.${noAccount}` : 'no transaction hash; event scan not complete yet (continue scanning)', txHash: null, block: null, confirmations: null, receipt: null, scan, ...base(ns) };
}
