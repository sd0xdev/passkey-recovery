// A valid RIP-7212 P256VERIFY input from a throwaway key: a chain with the precompile returns
// 32-byte 1, Plasma (no precompile) returns 0x. The fork must answer the same way as the upstream,
// otherwise its gas numbers would skip the FCL Solidity fallback the real wallet pays for.
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes } from '../src/crypto/bytes';
import { P256_PRECOMPILE } from '../src/config/registry';
import type { Hex } from 'viem';

function build(): Hex {
  const secret = new Uint8Array(32).fill(0x5a);
  const digest = sha256(new TextEncoder().encode('cbpr-p256-precompile-probe'));
  const sig = p256.sign(digest, secret, { prehash: false, lowS: true, format: 'compact' });
  const pub = p256.getPublicKey(secret, false).subarray(1);
  return bytesToHex(concatBytes(digest, sig, pub));
}

export const P256_PROBE = { to: P256_PRECOMPILE, data: build() } as const;
