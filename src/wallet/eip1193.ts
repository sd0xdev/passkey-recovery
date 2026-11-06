// The user's own EIP-1193 wallet (M4): the ONLY module in src/ that may ask a wallet to switch chains
// or send a transaction (source-scan enforces this). It sends exactly the transaction the sidecar
// prepared — never builds one, never retries — and reports one of three outcomes: rejected (nothing
// was sent), a hash, or no-hash (an error after which the transaction may or may not be out).
import { getAddress, type Address, type Hex } from 'viem';
import type { SupportedDeployment } from '../config/registry';

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
}

export class WalletError extends Error {
  override name = 'WalletError';
  constructor(
    message: string,
    readonly code: 'no-wallet' | 'rejected' | 'wrong-account' | 'wrong-chain' | 'failed' | 'cancelled',
  ) {
    super(message);
  }
}

/** The page's injected provider (window.ethereum), or null. */
export function injectedProvider(): Eip1193 | null {
  const p = (globalThis as { ethereum?: unknown }).ethereum as Eip1193 | undefined;
  return p && typeof p.request === 'function' ? p : null;
}

const errCode = (e: unknown) => (typeof e === 'object' && e !== null && typeof (e as { code?: unknown }).code === 'number' ? (e as { code: number }).code : null);
/** EIP-1193 4001: the user rejected the request. */
export const isUserRejection = (e: unknown) => errCode(e) === 4001;

const firstAccount = (r: unknown): Address => {
  if (!Array.isArray(r) || typeof r[0] !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(r[0])) throw new WalletError('the wallet returned no account', 'failed');
  return getAddress(r[0]);
};

export async function connect(p: Eip1193): Promise<Address> {
  try {
    return firstAccount(await p.request({ method: 'eth_requestAccounts' }));
  } catch (e) {
    if (e instanceof WalletError) throw e;
    if (isUserRejection(e)) throw new WalletError('you declined the connection in your wallet', 'rejected');
    throw new WalletError('the wallet did not connect', 'failed');
  }
}

/** Already-authorized accounts only (no prompt). */
export async function currentAccount(p: Eip1193): Promise<Address | null> {
  const r = await p.request({ method: 'eth_accounts' });
  return Array.isArray(r) && r.length ? firstAccount(r) : null;
}

export async function chainIdOf(p: Eip1193): Promise<number> {
  const r = await p.request({ method: 'eth_chainId' });
  if (typeof r !== 'string' || !/^0x[0-9a-fA-F]+$/.test(r)) throw new WalletError('the wallet reported no chain id', 'failed');
  return Number(BigInt(r));
}

/** Asks the wallet to switch to the deployment's chain, offering to add it (public RPC) if unknown. */
export async function switchChain(p: Eip1193, dep: SupportedDeployment, publicRpc: string): Promise<void> {
  const chainId = '0x' + dep.chainId.toString(16);
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (e) {
    if (isUserRejection(e)) throw new WalletError('you declined the network switch in your wallet', 'rejected');
    if (errCode(e) !== 4902) throw new WalletError('the wallet could not switch networks', 'failed');
    try {
      await p.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: dep.chainName, nativeCurrency: { name: 'XPL', symbol: 'XPL', decimals: 18 }, rpcUrls: [publicRpc] }] });
    } catch (e2) {
      if (isUserRejection(e2)) throw new WalletError('you declined adding the network in your wallet', 'rejected');
      throw new WalletError('the wallet could not add the network', 'failed');
    }
  }
  if ((await chainIdOf(p)) !== dep.chainId) throw new WalletError(`the wallet is still not on chain ${dep.chainId}`, 'wrong-chain');
}

export interface PreparedTx {
  from: Address;
  to: Address;
  data: Hex;
  gas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  value?: Hex;
}

export type SendOutcome = { outcome: 'hash'; txHash: Hex } | { outcome: 'rejected' } | { outcome: 'no-hash'; reason: string };

/**
 * Sends `tx` once. Before asking, re-checks the wallet's account and chain; a mismatch throws (nothing
 * was asked, nothing sent). After asking, any outcome other than a clean rejection or a well-formed hash
 * is `no-hash`: the caller must treat it as "may have been sent" and never ask again for the same op.
 */
export async function sendExact(p: Eip1193, tx: PreparedTx, chainId: number, stillWanted: () => boolean = () => true): Promise<SendOutcome> {
  const acct = await currentAccount(p);
  if (!acct || acct !== getAddress(tx.from)) throw new WalletError(`switch your wallet to the gas wallet ${tx.from} first`, 'wrong-account');
  if ((await chainIdOf(p)) !== chainId) throw new WalletError(`switch your wallet to chain ${chainId} first`, 'wrong-chain');
  // The last moment before the wallet is asked: the caller may have given the transaction up during the
  // checks above (nothing asked, nothing sent). Past this line the wallet has it.
  if (!stillWanted()) throw new WalletError('the transaction was given up before the wallet was asked', 'cancelled');
  let r: unknown;
  try {
    // The chain is part of the request itself: a wallet whose network changed after the check above
    // refuses it instead of sending the transaction on another chain.
    r = await p.request({ method: 'eth_sendTransaction', params: [{ from: tx.from, to: tx.to, data: tx.data, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, value: tx.value ?? '0x0', chainId: `0x${chainId.toString(16)}` }] });
  } catch (e) {
    if (isUserRejection(e)) return { outcome: 'rejected' };
    return { outcome: 'no-hash', reason: 'the wallet reported an error after the request' };
  }
  if (typeof r === 'string' && /^0x[0-9a-fA-F]{64}$/.test(r)) return { outcome: 'hash', txHash: r.toLowerCase() as Hex };
  return { outcome: 'no-hash', reason: 'the wallet answered without a transaction hash' };
}
