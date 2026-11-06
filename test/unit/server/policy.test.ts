import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { encodeTransferCall, parseIntent } from '../../../src/transfer/intent';
import type { UserOperationV06 } from '../../../src/userop/hash';
import { decodeUserOpSignature } from '../../../src/userop/signature';
import { SIGNER_CAPS } from '../../../server/signer/checks';
import { callGasPolicy, CLIENT_DATA_MAX_BYTES, feePolicy, GWEI, maxSignatureBytes, newTwinKey, outerGasPolicy, prefundOf, preVerificationGasFor, twinAssertion, twinOwners, twinSignature, verificationGasPolicy } from '../../../server/sim';
import { DEP, RCPT, SRC_A } from '../../fixtures/accounts';

const op = (sig: Hex = '0x'): UserOperationV06 => ({ sender: SRC_A, nonce: 7n, initCode: '0x', callData: encodeTransferCall(parseIntent(DEP, { source: SRC_A, recipient: RCPT, asset: 'native', amount: '1' })), callGasLimit: 100_000n, verificationGasLimit: 600_000n, preVerificationGas: 0n, maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n, paymasterAndData: '0x', signature: sig });

describe('fee policy', () => {
  it('maxFee = max(2·baseFee + priority, 1 gwei); priority ≥ 1 wei', () => {
    expect(feePolicy(8n, 1n)).toEqual({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n });
    expect(feePolicy(8n, 0n).maxPriorityFeePerGas).toBe(1n);
    expect(feePolicy(10n * GWEI, 2n * GWEI).maxFeePerGas).toBe(22n * GWEI);
  });
  it('stays under the signer cap for base fees up to 49 gwei', () => expect(feePolicy(49n * GWEI, GWEI).maxFeePerGas <= SIGNER_CAPS.maxFeePerGas).toBe(true));
  it('prefund is (call + verification + preVerification) × maxFee, the amount the reserve covers', () => expect(prefundOf(op())).toBe(700_000n * GWEI));
});

describe('gas policy', () => {
  it('×1.5 with floors', () => {
    expect(callGasPolicy(10_000n)).toBe(100_000n);
    expect(callGasPolicy(72_265n)).toBe(108_398n);
    expect(verificationGasPolicy(361_339n)).toBe(542_009n);
    expect(verificationGasPolicy(1n)).toBe(500_000n);
  });
  it('preVerificationGas is sized for the maximum signature and grows with it', () => {
    const small = preVerificationGasFor(op('0x00'));
    const big = preVerificationGasFor(op(`0x${'ff'.repeat(maxSignatureBytes(DEP))}`));
    expect(big).toBeGreaterThan(small);
    expect(big).toBeLessThan(SIGNER_CAPS.preVerificationGas);
  });
  it('outer gas covers the whole UserOp plus overhead even when the estimate is low', () => expect(outerGasPolicy(1n, op())).toBe(800_000n));
});

describe('twin wallet', () => {
  it('the estimate signature is a maximum-length UV assertion at the real owner index', () => {
    const k = newTwinKey();
    const a = twinAssertion(DEP, k, `0x${'11'.repeat(32)}`);
    expect(a.clientDataJSON.length).toBe(CLIENT_DATA_MAX_BYTES);
    expect(a.authenticatorData[32]! & 0x05).toBe(0x05);
    const sig = twinSignature(DEP, k, op(), 3n);
    expect((sig.length - 2) / 2).toBe(maxSignatureBytes(DEP));
    expect(decodeUserOpSignature(sig).ownerIndex).toBe(3n);
  });
  it('owners: the signing slot becomes the twin key, removed slots get a filler, others are kept', () => {
    const tw: Hex = `0x${'cd'.repeat(64)}`;
    const keep: Hex = `0x${'00'.repeat(12)}${'ee'.repeat(20)}`;
    const out = twinOwners([{ index: 0, bytes: '0x' }, { index: 1, bytes: keep }, { index: 2, bytes: `0x${'ab'.repeat(64)}` }], 2, tw);
    expect(out[2]).toBe(tw);
    expect(out[1]).toBe(keep);
    expect(out[0]).not.toBe('0x');
  });
});
