import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptKeystore, KeystoreError } from '../../../server/signer/keystore';
import { encryptKeystore } from '../../fixtures/keystore';

// SYNTHETIC throwaway key only.
describe('keystore decrypt', () => {
  const pk = randomBytes(32);
  const text = encryptKeystore(pk, 'synthetic-pass');
  it('decrypts with the right password', async () => expect((await decryptKeystore(text, 'synthetic-pass')).equals(pk)).toBe(true));
  it('wrong password → MAC mismatch, no key', async () => {
    const e = await decryptKeystore(text, 'wrong').catch((x: Error) => x);
    expect(e).toBeInstanceOf(KeystoreError);
    expect((e as Error).message).not.toContain(pk.toString('hex'));
  });
  it('rejects tampered ciphertext, unsupported kdf/cipher, absurd scrypt cost and non-JSON', async () => {
    const j = JSON.parse(text);
    const variants = [
      { ...j, crypto: { ...j.crypto, ciphertext: j.crypto.ciphertext.replace(/^./, (c: string) => (c === '0' ? '1' : '0')) } },
      { ...j, crypto: { ...j.crypto, kdf: 'md5' } },
      { ...j, crypto: { ...j.crypto, cipher: 'aes-128-cbc' } },
      { ...j, crypto: { ...j.crypto, kdfparams: { ...j.crypto.kdfparams, n: 2 ** 24 } } },
      { ...j, version: 1 },
    ];
    for (const v of variants) await expect(decryptKeystore(JSON.stringify(v), 'synthetic-pass')).rejects.toBeInstanceOf(KeystoreError);
    await expect(decryptKeystore('not json', 'synthetic-pass')).rejects.toBeInstanceOf(KeystoreError);
  });
});
