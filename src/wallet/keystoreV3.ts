// Web3 Secret Storage v3 (scrypt, aes-128-ctr, keccak256 MAC) for the File gas payer (GAS-03). The same
// code runs in the page (File mode) and in the runner's native signer (Node 24 has WebCrypto), and the
// files it writes open in the Terminal signer's Node-crypto decryptor (cross-compatibility test). The
// private key exists only as bytes inside the closure `unlockedKey` returns; nothing here persists it,
// logs it, or puts it in a string the caller can see.
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export class KeystoreV3Error extends Error {
  override name = 'KeystoreV3Error';
  constructor(
    message: string,
    readonly code: 'malformed' | 'unsupported' | 'wrong-password' | 'weak-password' | 'address-mismatch',
  ) {
    super(message);
  }
}

/** scrypt N = 2^17, r = 8, p = 1: ~128 MiB, about a second on a laptop. Lower N only in tests. */
export const DEFAULT_SCRYPT = { n: 2 ** 17, r: 8, p: 1 } as const;
export const MIN_PASSWORD_CHARS = 12;
const MAX_N = 2 ** 20;

export interface KeystoreV3 {
  version: 3;
  id: string;
  address: string;
  crypto: {
    cipher: 'aes-128-ctr';
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: 'scrypt';
    kdfparams: { dklen: 32; salt: string; n: number; r: number; p: number };
    mac: string;
  };
}

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new KeystoreV3Error('WebCrypto is not available here', 'unsupported');
  return s;
};
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h: unknown, what: string, len?: number): Uint8Array => {
  if (typeof h !== 'string') throw new KeystoreV3Error(`${what} missing`, 'malformed');
  const s = h.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 || (len !== undefined && s.length !== len * 2)) throw new KeystoreV3Error(`${what} is not hex of the expected length`, 'malformed');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
};

async function aesCtr(key16: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', key16 as BufferSource, { name: 'AES-CTR' }, false, ['encrypt']);
  return new Uint8Array(await subtle().encrypt({ name: 'AES-CTR', counter: iv as BufferSource, length: 128 }, k, data as BufferSource));
}

const macOf = (dk: Uint8Array, ct: Uint8Array) => keccak256(new Uint8Array([...dk.subarray(16, 32), ...ct])).slice(2);

/** A fresh secp256k1 key from the platform CSPRNG (rejection-sampled into the curve order). */
export function newPrivateKey(): Uint8Array {
  for (;;) {
    const k = rand(32);
    if (secp256k1.utils.isValidSecretKey(k)) return k;
  }
}

export function addressOfKey(pk: Uint8Array): Address {
  return getAddress(privateKeyToAccount(toHex(pk)).address);
}

export async function encryptKeystore(pk: Uint8Array, password: string, kdf: { n: number; r: number; p: number } = DEFAULT_SCRYPT): Promise<KeystoreV3> {
  if (password.length < MIN_PASSWORD_CHARS) throw new KeystoreV3Error(`use a password of at least ${MIN_PASSWORD_CHARS} characters`, 'weak-password');
  if (pk.length !== 32) throw new KeystoreV3Error('private key must be 32 bytes', 'malformed');
  const salt = rand(32);
  const iv = rand(16);
  const dk = await scryptAsync(password.normalize('NFKC'), salt, { N: kdf.n, r: kdf.r, p: kdf.p, dkLen: 32, maxmem: 256 * kdf.n * kdf.r + 1024 * 1024 });
  try {
    const ct = await aesCtr(dk.subarray(0, 16), iv, pk);
    const u = rand(16);
    u[6] = (u[6]! & 0x0f) | 0x40;
    u[8] = (u[8]! & 0x3f) | 0x80;
    const id = `${hex(u.subarray(0, 4))}-${hex(u.subarray(4, 6))}-${hex(u.subarray(6, 8))}-${hex(u.subarray(8, 10))}-${hex(u.subarray(10))}`;
    return { version: 3, id, address: addressOfKey(pk).slice(2).toLowerCase(), crypto: { cipher: 'aes-128-ctr', ciphertext: hex(ct), cipherparams: { iv: hex(iv) }, kdf: 'scrypt', kdfparams: { dklen: 32, salt: hex(salt), n: kdf.n, r: kdf.r, p: kdf.p }, mac: macOf(dk, ct) } };
  } finally {
    dk.fill(0);
  }
}

