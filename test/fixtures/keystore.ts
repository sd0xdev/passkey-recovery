// SYNTHETIC keystore writer for tests: a throwaway key, encrypted as Web3 Secret Storage v3 with
// low scrypt cost. Never a real wallet; never the development gas wallet.
import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export function encryptKeystore(pk: Buffer, password: string, n = 1024): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk = scryptSync(password.normalize('NFKC'), salt, 32, { N: n, r: 8, p: 1 });
  const c = createCipheriv('aes-128-ctr', dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(pk), c.final()]);
  const mac = keccak256(Buffer.concat([dk.subarray(16, 32), ct])).slice(2);
  return JSON.stringify({ version: 3, id: '00000000-0000-4000-8000-000000000000', crypto: { cipher: 'aes-128-ctr', ciphertext: ct.toString('hex'), cipherparams: { iv: iv.toString('hex') }, kdf: 'scrypt', kdfparams: { dklen: 32, salt: salt.toString('hex'), n, r: 8, p: 1 }, mac } });
}

export interface SyntheticGasWallet {
  address: Address;
  privateKey: Hex;
  password: string;
  dir: string;
  manifest: { address: Address; chainId: number; keystore: string; passwordReference: string; keystoreSha256: string };
}

export const FAKE_OP_REF = 'op://aaaaaaaaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbb/password';

export function syntheticGasWallet(): SyntheticGasWallet {
  const pk = randomBytes(32);
  const privateKey = `0x${pk.toString('hex')}` as Hex;
  const address = privateKeyToAccount(privateKey).address;
  const password = randomBytes(12).toString('hex');
  const dir = mkdtempSync(join(tmpdir(), 'cbpr-synth-ks-'));
  chmodSync(dir, 0o700);
  const file = join(dir, 'keystore.json');
  const text = encryptKeystore(pk, password);
  writeFileSync(file, text, { mode: 0o600 });
  return { address, privateKey, password, dir, manifest: { address, chainId: 9745, keystore: file, passwordReference: FAKE_OP_REF, keystoreSha256: createHash('sha256').update(text).digest('hex') } };
}
