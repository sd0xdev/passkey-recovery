// The Terminal signer's own checks (SYNTHETIC throwaway keys; nothing here can authorize a real account).
import { bytesToHex, encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { encodeTransferCall, parseIntent, type TransferIntent } from '../../../src/transfer/intent';
import type { UserOperationV06 } from '../../../src/userop/hash';
import { checkOuter, checkTransferOp, confirmationPhrase, parseClaimedOp, SIGNER_CAPS, SignerCheckError } from '../../../server/signer/checks';
import { GWEI, maxSignatureBytes, newTwinKey, twinSignature } from '../../../server/sim';
import { DEP, RCPT, SRC_A, SRC_B, USDT0 } from '../../fixtures/accounts';

const key = newTwinKey();
const intent: TransferIntent = parseIntent(DEP, { source: SRC_A, recipient: RCPT, asset: USDT0, amount: '12.5' });
const opts = (ownerIndex = 2n, o: Partial<Parameters<typeof checkTransferOp>[1]> = {}) => ({ dep: DEP, intent, ownerPublicKey: bytesToHex(key.publicKeyXY) as Hex, ownerIndex, maxSignatureBytes: maxSignatureBytes(DEP), ...o });
function signed(over: Partial<UserOperationV06> = {}, ownerIndex = 2n): UserOperationV06 {
  const op: UserOperationV06 = { sender: SRC_A, nonce: 4n, initCode: '0x', callData: encodeTransferCall(intent), callGasLimit: 100_000n, verificationGasLimit: 540_000n, preVerificationGas: 65_000n, maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n, paymasterAndData: '0x', signature: '0x', ...over };
  return { ...op, signature: twinSignature(DEP, key, op, ownerIndex) };
}

describe('checkTransferOp (independent of the sidecar)', () => {
  it('accepts a correctly signed op at the claimed owner index with nonce > 1', () => expect(() => checkTransferOp(signed(), opts())).not.toThrow());
  it('a signature for another owner index is refused; the matching index passes', () => {
    expect(() => checkTransferOp(signed({}, 1n), opts(2n))).toThrow(/ownerIndex 1/);
    expect(() => checkTransferOp(signed({}, 1n), opts(1n))).not.toThrow();
  });
  it('any field changed after signing invalidates the Passkey signature', () => {
    const op = signed();
    expect(() => checkTransferOp({ ...op, callGasLimit: op.callGasLimit + 1n }, opts())).toThrow(/does not authorize/);
    expect(() => checkTransferOp({ ...op, nonce: 5n }, opts())).toThrow(/does not authorize/);
  });
  it('callData must carry exactly the claimed intent', () => {
    const other = parseIntent(DEP, { source: SRC_A, recipient: SRC_B, asset: USDT0, amount: '12.5' });
    expect(() => checkTransferOp(signed({ callData: encodeTransferCall(other) }), opts())).toThrow(/exactly the claimed intent/);
  });
  it.each([
    ['another sender', { sender: SRC_B }, /source account/],
    ['initCode', { initCode: '0x01' as Hex }, /initCode/],
    ['paymaster', { paymasterAndData: '0x01' as Hex }, /paymaster/],
    ['nonce key ≠ 0', { nonce: 1n << 64n }, /nonce key/],
    ['callGas above cap', { callGasLimit: SIGNER_CAPS.callGasLimit + 1n }, /cap/],
    ['maxFee above cap', { maxFeePerGas: SIGNER_CAPS.maxFeePerGas + 1n }, /cap/],
    ['priority > maxFee', { maxPriorityFeePerGas: GWEI + 1n }, /maxPriorityFeePerGas/],
    ['approve call', { callData: encodeFunctionData({ abi: parseAbi(['function execute(address,uint256,bytes)']), functionName: 'execute', args: [USDT0, 0n, encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [RCPT, 1n] })] }) }, /callData rejected/],
  ])('refuses %s', (_, over, re) => expect(() => checkTransferOp(signed(over as Partial<UserOperationV06>), opts())).toThrow(re));
  it('refuses a key that is not the on-chain owner and an oversized signature', () => {
    expect(() => checkTransferOp(signed(), opts(2n, { ownerPublicKey: bytesToHex(newTwinKey().publicKeyXY) as Hex }))).toThrow(/does not authorize/);
    expect(() => checkTransferOp({ ...signed(), signature: `0x${'00'.repeat(maxSignatureBytes(DEP) + 1)}` }, opts())).toThrow(/longer/);
  });
});

describe('checkOuter', () => {
  it('caps, and a precise funding message', () => {
    expect(() => checkOuter(SIGNER_CAPS.outerGas + 1n, GWEI, 10n ** 18n)).toThrow(/signer cap/);
    expect(() => checkOuter(400_000n, GWEI, 0n)).toThrow(/gas wallet holds 0 wei; this transaction may cost up to 400000000000000 wei/);
    expect(() => checkOuter(400_000n, GWEI, 10n ** 15n)).not.toThrow();
    expect(() => checkOuter(5_000_000n, 20n * GWEI, 10n ** 18n)).toThrow(/per-transaction cap/);
  });
});

describe('parseClaimedOp / confirmationPhrase', () => {
  const op = signed();
  const wire = Object.fromEntries(Object.entries(op).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));
  it('round-trips the sidecar wire shape', () => expect(parseClaimedOp(wire)).toEqual({ ...op, sender: getAddress(op.sender) }));
  it('rejects extra/missing fields and non-decimal numbers', () => {
    expect(() => parseClaimedOp({ ...wire, extra: '1' })).toThrow(SignerCheckError);
    expect(() => parseClaimedOp({ ...wire, nonce: '0x0' })).toThrow(SignerCheckError);
    const { nonce: _n, ...missing } = wire;
    expect(() => parseClaimedOp(missing)).toThrow(SignerCheckError);
  });
  it('phrases bind amount, asset and nonce, or step and nonce', () => {
    expect(confirmationPhrase('send', { amount: '12.5', asset: 'USDT0', nonce: 4n })).toBe('SEND 12.5 USDT0 NONCE 4');
    expect(confirmationPhrase('deploy', { step: 'factory', nonce: 0n })).toBe('DEPLOY FACTORY NONCE 0');
  });
});
