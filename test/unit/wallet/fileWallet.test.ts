// The File gas payer in the page (GAS-03/05): memory only, signs only after the exact derived address was
// confirmed, only for its own `from`, and lock forgets the key. SYNTHETIC key, low scrypt N for speed.
import { parseTransaction, recoverTransactionAddress, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';
import { hexToBytes } from '../../../src/crypto/bytes';
import { encryptKeystore } from '../../../src/wallet/keystoreV3';
import { confirmFileAddress, createKeystore, fileWalletState, lockFileWallet, openKeystore, signWithFileWallet } from '../../../src/wallet/fileWallet';

const KDF = { n: 2 ** 10, r: 8, p: 1 };
const PASSWORD = 'synthetic gas password 1';
const pk = generatePrivateKey();
const addr = privateKeyToAccount(pk).address;
const tx = (from: Hex) => ({ from: from as `0x${string}`, chainId: 9745, to: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as const, data: '0x1fad948c' as Hex, nonce: 4, gas: 210000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n });

afterEach(() => lockFileWallet());

describe('fileWallet', () => {
  it('open → unconfirmed: signing refused until the exact address is confirmed', async () => {
    const json = JSON.stringify(await encryptKeystore(hexToBytes(pk), PASSWORD, KDF));
    expect(await openKeystore(json, PASSWORD)).toBe(addr);
    expect(fileWalletState()).toEqual({ address: addr, confirmed: false });
    await expect(signWithFileWallet(tx(addr))).rejects.toThrow(/confirm/);
    expect(() => confirmFileAddress(addr.toLowerCase())).toThrow();
    confirmFileAddress(addr);
    const raw = await signWithFileWallet(tx(addr));
    expect(await recoverTransactionAddress({ serializedTransaction: raw as never })).toBe(addr);
    expect(parseTransaction(raw)).toMatchObject({ nonce: 4, chainId: 9745, type: 'eip1559' });
  });

  it('confirmed key → a tx for another from is refused', async () => {
    const json = JSON.stringify(await encryptKeystore(hexToBytes(pk), PASSWORD, KDF));
    confirmFileAddress(await openKeystore(json, PASSWORD));
    await expect(signWithFileWallet(tx(privateKeyToAccount(generatePrivateKey()).address))).rejects.toThrow(/another gas wallet/);
  });

  it('wrong password → rejected, nothing installed', async () => {
    const json = JSON.stringify(await encryptKeystore(hexToBytes(pk), PASSWORD, KDF));
    await expect(openKeystore(json, 'not the password!!')).rejects.toThrow();
    expect(fileWalletState().address).toBeNull();
  });

  it('a file whose stated address is not its key → refused', async () => {
    const ks = { ...(await encryptKeystore(hexToBytes(pk), PASSWORD, KDF)), address: privateKeyToAccount(generatePrivateKey()).address.slice(2).toLowerCase() };
    await expect(openKeystore(JSON.stringify(ks), PASSWORD)).rejects.toThrow(/not the key/);
    expect(fileWalletState().address).toBeNull();
  });

  it('create → returns an encrypted file that opens to the same address; lock forgets the key', async () => {
    const c = await createKeystore(PASSWORD, KDF);
    expect(c.json).not.toMatch(/[0-9a-f]{64}"?\s*[,}]\s*$/i);
    expect(c.fileName).toMatch(/^passkey-recovery-gas-[0-9a-f]{8}\.json$/);
    confirmFileAddress(c.address);
    lockFileWallet();
    expect(fileWalletState()).toEqual({ address: null, confirmed: false });
    await expect(signWithFileWallet(tx(c.address))).rejects.toThrow(/locked/);
    expect(await openKeystore(c.json, PASSWORD)).toBe(c.address);
  });
  it('regression: lock while an open is still decrypting → the late key is dropped, nothing installed', async () => {
    const json = JSON.stringify(await encryptKeystore(hexToBytes(pk), PASSWORD, KDF));
    const opening = openKeystore(json, PASSWORD);
    lockFileWallet();
    await expect(opening).rejects.toThrow(/locked while/);
    expect(fileWalletState()).toEqual({ address: null, confirmed: false });
  });

  it('regression: lock while a create is still encrypting → the new key is dropped; an open after the lock still works', async () => {
    const creating = createKeystore(PASSWORD, KDF);
    lockFileWallet();
    await expect(creating).rejects.toThrow(/locked while/);
    expect(fileWalletState().address).toBeNull();
    const json = JSON.stringify(await encryptKeystore(hexToBytes(pk), PASSWORD, KDF));
    expect(await openKeystore(json, PASSWORD)).toBe(addr);
  });
});
