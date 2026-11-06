// Coinbase Smart Wallet v1.1 signature: abi.encode(SignatureWrapper{ownerIndex, abi.encode(WebAuthnAuth)}).
import { decodeAbiParameters, encodeAbiParameters, type Hex } from 'viem';
import { bytesToHex, hexToBytes, utf8Decode } from '../crypto/bytes';
import { normalizeLowS } from '../crypto/p256';
import type { ParsedAssertion } from '../webauthn/assertion';
import { verifyAssertion } from '../webauthn/verify';

export class SignatureError extends Error {
  override name = 'SignatureError';
}

const WEBAUTHN_AUTH = {
  type: 'tuple',
  components: [
    { name: 'authenticatorData', type: 'bytes' },
    { name: 'clientDataJSON', type: 'string' },
    { name: 'challengeIndex', type: 'uint256' },
    { name: 'typeIndex', type: 'uint256' },
    { name: 'r', type: 'uint256' },
    { name: 's', type: 'uint256' },
  ],
} as const;

const SIGNATURE_WRAPPER = {
  type: 'tuple',
  components: [
    { name: 'ownerIndex', type: 'uint256' },
    { name: 'signatureData', type: 'bytes' },
  ],
} as const;

/** Rejects anything that looks like an EOA / personal_sign / ERC-1271 signature passed off as a UserOp signature. */
export function assertNotEcdsaSignature(input: string): void {
  if (/^(0x)?[0-9a-fA-F]{130}$/.test(input.trim())) {
    throw new SignatureError('65-byte ECDSA (personal_sign / eth_sign / ERC-1271) signatures are not UserOp signatures for this wallet');
  }
}

export interface SignatureTarget {
  /** 64-byte P256 public key (x ‖ y) of the owner that signs. */
  publicKeyXY: Uint8Array;
  /** The owner's slot in the wallet (ownerAtIndex); the wallet checks the signature against that slot only. */
  ownerIndex: bigint;
  rpId: string;
  origin: string;
  requireUV?: boolean;
}

/**
 * Encodes a WebAuthn assertion as the wallet's UserOp signature, only after it fully verifies against
 * the owner at `ownerIndex` with challenge == userOpHash. s is normalized to low-s (WebAuthn.sol requirement).
 */
export function encodeUserOpSignature(a: ParsedAssertion, opHash: Hex, t: SignatureTarget): Hex {
  const { publicKeyXY, rpId, origin, requireUV = true } = t;
  if (t.ownerIndex < 0n) throw new SignatureError('ownerIndex must be non-negative');
  if (a.kind !== 'userop') throw new SignatureError('a proof-of-control assertion can never be used as a UserOp signature');
  const hashBytes = hexToBytes(opHash);
  if (hashBytes.length !== 32) throw new SignatureError('userOpHash must be 32 bytes');
  const r = verifyAssertion(a, { expectedChallenge: hashBytes, publicKeyXY, rpId, origin, requireUV, ownerIndex: t.ownerIndex });
  if (!r.allOk || !r.signature) {
    const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
    throw new SignatureError(`assertion does not authorize this userOpHash (${failed.join('; ')})`);
  }
  const clientDataJSON = utf8Decode(a.clientDataJSON);
  const challengeIndex = clientDataJSON.indexOf('"challenge":"');
  const typeIndex = clientDataJSON.indexOf('"type":"webauthn.get"');
  if (challengeIndex < 0 || typeIndex < 0) throw new SignatureError('clientDataJSON lacks the substrings WebAuthn.sol checks');
  const { r: sr, s } = normalizeLowS(r.signature);
  const auth = encodeAbiParameters(
    [WEBAUTHN_AUTH],
    [{ authenticatorData: bytesToHex(a.authenticatorData), clientDataJSON, challengeIndex: BigInt(challengeIndex), typeIndex: BigInt(typeIndex), r: sr, s }],
  );
  return encodeAbiParameters([SIGNATURE_WRAPPER], [{ ownerIndex: t.ownerIndex, signatureData: auth }]);
}

export interface DecodedUserOpSignature {
  ownerIndex: bigint;
  authenticatorData: Hex;
  clientDataJSON: string;
  challengeIndex: bigint;
  typeIndex: bigint;
  r: bigint;
  s: bigint;
}

/** Inverse of encodeUserOpSignature, used to display and re-verify an existing signature (demo / tests). */
export function decodeUserOpSignature(sig: Hex): DecodedUserOpSignature {
  const [w] = decodeAbiParameters([SIGNATURE_WRAPPER], sig);
  const [a] = decodeAbiParameters([WEBAUTHN_AUTH], w.signatureData);
  return { ownerIndex: w.ownerIndex, ...a };
}
