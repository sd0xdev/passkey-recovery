// "unknown is never failure": the wallet's reported transaction reverted, but the same signed op may have
// run in another transaction the bounded event scan has not reached yet. Until the scan is complete the
// transfer's outcome stays unknown; once it is complete (and found nothing), the revert stands.
import { describe, expect, it } from 'vitest';
import { encodeFunctionData, getAddress, keccak256, type Hex } from 'viem';
import { SUPPORTED, tokenAssets } from '../../../src/config/registry';
import { encodeTransferCall } from '../../../src/transfer/intent';
import { userOpHash, type UserOperationV06 } from '../../../src/userop/hash';
import { EP_ABI } from '../../../server/abi';
import type { Reader } from '../../../server/reader';
import { buildTrackRecord, track } from '../../../server/track';
import { newIntentGate, trackSettled } from '../../../src/ui/trackPoll';

const dep = SUPPORTED[0]!;
const TOKEN = getAddress(tokenAssets(dep)[0]!.id);
const SOURCE = getAddress('0x3f1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c');
const RCPT = getAddress('0x9a8b7c6d5e4f30211203f4e5d6c7b8a990817263');
const GAS = getAddress('0x5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d');
const TX = keccak256('0x0d') as Hex;
const BLK = keccak256('0x0e') as Hex;
const op: UserOperationV06 = {
  sender: SOURCE,
  nonce: 7n,
  initCode: '0x',
  callData: encodeTransferCall({ chainId: dep.chainId, deploymentId: dep.id, source: SOURCE, recipient: RCPT, asset: TOKEN, amount: 1_250_000n }),
  callGasLimit: 100_000n,
  verificationGasLimit: 400_000n,
  preVerificationGas: 60_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
  paymasterAndData: '0x',
  signature: '0x',
};
const h = userOpHash(op, dep.entryPoint, dep.chainId);

/** The reported tx reverted at block 150; the chain head is `head`. No event found in any scanned range. */
const reader = (head: bigint) =>
  ({
    dep,
    verifyChain: async () => ({ chainId: dep.chainId, genesisHash: `0x${'00'.repeat(32)}` }),
    head: async () => ({ number: head, hash: BLK }),
    blockHash: async () => BLK,
    tx: async () => ({ to: dep.entryPoint, input: encodeFunctionData({ abi: EP_ABI, functionName: 'handleOps', args: [[op], GAS] }) }),
    receipt: async () => ({ blockNumber: '0x96', blockHash: BLK, status: '0x0', logs: [], gasUsed: '0x30d40', effectiveGasPrice: '0x3b9aca00' }),
    userOpEvents: async () => [],
    uintCall: async () => 8n,
    txCount: async () => 4n,
  }) as unknown as Reader;
const body = { record: buildTrackRecord({ chainId: dep.chainId, deploymentId: dep.id, userOpHash: h, source: SOURCE, recipient: RCPT, asset: TOKEN, amount: 1_250_000n, nonce: 7n, gasWallet: GAS, gasWalletNonce: 3n, inputHash: null, txHash: TX, fromBlock: 100n }), sender: SOURCE };

describe('track: a reported revert while the event scan is incomplete', () => {
  it('head far past one call’s scan budget → unknown (scan incomplete), never "reverted"', async () => {
    const r = await track(reader(60_000n), body);
    expect(r.state).toBe('unknown');
    expect(r.scan?.complete).toBe(false);
    expect(r.detail).toMatch(/reported is reverted/);
    expect(r.detail).not.toMatch(/did not happen$/);
  });

  it('the scan is complete and found no other execution → the revert stands', async () => {
    const r = await track(reader(1_000n), body);
    expect(r.state).toBe('reverted');
    expect(r.scan?.complete).toBe(true);
  });
});

describe('track: an outer revert is settled only once the nonce moved at the finality depth', () => {
  // Reverted at block 150 (nonce 7); head 1000. Another op used nonce 7 only at the head: the nonce read at
  // head − depth is still 7, so one short reorg could give it back and let the signed op run.
  const at = (nonceAt: (tag: Hex) => bigint) => ({ ...reader(1_000n), uintCall: async (_c: unknown, tag: Hex) => nonceAt(tag) }) as unknown as Reader;
  const deepTag = `0x${(1_000n - BigInt(dep.finalityDepth)).toString(16)}`;
  const json = (r: Awaited<ReturnType<typeof track>>) => JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

  it('nonce moved at the head only → nonceFinal is the deep nonce (7) and the row keeps polling', async () => {
    const r = await track(at((tag) => (tag === deepTag ? 7n : 8n)), body);
    expect([r.state, r.nonceNow, r.nonceFinal]).toEqual(['reverted', 8n, 7n]);
    expect(trackSettled(json(r), '7')).toBe(false);
  });

  it('nonce moved at the finality depth too → settled', async () => {
    const r = await track(at(() => 8n), body);
    expect(r.nonceFinal).toBe(8n);
    expect(trackSettled(json(r), '7')).toBe(true);
  });

  it('the deep nonce is unreadable → null, never 0, and the row keeps polling', async () => {
    const r = await track({ ...at(() => 8n), uintCall: async (_c: unknown, tag: Hex) => (tag === deepTag ? null : 8n) } as unknown as Reader, body);
    expect(r.nonceFinal).toBeNull();
    expect(trackSettled(json(r), '7')).toBe(false);
  });
});

