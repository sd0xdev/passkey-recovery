// SYNTHETIC WebAuthn fixtures: a throwaway P256 key generated from a fixed test scalar.
// Nothing here is a real Passkey, a real assertion or a user secret.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64url, concatBytes, utf8 } from '../../src/crypto/bytes';
import { P256_N, encodeDerSignature, webauthnDigest } from '../../src/crypto/p256';

export interface SyntheticKey {
  secret: Uint8Array;
  publicKeyXY: Uint8Array;
}

export function syntheticKey(seedByte = 0x11): SyntheticKey {
  const secret = new Uint8Array(32).fill(seedByte);
  const pub = p256.getPublicKey(secret, false); // 0x04 ‖ x ‖ y
  return { secret, publicKeyXY: pub.subarray(1) };
}

export function derEncode(r: bigint, s: bigint): Uint8Array {
  return encodeDerSignature({ r, s });
}

export interface AssertionOpts {
  challenge: Uint8Array;
  key?: SyntheticKey;
  kind?: 'proof' | 'userop';
  origin?: string;
  rpId?: string;
  type?: string;
  flags?: number;
  clientDataExtra?: Record<string, unknown>;
  /** Force the high-s form of the signature. */
  highS?: boolean;
}

export interface BuiltAssertion {
  json: string;
  fields: Record<string, string | null>;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  r: bigint;
  s: bigint;
}

export function buildAssertion(o: AssertionOpts): BuiltAssertion {
  const key = o.key ?? syntheticKey();
  const clientData = {
    type: o.type ?? 'webauthn.get',
    challenge: bytesToBase64url(o.challenge),
    origin: o.origin ?? 'https://keys.coinbase.com',
    ...o.clientDataExtra,
  };
  const clientDataJSON = utf8(JSON.stringify(clientData));
  const authenticatorData = concatBytes(sha256(utf8(o.rpId ?? 'keys.coinbase.com')), Uint8Array.of(o.flags ?? 0x1d), new Uint8Array(4));
  const compact = p256.sign(webauthnDigest(authenticatorData, clientDataJSON), key.secret, { prehash: false, lowS: true, format: 'compact' });
  const r = BigInt('0x' + Buffer.from(compact.subarray(0, 32)).toString('hex'));
  let s = BigInt('0x' + Buffer.from(compact.subarray(32)).toString('hex'));
  if (o.highS) s = P256_N - s;
  const fields: Record<string, string | null> = {
    format: 'cbpr-assertion-v1',
    kind: o.kind ?? 'proof',
    rpId: 'keys.coinbase.com',
    origin: clientData.origin,
    credentialId: bytesToBase64url(utf8('synthetic-credential')),
    authenticatorData: bytesToBase64url(authenticatorData),
    clientDataJSON: bytesToBase64url(clientDataJSON),
    signature: bytesToBase64url(derEncode(r, s)),
    userHandle: null,
  };
  return { json: JSON.stringify(fields), fields, authenticatorData, clientDataJSON, r, s };
}

export function withField(a: BuiltAssertion, key: string, value: unknown): string {
  return JSON.stringify({ ...a.fields, [key]: value });
}