/** Parses the public parts only (address, kdf) without the password: what the UI may show before unlocking. */
export function inspectKeystore(text: string): { address: Address | null; kdf: string } {
  let j: { version?: unknown; address?: unknown; crypto?: { kdf?: unknown }; Crypto?: { kdf?: unknown } };
  try {
    j = JSON.parse(text);
  } catch {
    throw new KeystoreV3Error('the file is not JSON', 'malformed');
  }
  if (j.version !== 3 || !(j.crypto ?? j.Crypto)) throw new KeystoreV3Error('not a v3 keystore', 'malformed');
  const a = typeof j.address === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(j.address) ? getAddress(`0x${j.address.replace(/^0x/, '')}`) : null;
  return { address: a, kdf: String((j.crypto ?? j.Crypto)!.kdf) };
}

/** Decrypts to raw key bytes (caller zeroes them). Wrong password → code 'wrong-password'. */
export async function decryptKeystoreV3(text: string, password: string): Promise<Uint8Array> {
  let j: { version?: unknown; crypto?: Record<string, unknown>; Crypto?: Record<string, unknown> };
  try {
    j = JSON.parse(text);
  } catch {
    throw new KeystoreV3Error('the file is not JSON', 'malformed');
  }
  const c = (j.crypto ?? j.Crypto) as { cipher?: unknown; ciphertext?: unknown; cipherparams?: { iv?: unknown }; kdf?: unknown; kdfparams?: Record<string, unknown>; mac?: unknown } | undefined;
  if (j.version !== 3 || !c) throw new KeystoreV3Error('not a v3 keystore', 'malformed');
  if (c.cipher !== 'aes-128-ctr' || c.kdf !== 'scrypt') throw new KeystoreV3Error('only scrypt + aes-128-ctr keystores open here (use the Terminal signer for pbkdf2)', 'unsupported');
  const k = c.kdfparams ?? {};
  const n = Number(k.n), r = Number(k.r), p = Number(k.p);
  if (k.dklen !== 32 || !Number.isInteger(n) || n < 2 || n > MAX_N || (n & (n - 1)) !== 0 || !(r >= 1 && r <= 16) || !(p >= 1 && p <= 16)) throw new KeystoreV3Error('unsupported scrypt parameters', 'unsupported');
  const salt = unhex(k.salt, 'salt');
  const ct = unhex(c.ciphertext, 'ciphertext', 32);
  const iv = unhex(c.cipherparams?.iv, 'iv', 16);
  const want = unhex(c.mac, 'mac', 32);
  const dk = await scryptAsync(password.normalize('NFKC'), salt, { N: n, r, p, dkLen: 32, maxmem: 256 * n * r + 1024 * 1024 });
  try {
    const mac = macOf(dk, ct);
    // Constant-time compare over the hex strings.
    let diff = mac.length ^ (want.length * 2);
    const w = hex(want);
    for (let i = 0; i < mac.length; i++) diff |= mac.charCodeAt(i) ^ w.charCodeAt(i);
    if (diff !== 0) throw new KeystoreV3Error('wrong password (or the file is damaged)', 'wrong-password');
    return await aesCtr(dk.subarray(0, 16), iv, ct);
  } finally {
    dk.fill(0);
  }
}

/** The signing capability, closed over the key. `lock()` drops it; nothing else can read it back. */
export interface UnlockedKey {
  readonly address: Address;
  signTransaction(tx: { chainId: number; to: Address; data: Hex; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex>;
  lock(): void;
  readonly locked: boolean;
}

export function unlockedKey(pk: Uint8Array): UnlockedKey {
  let account: ReturnType<typeof privateKeyToAccount> | null = privateKeyToAccount(toHex(pk));
  pk.fill(0);
  const address = getAddress(account.address);
  return {
    address,
    get locked() {
      return account === null;
    },
    async signTransaction(tx) {
      if (!account) throw new KeystoreV3Error('the gas key is locked', 'malformed');
      return account.signTransaction({ type: 'eip1559', chainId: tx.chainId, to: tx.to, data: tx.data, value: 0n, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
    },
    lock() {
      account = null;
    },
  };
}
