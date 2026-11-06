// The tracker accepts a UserOp anywhere in a handleOps bundle, so its token check must look only at that
// op's own execution: the logs after the previous op's UserOperationEvent (or BeforeExecution) and
// before its own. Two transfers from the same wallet in one bundle (nonce 7 then 8, as after a reorg
// re-bundles them) are each confirmed; a missing Transfer inside the op's own interval is still refused.
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, keccak256, parseAbi, type Hex } from 'viem';
import { SUPPORTED } from '../../../src/config/registry';
import { encodeTransferCall } from '../../../src/transfer/intent';
import { userOpHash, type UserOperationV06 } from '../../../src/userop/hash';
import { EP_ABI } from '../../../server/abi';
import type { Reader } from '../../../server/reader';
import { buildTrackRecord, track } from '../../../server/track';

const dep = SUPPORTED[0]!;
const TOKEN = getAddress(dep.assets.find((a) => !a.native)!.id as string);
const SOURCE = getAddress('0x3f1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c');
const RCPT_A = getAddress('0x9a8b7c6d5e4f30211203f4e5d6c7b8a990817263');
const RCPT_B = getAddress('0x71c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0');
const GAS = getAddress('0x5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d');
const TX = keccak256('0x0b') as Hex;
const ERC20 = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

const opAt = (nonce: bigint, to: typeof RCPT_A, amount: bigint): UserOperationV06 => ({
  sender: SOURCE,
  nonce,
  initCode: '0x',
  callData: encodeTransferCall({ chainId: dep.chainId, deploymentId: dep.id, source: SOURCE, recipient: to, asset: TOKEN, amount }),
  callGasLimit: 100_000n,
  verificationGasLimit: 400_000n,
  preVerificationGas: 60_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
  paymasterAndData: '0x',
  signature: '0x',
});
const op7 = opAt(7n, RCPT_A, 1_250_000n);
const op8 = opAt(8n, RCPT_B, 3_000_000n);
const h7 = userOpHash(op7, dep.entryPoint, dep.chainId);
const h8 = userOpHash(op8, dep.entryPoint, dep.chainId);

const log = (address: string, topics: Hex[], data: Hex = '0x') => ({ address, topics, data, transactionHash: TX });
const transfer = (to: string, value: bigint) => log(TOKEN, encodeEventTopics({ abi: ERC20, eventName: 'Transfer', args: { from: SOURCE, to: to as Hex } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }], [value]));
const opEvent = (h: Hex, nonce: bigint) =>
  log(dep.entryPoint, encodeEventTopics({ abi: EP_ABI, eventName: 'UserOperationEvent', args: { userOpHash: h, sender: SOURCE, paymaster: '0x0000000000000000000000000000000000000000' } }) as Hex[], encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [nonce, true, 10n ** 14n, 90_000n]));
const before = () => log(dep.entryPoint, encodeEventTopics({ abi: EP_ABI, eventName: 'BeforeExecution' }) as Hex[]);

function readerFor(logs: ReturnType<typeof log>[], o: { from?: string; beneficiary?: typeof GAS } = {}) {
  const input = encodeFunctionData({ abi: EP_ABI, functionName: 'handleOps', args: [[op7, op8], o.beneficiary ?? GAS] });
  const blockHash = keccak256('0xb1') as Hex;
  return {
    dep,
    verifyChain: async () => ({ chainId: dep.chainId, genesisHash: `0x${'00'.repeat(32)}` }),
    head: async () => ({ number: 1_000n }),
    tx: async () => ({ to: dep.entryPoint, input, ...(o.from ? { from: o.from } : {}) }),
    receipt: async () => ({ blockNumber: '0x3c0', blockHash, status: '0x1', logs, gasUsed: '0x30d40', effectiveGasPrice: '0x3b9aca00' }),
    blockHash: async () => blockHash,
    uintCall: async () => 9n,
    userOpEvents: async () => [],
  } as unknown as Reader;
}
const record = (h: Hex, nonce: bigint, to: typeof RCPT_A, amount: bigint) => ({ record: buildTrackRecord({ chainId: dep.chainId, deploymentId: dep.id, userOpHash: h, source: SOURCE, recipient: to, asset: TOKEN, amount, nonce, gasWallet: GAS, gasWalletNonce: 3n, inputHash: null, txHash: TX, fromBlock: 900n }) });

describe('track: a bundle carrying two ops of the same wallet', () => {
  it('each op is judged by its own Transfer only → both are final', async () => {
    const r = readerFor([before(), transfer(RCPT_A, 1_250_000n), opEvent(h7, 7n), transfer(RCPT_B, 3_000_000n), opEvent(h8, 8n)]);
    expect((await track(r, record(h7, 7n, RCPT_A, 1_250_000n))).state).toBe('final');
    expect((await track(r, record(h8, 8n, RCPT_B, 3_000_000n))).state).toBe('final');
  });

  it("an op whose own interval holds no Transfer is inner-failed, even though the other op's Transfer is in the receipt", async () => {
    const r = readerFor([before(), opEvent(h7, 7n), transfer(RCPT_B, 3_000_000n), opEvent(h8, 8n)]);
    const res = await track(r, record(h7, 7n, RCPT_A, 1_250_000n));
    expect(res.state).toBe('inner-failed');
    expect(res.detail).toMatch(/token Transfer log/);
  });

  it('a Transfer before BeforeExecution (validation phase) does not count for the first op', async () => {
    const r = readerFor([transfer(RCPT_A, 1_250_000n), before(), opEvent(h7, 7n), transfer(RCPT_B, 3_000_000n), opEvent(h8, 8n)]);
    expect((await track(r, record(h7, 7n, RCPT_A, 1_250_000n))).state).toBe('inner-failed');
  });
});

