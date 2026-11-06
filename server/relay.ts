// Validated relay of a transaction the user's own gas key signed outside a browser wallet (File mode in
// the browser, or the native signer of the local runner). The sidecar still holds no key: it receives
// signed bytes, checks they are exactly the transaction it issued (decoded fields and the recovered
// signer), and only then forwards them to the active RPC. Anything else is refused before any network
// call. The node's answer is classified so a send is never assumed "not sent" when it may have been.
import { getAddress, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { classifyRejection } from './broadcastReason';
import type { SignRefusal } from '../src/config/signerApi';
import { HttpError } from './http';
import { UpstreamError, type Upstream } from './upstream';

/**
 * geth's txpool limit (txMaxSize, 4 × 32 KiB). A deploy step that creates a registry contract carries its
 * initcode (≤ 49,152 bytes under EIP-3860), so a transaction cap below that would refuse a legitimate step.
 */
export const MAX_RAW_TX_BYTES = 128 * 1024;

export interface ExpectedTx {
  chainId: number;
  from: Address;
  to: Address;
  inputHash: Hex;
  nonce: bigint;
  /** Exact gas limit, or an upper bound when `gasAtMost` is set. */
  gas: bigint;
  gasAtMost?: boolean;
  /** The highest max fee per gas the user confirmed. */
  maxFeePerGas: bigint;
}

/** An issued transaction handed to the native signer (fields exact; it signs nothing else). */
export interface IssuedTx {
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}
/** A refusal carries a stable `code` (src/config/signerApi.ts SIGN_REFUSALS); the reason is the English text. */
export type NativeSign = (tx: IssuedTx) => Promise<{ ok: true; raw: Hex } | { ok: false; reason: string; code?: SignRefusal }>;

export type RelayOutcome = { outcome: 'hash'; txHash: Hex } | { outcome: 'rejected'; reason: string } | { outcome: 'no-hash'; reason: string };

/** Decodes and checks a signed EIP-1559 transaction against what was issued. Throws HttpError(422) on any difference. */
export async function checkSignedTx(raw: unknown, want: ExpectedTx): Promise<Hex> {
  if (typeof raw !== 'string' || !/^0x02[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) throw new HttpError(400, 'signed transaction must be 0x-prefixed EIP-1559 (type 2) hex');
  if ((raw.length - 2) / 2 > MAX_RAW_TX_BYTES) throw new HttpError(413, 'signed transaction too large');
  const hex = raw.toLowerCase() as Hex;
  let tx: ReturnType<typeof parseTransaction>;
  let from: Address;
  try {
    tx = parseTransaction(hex);
    from = await recoverTransactionAddress({ serializedTransaction: hex as `0x02${string}` });
  } catch {
    throw new HttpError(422, 'signed transaction could not be decoded or its signer recovered');
  }
  const diffs: string[] = [];
  if (tx.type !== 'eip1559') diffs.push('type');
  if (tx.chainId !== want.chainId) diffs.push('chainId');
  if (getAddress(from) !== getAddress(want.from)) diffs.push('signer (not the confirmed gas wallet)');
  if (!tx.to || getAddress(tx.to) !== getAddress(want.to)) diffs.push('to');
  if ((tx.value ?? 0n) !== 0n) diffs.push('value');
  if (keccak256((tx.data ?? '0x') as Hex) !== want.inputHash) diffs.push('input');
  if (BigInt(tx.nonce ?? -1) !== want.nonce) diffs.push('nonce');
  if (tx.gas === undefined || (want.gasAtMost ? tx.gas > want.gas || tx.gas <= 0n : tx.gas !== want.gas)) diffs.push('gas');
  if (tx.maxFeePerGas === undefined || tx.maxFeePerGas > want.maxFeePerGas) diffs.push('maxFeePerGas');
  if (tx.maxPriorityFeePerGas === undefined || tx.maxPriorityFeePerGas > (tx.maxFeePerGas ?? 0n)) diffs.push('maxPriorityFeePerGas');
  if (tx.accessList && tx.accessList.length) diffs.push('accessList');
  if (diffs.length) throw new HttpError(422, `signed transaction differs from the issued one in: ${diffs.join(', ')} — nothing was sent`);
  return hex;
}

/**
 * Forwards checked bytes once. "Already known" → its hash; a definite rejection → rejected (nothing is
 * pending); a network failure, a timeout or an unrecognised answer → no-hash (it may be on chain: track it).
 */
export async function relayRaw(up: Upstream, raw: Hex): Promise<RelayOutcome> {
  const local = keccak256(raw);
  let text: string;
  try {
    text = await up.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }));
  } catch (e) {
    const kind = e instanceof UpstreamError ? e.kind : 'network';
    return { outcome: 'no-hash', reason: `the RPC did not answer (${kind}); the transaction may have been broadcast — track it, do not resend` };
  }
  let b: { result?: unknown; error?: { code?: unknown; message?: unknown } };
  try {
    b = JSON.parse(text);
  } catch {
    return { outcome: 'no-hash', reason: 'the RPC answer was not JSON; the transaction may have been broadcast — track it' };
  }
  if (b.error) {
    const r = classifyRejection(b.error);
    if (r.cls === 'already-known') return { outcome: 'hash', txHash: local };
    if (r.cls === 'definite') return { outcome: 'rejected', reason: r.reason };
    return { outcome: 'no-hash', reason: r.reason };
  }
  if (typeof b.result !== 'string' || b.result.toLowerCase() !== local) return { outcome: 'no-hash', reason: 'the RPC returned a hash that is not keccak256 of the signed transaction — track it' };
  return { outcome: 'hash', txHash: local };
}