describe('track: the RPC refuses the event search', () => {
  const refusing = () => ({ ...reader(1_000n), userOpEvents: async () => { throw new Error('eth_getLogs not supported by http://10.0.0.7:8545/secret-key'); } }) as unknown as Reader;
  const noHash = { ...body, record: { ...body.record, txHash: null } };

  it('no tx hash → unknown (never an error), no scan claim, the endpoint is not echoed, the row keeps polling', async () => {
    const r = await track(refusing(), noHash);
    expect([r.state, r.scan, r.txHash]).toEqual(['unknown', null, null]);
    expect(r.detail).toMatch(/refused the event search.*paste/);
    expect(r.detail).not.toMatch(/10\.0\.0\.7|secret-key|eth_getLogs not supported/);
    expect(trackSettled(JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))), '7')).toBe(false);
  });

  it('a reported revert with the search refused → unknown that names the revert, never "reverted"', async () => {
    const r = await track(refusing(), body);
    expect(r.state).toBe('unknown');
    expect(r.detail).toMatch(/reported is reverted/);
  });

  it('a working search with no event and an unmoved nonce is unaffected (control)', async () => {
    const r = await track({ ...reader(1_000n), uintCall: async () => 7n } as unknown as Reader, noHash);
    expect([r.state, r.scan?.complete]).toEqual(['unknown', true]);
    expect(r.detail).not.toMatch(/refused/);
  });
});

describe('track: an unreadable live nonce is null, never 0', () => {
  // A saved nonce-0 operation with no hash and no event: "nonce 0 now" would open a new intent with the
  // same-nonce assurance. An empty answer for the nonce must leave the gate closed.
  // As the page receives it: the sidecar's JSON encodes bigints as decimal strings.
  const wire = (r: unknown) => JSON.parse(JSON.stringify(r, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Parameters<typeof newIntentGate>[0];
  const zero = { ...body, record: buildTrackRecord({ chainId: dep.chainId, deploymentId: dep.id, userOpHash: h, source: SOURCE, recipient: RCPT, asset: TOKEN, amount: 1_250_000n, nonce: 0n, gasWallet: GAS, gasWalletNonce: 3n, inputHash: null, txHash: null, fromBlock: 100n }) };

  it('the nonce read answers empty → nonceNow null, the new-intent gate stays unknown, the detail says it was unreadable', async () => {
    const r = await track({ ...reader(1_000n), uintCall: async () => null } as unknown as Reader, zero);
    expect([r.state, r.nonceNow, r.nonceFinal]).toEqual(['unknown', null, null]);
    expect(newIntentGate(wire(r), '0')).toBe('unknown');
    expect(r.detail).toMatch(/nonce could not be read/);
  });

  it('a readable nonce 0 (control) → same-nonce', async () => {
    const r = await track({ ...reader(1_000n), uintCall: async () => 0n } as unknown as Reader, zero);
    expect(r.nonceNow).toBe(0n);
    expect(newIntentGate(wire(r), '0')).toBe('same-nonce');
  });
});

describe('track: the scan budget (a test seam in code, never from the request body)', () => {
  /** Records every [from, to] the scan asked the RPC for. */
  const recording = (head: bigint) => {
    const ranges: Array<[bigint, bigint]> = [];
    const r = { ...reader(head), userOpEvents: async (_h: Hex, from: bigint, to: bigint) => (ranges.push([from, to]), []) } as unknown as Reader;
    return { r, ranges };
  };
  const floor = 100n - 64n; // fromBlock 100 minus the reorg margin

  it('default: 25 chunks of 2000 blocks per call; a budget in the body is ignored', async () => {
    const { r, ranges } = recording(60_000n);
    const t = await track(r, { ...body, budget: { chunks: 1, range: '5' }, scanBudget: { chunks: 1 } });
    expect(ranges).toHaveLength(25);
    expect(ranges[0]).toEqual([floor, floor + 1999n]);
    expect(t.scan).toMatchObject({ cursor: floor + 25n * 2000n, complete: false });
  });

  it('a smaller budget is used as given, and the cursor is where its last chunk ended', async () => {
    const { r, ranges } = recording(1_000n);
    const t = await track(r, body, { chunks: 3, range: 20n });
    expect(ranges).toEqual([[floor, floor + 19n], [floor + 20n, floor + 39n], [floor + 40n, floor + 59n]]);
    expect(t.scan).toMatchObject({ cursor: floor + 60n, complete: false });
  });

  it.each([
    ['zero / negative chunks → 1', { chunks: 0 }, 1, 2000n],
    ['more chunks than the limit → 25', { chunks: 1_000 }, 25, 2000n],
    ['a fractional count is floored', { chunks: 2.9 }, 2, 2000n],
    ['range 0 → the default', { range: 0n }, 25, 2000n],
    ['range above the RPC limit → the default', { range: 5_000n }, 25, 2000n],
  ])('clamped: %s', async (_name, budget, chunks, range) => {
    const { r, ranges } = recording(1_000_000n);
    await track(r, body, budget);
    expect(ranges).toHaveLength(chunks);
    expect(ranges[0]![1] - ranges[0]![0] + 1n).toBe(range);
  });
});
