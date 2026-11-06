// The File gas payer in the page (GAS-03): the one place in the browser that may hold a gas key, and only
// in memory — never Web Storage, IndexedDB, the URL or a log. A key comes from an encrypted v3 keystore
// the user opens (file + password) or creates here (downloaded at once, encrypted). Locking, a payer
// change or a reload drops it.
import type { Address, Hex } from 'viem';
import { addressOfKey, decryptKeystoreV3, encryptKeystore, inspectKeystore, newPrivateKey, unlockedKey, type UnlockedKey } from './keystoreV3';

let current: UnlockedKey | null = null;
let confirmed = false;
// Bumped by every lock: an open or create still running when the user locks (or leaves the mode) must
// not install its key afterwards.
let generation = 0;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export interface FileWalletState {
  address: Address | null;
  confirmed: boolean;
}

export const fileWalletState = (): FileWalletState => ({ address: current && !current.locked ? current.address : null, confirmed: !!current && confirmed });
export function onFileWallet(fn: () => void): () => void {
  subs.add(fn);
  return () => subs.delete(fn);
}

function install(k: UnlockedKey, startedAt: number) {
  if (startedAt !== generation) {
    k.lock();
    throw new Error('the File gas wallet was locked while this key was being opened; open it again');
  }
  current?.lock();
  current = k;
  confirmed = false;
  notify();
}

/** Opens a keystore the user chose. The password is used once and not kept. */
export async function openKeystore(text: string, password: string): Promise<Address> {
  const startedAt = generation;
  const k = unlockedKey(await decryptKeystoreV3(text, password));
  const claimed = inspectKeystore(text).address;
  if (claimed && claimed !== k.address) {
    k.lock();
    throw new Error('the address written in this file is not the key inside it');
  }
  install(k, startedAt);
  return k.address;
}

/** A new gas key: returns the encrypted file the user must keep (the page offers it as a download). */
export async function createKeystore(password: string, kdf?: { n: number; r: number; p: number }): Promise<{ address: Address; fileName: string; json: string }> {
  const startedAt = generation;
  const pk = newPrivateKey();
  const address = addressOfKey(pk);
  const json = JSON.stringify(await encryptKeystore(pk, password, kdf));
  install(unlockedKey(pk), startedAt);
  return { address, fileName: `passkey-recovery-gas-${address.slice(2, 10).toLowerCase()}.json`, json };
}

/** GAS-05: signing needs the user to have confirmed this exact full address. */
export function confirmFileAddress(address: string): void {
  if (!current || current.locked || address !== current.address) throw new Error('the confirmed address is not the derived one');
  confirmed = true;
  notify();
}

export function lockFileWallet(): void {
  generation++;
  current?.lock();
  current = null;
  confirmed = false;
  notify();
}

export async function signWithFileWallet(tx: { from: Address; chainId: number; to: Address; data: Hex; nonce: number; gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex> {
  if (!current || current.locked) throw new Error('the File gas key is locked');
  if (!confirmed) throw new Error('confirm the gas wallet address first');
  if (tx.from !== current.address) throw new Error('this transaction is for another gas wallet');
  return current.signTransaction(tx);
}
