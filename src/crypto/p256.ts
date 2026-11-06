import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { EncodingError, bytesToBigint, concatBytes, hexToBytes } from './bytes';

export const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
export const P256_HALF_N = P256_N / 2n;

export interface RS {
  r: bigint;
  s: bigint;
}

function readInt(der: Uint8Array, at: number): { value: bigint; next: number } {
  if (der[at] !== 0x02) throw new EncodingError('DER: expected INTEGER');
  const len = der[at + 1];
  if (len === undefined || len === 0 || len > 33) throw new EncodingError('DER: bad INTEGER length');
  const start = at + 2;
  const body = der.subarray(start, start + len);
  if (body.length !== len) throw new EncodingError('DER: truncated INTEGER');
  if (body[0]! & 0x80) throw new EncodingError('DER: negative INTEGER');
  if (len > 1 && body[0] === 0x00 && !(body[1]! & 0x80)) throw new EncodingError('DER: non-minimal INTEGER');
  return { value: bytesToBigint(body), next: start + len };
}

/** Strict DER ECDSA-Sig-Value (short-form lengths only, minimal integers, 1 ≤ r,s < n). */
export function parseDerSignature(der: Uint8Array): RS {
  if (der.length < 8 || der.length > 72) throw new EncodingError('DER: bad total length');
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new EncodingError('DER: bad SEQUENCE header');
  const r = readInt(der, 2);
  const s = readInt(der, r.next);
  if (s.next !== der.length) throw new EncodingError('DER: trailing bytes');
  for (const v of [r.value, s.value]) {
    if (v <= 0n || v >= P256_N) throw new EncodingError('DER: scalar out of range');
  }
  return { r: r.value, s: s.value };
}

/** WebAuthn.sol rejects s > n/2; (r, n − s) is the equivalent low-s signature. */
export function normalizeLowS(sig: RS): RS {
  return sig.s > P256_HALF_N ? { r: sig.r, s: P256_N - sig.s } : sig;
}

function to32(v: bigint): Uint8Array {
  return hexToBytes('0x' + v.toString(16).padStart(64, '0'));
}

/** Verifies ECDSA-P256 over a 32-byte digest. `pubkeyXY` is the 64-byte x ‖ y form stored on chain. */
export function verifyP256Digest(digest: Uint8Array, sig: RS, pubkeyXY: Uint8Array): boolean {
  if (digest.length !== 32 || pubkeyXY.length !== 64) return false;
  try {
    const compact = concatBytes(to32(sig.r), to32(sig.s));
    const pub = concatBytes(Uint8Array.of(0x04), pubkeyXY);
    return p256.verify(compact, digest, pub, { prehash: false, lowS: false, format: 'compact' });
  } catch {
    return false;
  }
}

/** WebAuthn signed message: SHA-256(authenticatorData ‖ SHA-256(clientDataJSON)). */
export function webauthnDigest(authenticatorData: Uint8Array, clientDataJSON: Uint8Array): Uint8Array {
  return sha256(concatBytes(authenticatorData, sha256(clientDataJSON)));
}

function derInt(v: bigint): Uint8Array {
  let hex = v.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let b = hexToBytes('0x' + hex);
  if (b[0]! & 0x80) b = concatBytes(Uint8Array.of(0), b);
  return concatBytes(Uint8Array.of(0x02, b.length), b);
}

/** Inverse of parseDerSignature. */
export function encodeDerSignature({ r, s }: RS): Uint8Array {
  const body = concatBytes(derInt(r), derInt(s));
  return concatBytes(Uint8Array.of(0x30, body.length), body);
}
