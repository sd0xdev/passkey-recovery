// UserOp signature codec, parameterised by owner index (SYNTHETIC keys and assertions only).
import { getAddress, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { hexToBytes } from '../../../src/crypto/bytes';
import { P256_HALF_N } from '../../../src/crypto/p256';
import { encodeTransferCall, parseIntent } from '../../../src/transfer/intent';
import { userOpHash, type UserOperationV06 } from '../../../src/userop/hash';
import { assertNotEcdsaSignature, decodeUserOpSignature, encodeUserOpSignature, SignatureError } from '../../../src/userop/signature';
import { parseAssertionJson } from '../../../src/webauthn/assertion';
import { DEP, RCPT, SRC_A } from '../../fixtures/accounts';
import { buildAssertion, syntheticKey } from '../../fixtures/synthetic';

const op: UserOperationV06 = {
  sender: getAddress(SRC_A), nonce: 3n, initCode: '0x',
  callData: encodeTransferCall(parseIntent(DEP, { source: SRC_A, recipient: RCPT, asset: 'native', amount: '1' })),
  callGasLimit: 100_000n, verificationGasLimit: 600_000n, preVerificationGas: 60_000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n, paymasterAndData: '0x', signature: '0x',
};
const hash: Hex = userOpHash(op, DEP.entryPoint, DEP.chainId);
const key = syntheticKey(0x21);
const target = (ownerIndex: bigint, k = key) => ({ publicKeyXY: k.publicKeyXY, ownerIndex, rpId: DEP.rp.id, origin: DEP.rp.origin });
const userop = (o: Partial<Parameters<typeof buildAssertion>[0]> = {}) => parseAssertionJson(buildAssertion({ challenge: hexToBytes(hash), kind: 'userop', key, ...o }).json, 'userop');

describe('encodeUserOpSignature', () => {
  it.each([0n, 1n, 5n])('encodes ownerIndex %s, low-s and the WebAuthn.sol indices', (idx) => {
    const sig = decodeUserOpSignature(encodeUserOpSignature(userop({ highS: true }), hash, target(idx)));
    expect(sig.ownerIndex).toBe(idx);
    expect(sig.s <= P256_HALF_N).toBe(true);
    expect(sig.clientDataJSON.slice(Number(sig.typeIndex)).startsWith('"type":"webauthn.get"')).toBe(true);
    expect(sig.clientDataJSON.slice(Number(sig.challengeIndex)).startsWith('"challenge":"')).toBe(true);
  });
  it('refuses a negative owner index', () => expect(() => encodeUserOpSignature(userop(), hash, target(-1n))).toThrow(SignatureError));
  it('refuses a proof-of-control assertion even with matching challenge bytes', () => {
    const a = parseAssertionJson(buildAssertion({ challenge: hexToBytes(hash), kind: 'proof', key }).json, 'proof');
    expect(() => encodeUserOpSignature(a, hash, target(0n))).toThrow(/proof-of-control/);
  });
  it('refuses challenge ≠ userOpHash, and a key other than the chosen owner; accepts the right one', () => {
    expect(() => encodeUserOpSignature(userop({ challenge: new Uint8Array(32).fill(1) }), hash, target(0n))).toThrow(SignatureError);
    expect(() => encodeUserOpSignature(userop(), hash, target(0n, syntheticKey(0x22)))).toThrow(/signature/);
    expect(() => encodeUserOpSignature(userop(), hash, target(0n))).not.toThrow();
  });
  it('refuses wrong origin / RP and missing UV', () => {
    expect(() => encodeUserOpSignature(userop({ origin: 'https://keys.coinbase.com.evil.example' }), hash, target(0n))).toThrow(SignatureError);
    expect(() => encodeUserOpSignature(userop({ rpId: 'coinbase.com' }), hash, target(0n))).toThrow(SignatureError);
    expect(() => encodeUserOpSignature(userop({ flags: 0x01 }), hash, target(0n))).toThrow(SignatureError);
  });
});

describe('assertNotEcdsaSignature', () => {
  it('rejects 65-byte ECDSA strings, accepts ordinary JSON text', () => {
    expect(() => assertNotEcdsaSignature('0x' + 'ab'.repeat(65))).toThrow(SignatureError);
    expect(() => assertNotEcdsaSignature('ab'.repeat(65))).toThrow(SignatureError);
    expect(() => assertNotEcdsaSignature('{"format":"cbpr-assertion-v1"}')).not.toThrow();
  });
});