// UX-1: the receipt names who paid each fee leg — the outer tx's sender (network fee) and the decoded handleOps
// beneficiary (paid the wallet fee) — so the UI never assumes they are one address.
describe('track: fee roles on the receipt', () => {
  const logs = () => [before(), transfer(RCPT_A, 1_250_000n), opEvent(h7, 7n), transfer(RCPT_B, 3_000_000n), opEvent(h8, 8n)];
  const OTHER = getAddress('0x2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e');

  it('beneficiary == tx.from → both reported, equal', async () => {
    const res = await track(readerFor(logs(), { from: GAS.toLowerCase() }), record(h7, 7n, RCPT_A, 1_250_000n));
    expect([res.receipt?.bundler, res.receipt?.beneficiary]).toEqual([GAS, GAS]);
  });
  it('beneficiary ≠ tx.from → each reported as itself', async () => {
    const res = await track(readerFor(logs(), { from: GAS, beneficiary: OTHER }), record(h7, 7n, RCPT_A, 1_250_000n));
    expect([res.receipt?.bundler, res.receipt?.beneficiary]).toEqual([GAS, OTHER]);
  });
  it('the two amounts come from their own sources: network = outer gasUsed × effectiveGasPrice, wallet = UserOperationEvent.actualGasCost', async () => {
    const res = await track(readerFor(logs(), { from: GAS, beneficiary: OTHER }), record(h7, 7n, RCPT_A, 1_250_000n));
    // Fixture: outer receipt gasUsed 0x30d40 (200,000) × effectiveGasPrice 0x3b9aca00 (1 gwei); the event's actualGasCost 10^14.
    expect(res.receipt).toMatchObject({ gasUsed: 200_000n, effectiveGasPrice: 1_000_000_000n, outerFeeWei: 200_000_000_000_000n, actualGasCost: 100_000_000_000_000n, bundler: GAS, beneficiary: OTHER });
  });
  it('no from on the RPC answer → bundler unknown (null), beneficiary still decoded', async () => {
    const res = await track(readerFor(logs()), record(h7, 7n, RCPT_A, 1_250_000n));
    expect([res.receipt?.bundler, res.receipt?.beneficiary]).toEqual([null, GAS]);
  });
});

// The wallet's hash is the tracker's direct lead: with it, a refused event search does not leave the transfer
// unknown or ask for a hash the page already has; without it, the refusal stays "unknown, paste the hash".
// (A kept hash is still only a lead: its receipt is verified as for any hash — see track-incomplete.test.ts for a
// reported revert under a refused search, which stays unknown.)
describe('track: the RPC refuses the event search, the wallet hash is known', () => {
  const refusing = (logs: ReturnType<typeof log>[]) => ({ ...readerFor(logs), userOpEvents: async () => { throw new Error('eth_getLogs not supported'); } }) as unknown as Reader;
  const logs = () => [before(), transfer(RCPT_A, 1_250_000n), opEvent(h7, 7n)];

  it('hash kept → verified from its own receipt (final), no request to paste a hash', async () => {
    const res = await track(refusing(logs()), record(h7, 7n, RCPT_A, 1_250_000n));
    expect([res.state, res.txHash]).toEqual(['final', TX]);
    expect(res.detail).not.toMatch(/paste|refused/);
  });

  it('no hash kept (control) → unknown and asks for the wallet hash', async () => {
    const noHash = { record: { ...record(h7, 7n, RCPT_A, 1_250_000n).record, txHash: null } };
    const res = await track(refusing(logs()), noHash);
    expect([res.state, res.txHash]).toEqual(['unknown', null]);
    expect(res.detail).toMatch(/refused the event search.*paste/);
  });

  // The kept hash is a lead, never proof: a receipt that does not carry this UserOp, or carries it with a call
  // that is not the recorded transfer, settles nothing and yields no receipt. The transfer stays unknown (the same
  // signed op may have run elsewhere, and that search was refused), and the answer says what was wrong with the lead.
  it('hash kept, but the transaction does not carry this UserOp → unknown, no receipt, the reason named', async () => {
    const op9 = opAt(9n, RCPT_A, 1n);
    const h9 = userOpHash(op9, dep.entryPoint, dep.chainId);
    const res = await track(refusing(logs()), record(h9, 9n, RCPT_A, 1n));
    expect([res.state, res.txHash, res.receipt]).toEqual(['unknown', TX, null]);
    expect(res.detail).toMatch(/reported is mismatch \(the transaction does not carry this UserOp\)/);
  });

  it('hash kept, the UserOp is in the bundle but its call is not the recorded transfer → unknown, no receipt', async () => {
    const res = await track(refusing(logs()), record(h7, 7n, RCPT_A, 2_000_000n));
    expect([res.state, res.txHash, res.receipt]).toEqual(['unknown', TX, null]);
    expect(res.detail).toMatch(/reported is mismatch \(the UserOp differs from the recorded intent or nonce\)/);
  });
});
