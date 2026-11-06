// The tracker's "no event, nonce used → this op did not run" conclusion pairs an event scan with a nonce
// read. If the head block is replaced between them, the nonce may come from a branch the scan never saw
// (where this op did run): the tracker must conclude nothing and scan again. Same words, same chain →
// the conclusion stands.
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, keccak256, parseAbi, type Hex } from 'viem';
import { encodeTransferCall } from '../../../src/transfer/intent';
import { userOpHash, type UserOperationV06 } from '../../../src/userop/hash';
import { EP_ABI } from '../../../server/abi';
import { SUPPORTED } from '../../../src/config/registry';
import type { Reader } from '../../../server/reader';
import { buildTrackRecord, track } from '../../../server/track';

const dep = SUPPORTED[0]!;
const SOURCE = getAddress('0x4e2f3a4b5c6d7e8f90a1b2c3d4e5f60718293a4b');
const RCPT = getAddress('0x8b7a69584736251403f2e1d0c9b8a79685746352');
const GAS = getAddress('0x2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5f4');
const OP = keccak256('0x0701') as Hex;
const BRANCH_A = keccak256('0xaa') as Hex;
const BRANCH_B = keccak256('0xbb') as Hex;

/** Head 1000 on branch A when the check starts; `headNow` is block 1000's hash when it is read again. */
function readerFor(headNow: Hex) {
  return {
    dep,
    verifyChain: async () => ({ chainId: dep.chainId, genesisHash: `0x${'00'.repeat(32)}` }),
    head: async () => ({ number: 1_000n, hash: BRANCH_A }),
    blockHash: async (n: bigint) => (n === 1_000n ? headNow : null),
    userOpEvents: async () => [],
    uintCall: async () => 8n, // the account's nonce moved past the op's 7
  } as unknown as Reader;
}
const body = (scanCursor?: string) => ({
  record: buildTrackRecord({ chainId: dep.chainId, deploymentId: dep.id, userOpHash: OP, source: SOURCE, recipient: RCPT, asset: 'native', amount: 10n ** 16n, nonce: 7n, gasWallet: GAS, gasWalletNonce: null, inputHash: null, txHash: null, fromBlock: 900n }),
  sender: SOURCE,
  ...(scanCursor ? { scanCursor } : {}),
});

describe('track: a reorg between the event scan and the nonce read', () => {
  it('head replaced mid-check → unknown, scan not complete, restarts behind where it began (never "did not execute")', async () => {
    const r = await track(readerFor(BRANCH_B), body('990'));
    expect(r.state).toBe('unknown');
    expect(r.scan).toEqual({ cursor: 926n, head: 1_000n, complete: false });
    expect(r.detail).toMatch(/replaced while this was checked/);
    expect(r.detail).not.toMatch(/did not execute/);
  });

  it('the restart never goes before the reorg margin under the record’s fromBlock', async () => {
    const r = await track(readerFor(BRANCH_B), body());
    expect(r.scan).toEqual({ cursor: 836n, head: 1_000n, complete: false });
  });

  it('same head throughout → the complete scan and the moved nonce conclude the op did not run with it', async () => {
    const r = await track(readerFor(BRANCH_A), body());
    expect(r.state).toBe('unknown');
    expect(r.scan).toEqual({ cursor: 1_001n, head: 1_000n, complete: true });
    expect(r.detail).toMatch(/another operation used the nonce/);
  });
});

// A short reorg before the first poll: the send recorded head 900, the wallet returned no hash, and a
// two-block reorg put the op into replacement block 899 — under the recorded height. The scan must reach
// it (the op ran), never conclude from the moved nonce that it did not.
const TOKEN = getAddress(dep.assets.find((a) => !a.native)!.id as string);
const TX = keccak256('0x0c') as Hex;
const ERC20 = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const op7: UserOperationV06 = {
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
const h7 = userOpHash(op7, dep.entryPoint, dep.chainId);
const lg = (address: string, topics: Hex[], data: Hex = '0x') => ({ address, topics, data, transactionHash: TX });
const opLogs = [
  lg(dep.entryPoint, encodeEventTopics({ abi: EP_ABI, eventName: 'BeforeExecution' }) as Hex[]),
  lg(TOKEN, encodeEventTopics({ abi: ERC20, eventName: 'Transfer', args: { from: SOURCE, to: RCPT } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }], [1_250_000n])),
  lg(dep.entryPoint, encodeEventTopics({ abi: EP_ABI, eventName: 'UserOperationEvent', args: { userOpHash: h7, sender: SOURCE, paymaster: '0x0000000000000000000000000000000000000000' } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [7n, true, 10n ** 14n, 90_000n])),
];
const HEAD900 = keccak256('0x0900') as Hex;
const B899 = keccak256('0x0899') as Hex;
function shortReorgReader() {
  const input = encodeFunctionData({ abi: EP_ABI, functionName: 'handleOps', args: [[op7], GAS] });
  return {
    dep,
    verifyChain: async () => ({ chainId: dep.chainId, genesisHash: `0x${'00'.repeat(32)}` }),
    head: async () => ({ number: 900n, hash: HEAD900 }),
    blockHash: async (n: bigint) => (n === 900n ? HEAD900 : n === 899n ? B899 : null),
    userOpEvents: async (h: Hex, from: bigint, to: bigint) => (h === h7 && from <= 899n && 899n <= to ? [opLogs[2]!] : []),
    tx: async () => ({ to: dep.entryPoint, input }),
    receipt: async () => ({ blockNumber: '0x383', blockHash: B899, status: '0x1', logs: opLogs, gasUsed: '0x30d40', effectiveGasPrice: '0x3b9aca00' }),
    uintCall: async () => 8n,
  } as unknown as Reader;
}

describe('track: a short reorg before the first poll', () => {
  it('op landed in a replacement block under the recorded fromBlock → found by the scan (confirmed), never "did not execute"', async () => {
    const rec = buildTrackRecord({ chainId: dep.chainId, deploymentId: dep.id, userOpHash: h7, source: SOURCE, recipient: RCPT, asset: TOKEN, amount: 1_250_000n, nonce: 7n, gasWallet: GAS, gasWalletNonce: null, inputHash: null, txHash: null, fromBlock: 900n });
    const r = await track(shortReorgReader(), { record: rec, sender: SOURCE });
    expect(r.state).toBe('confirmed');
    expect(r.block).toBe(899n);
    expect(r.detail).toMatch(/found by event scan/);
  });
});
