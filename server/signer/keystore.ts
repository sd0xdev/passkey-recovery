// Web3 Secret Storage v3 decryption (scrypt or pbkdf2-sha256, aes-128-ctr, keccak MAC) with Node
// crypto only. The derived key and the private key live in Buffers the caller zeroes after signing.
import { createDecipheriv, pbkdf2, scrypt, timingSafeEqual } from 'node:crypto';
import { keccak256, type Hex } from 'viem';

export class KeystoreError extends Error {
  override name = 'KeystoreError';
}

interface V3 {
  version: number;
  address?: string;
  crypto?: V3Crypto;
  Crypto?: V3Crypto;
}
interface V3Crypto {
  cipher: string;
  ciphertext: string;
  cipherparams: { iv: string };
  kdf: string;
  kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
  mac: string;
}

const hexBuf = (h: string, what: string) => {
  if (!/^(0x)?[0-9a-fA-F]*$/.test(h) || h.replace(/^0x/, '').length % 2) throw new KeystoreError(`${what} is not hex`);
  return Buffer.from(h.replace(/^0x/, ''), 'hex');
};

function derive(password: string, c: V3Crypto): Promise<Buffer> {
  const k = c.kdfparams;
  const salt = hexBuf(k.salt, 'salt');
  if (k.dklen !== 32) throw new KeystoreError('dklen must be 32');
  if (c.kdf === 'scrypt') {
    const { n, r, p } = k;
    if (!n || !r || !p || n > 2 ** 20 || r > 16 || p > 16) throw new KeystoreError('unsupported scrypt parameters');
    return new Promise((res, rej) => scrypt(password.normalize('NFKC'), salt, 32, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 }, (e, d) => (e ? rej(new KeystoreError('scrypt failed')) : res(d))));
  }
  if (c.kdf === 'pbkdf2') {
    if (k.prf !== 'hmac-sha256' || !k.c || k.c > 10_000_000) throw new KeystoreError('unsupported pbkdf2 parameters');
    return new Promise((res, rej) => pbkdf2(password.normalize('NFKC'), salt, k.c!, 32, 'sha256', (e, d) => (e ? rej(new KeystoreError('pbkdf2 failed')) : res(d))));
  }
  throw new KeystoreError(`unsupported kdf ${c.kdf}`);
}

/** Returns the 32-byte private key. Throws KeystoreError on a wrong password (MAC mismatch) or malformed file. */
export async function decryptKeystore(jsonText: string, password: string): Promise<Buffer> {
  let ks: V3;
  try {
    ks = JSON.parse(jsonText) as V3;
  } catch {
    throw new KeystoreError('keystore is not JSON');
  }
  const c = ks.crypto ?? ks.Crypto;
  if (ks.version !== 3 || !c) throw new KeystoreError('not a v3 keystore');
  if (c.cipher !== 'aes-128-ctr') throw new KeystoreError(`unsupported cipher ${c.cipher}`);
  const dk = await derive(password, c);
  const ct = hexBuf(c.ciphertext, 'ciphertext');
  const mac = Buffer.from(keccak256(Buffer.concat([dk.subarray(16, 32), ct])).slice(2), 'hex');
  const want = hexBuf(c.mac, 'mac');
  if (want.length !== 32 || !timingSafeEqual(mac, want)) {
    dk.fill(0);
    throw new KeystoreError('keystore MAC mismatch (wrong password or corrupted file)');
  }
  const d = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), hexBuf(c.cipherparams.iv, 'iv'));
  const pk = Buffer.concat([d.update(ct), d.final()]);
  dk.fill(0);
  if (pk.length !== 32) throw new KeystoreError('decrypted key is not 32 bytes');
  return pk;
}

export const keyHex = (pk: Buffer): Hex => `0x${pk.toString('hex')}`;
