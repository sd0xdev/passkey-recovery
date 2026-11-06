// GAS-03: the File gas payer's keystore (src/wallet/keystoreV3.ts) round-trips, rejects a wrong password,
// and is compatible with the Terminal signer's Node-crypto keystores in both directions.
import { describe, expect, it } from 'vitest';
import { keccak256, parseTransaction, recoverTransactionAddress } from 'viem';
import { decryptKeystore } from '../../../server/signer/keystore';
import { encryptKeystore as nodeEncrypt } from '../../fixtures/keystore';
import { addressOfKey, decryptKeystoreV3, encryptKeystore, inspectKeystore, KeystoreV3Error, newPrivateKey, unlockedKey } from '../../../src/wallet/keystoreV3';

const FAST = { n: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';

describe('keystoreV3 (File gas payer)', () => {
  it('encrypt → decrypt returns the same key; the file carries the derived address', async () => {
    const pk = newPrivateKey();
    const addr = addressOfKey(pk);
    const ks = await encryptKeystore(pk, PASSWORD, FAST);
    expect(inspectKeystore(JSON.stringify(ks)).address).toBe(addr);
    const back = await decryptKeystoreV3(JSON.stringify(ks), PASSWORD);
    expect(addressOfKey(back)).toBe(addr);
    expect(JSON.stringify(ks)).not.toContain(Buffer.from(pk).toString('hex'));
  });

  it('wrong password → wrong-password, never a key', async () => {
    const ks = await encryptKeystore(newPrivateKey(), PASSWORD, FAST);
    await expect(decryptKeystoreV3(JSON.stringify(ks), PASSWORD + '!')).rejects.toMatchObject({ code: 'wrong-password' });
  });

  it('short password → weak-password; a 12-character one is accepted', async () => {
    await expect(encryptKeystore(newPrivateKey(), 'short-pass', FAST)).rejects.toBeInstanceOf(KeystoreV3Error);
    await expect(encryptKeystore(newPrivateKey(), 'twelve-chars', FAST)).resolves.toMatchObject({ version: 3 });
  });

  it('a file written here opens in the Terminal signer (Node-crypto decryptor)', async () => {
    const pk = newPrivateKey();
    const ks = await encryptKeystore(pk, PASSWORD, FAST);
    const viaNode = await decryptKeystore(JSON.stringify(ks), PASSWORD);
    expect(addressOfKey(new Uint8Array(viaNode))).toBe(addressOfKey(pk));
  });

  it('a file written by Node crypto (Terminal-signer fixture) opens here', async () => {
    const pk = newPrivateKey();
    const text = nodeEncrypt(Buffer.from(pk), PASSWORD);
    expect(addressOfKey(await decryptKeystoreV3(text, PASSWORD))).toBe(addressOfKey(pk));
  });

  it('malformed or unsupported files are refused before scrypt runs', async () => {
    await expect(decryptKeystoreV3('not json', PASSWORD)).rejects.toMatchObject({ code: 'malformed' });
    const ks = await encryptKeystore(newPrivateKey(), PASSWORD, FAST);
    const pb = { ...ks, crypto: { ...ks.crypto, kdf: 'pbkdf2' } };
    await expect(decryptKeystoreV3(JSON.stringify(pb), PASSWORD)).rejects.toMatchObject({ code: 'unsupported' });
    const huge = { ...ks, crypto: { ...ks.crypto, kdfparams: { ...ks.crypto.kdfparams, n: 2 ** 22 } } };
    await expect(decryptKeystoreV3(JSON.stringify(huge), PASSWORD)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('unlockedKey signs an exact EIP-1559 tx from its address, zeroes the input bytes, and stops after lock()', async () => {
    const pk = newPrivateKey();
    const addr = addressOfKey(pk);
    const k = unlockedKey(pk);
    expect(pk.every((b) => b === 0)).toBe(true);
    const raw = await k.signTransaction({ chainId: 9745, to: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', data: '0x1234', nonce: 7, gas: 300000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
    const tx = parseTransaction(raw);
    expect([tx.nonce, tx.gas, keccak256(tx.data!), await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })]).toEqual([7, 300000n, keccak256('0x1234'), addr]);
    k.lock();
    expect(k.locked).toBe(true);
    await expect(k.signTransaction({ chainId: 9745, to: addr, data: '0x', nonce: 0, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).rejects.toBeInstanceOf(KeystoreV3Error);
  });
});
