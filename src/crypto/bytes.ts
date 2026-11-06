// Strict byte encodings. Every decoder rejects non-canonical input instead of guessing.

export class EncodingError extends Error {
  override name = 'EncodingError';
}

const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const HEX_RE = /^0x([0-9a-fA-F]{2})*$/;

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(b);
}

export function bytesToBase64url(b: Uint8Array): string {
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unpadded base64url only; rejects padding, standard-alphabet chars and impossible lengths. */
export function base64urlToBytes(s: string): Uint8Array {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) throw new EncodingError('not unpadded base64url');
  const std = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(std);
  const out = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (bytesToBase64url(out) !== s) throw new EncodingError('non-canonical base64url');
  return out;
}

export function bytesToHex(b: Uint8Array): `0x${string}` {
  let s = '0x';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s as `0x${string}`;
}

export function hexToBytes(h: string): Uint8Array {
  if (!HEX_RE.test(h)) throw new EncodingError('not 0x-prefixed even-length hex');
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 + i * 2, 4 + i * 2), 16);
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function bytesToBigint(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt(bytesToHex(b));
}
