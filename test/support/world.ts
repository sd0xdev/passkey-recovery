// SYNTHETIC world on the offline testchain: registry infrastructure deployed through the pinned
// bytecode registry, a hand-assembled stand-in token at the USDT0 registry address, and any number of
// synthetic Coinbase Smart Wallet v1.1 accounts whose owners are throwaway P-256 keys. Nothing here is
// a real user's wallet, key or assertion; the gas wallet is one of anvil's own dev accounts.
import { bytesToHex, encodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { SUPPORTED } from '../../src/config/registry';
import { createAccountCalldata, deriveAddress } from '../../src/wallet/derive';
import { loadInfraSteps, type InfraStep } from '../../server/bytecodeRegistry';
import { miniTokenBalanceSlot, miniTokenCode } from '../fixtures/miniToken';
import { syntheticKey, type SyntheticKey } from '../fixtures/synthetic';
import { deployEvidence, startTestchain, type Testchain } from './testchain';

export const DEP = SUPPORTED[0]!;
export const TOKEN = DEP.assets.find((a) => !a.native)!;

export interface SynthAccount {
  address: Address;
  owners: Hex[];
  nonce: bigint;
  /** owner index → synthetic key, for the Passkey owners. */
  keys: Map<number, SyntheticKey>;
}

export interface World {
  tc: Testchain;
  infra: InfraStep[];
  /** anvil's dev account: used as the user's EIP-1193 gas wallet in tests. */
  gasWallet: Address;
  account(opts: { passkeys: Array<{ index: number; seed: number }>; others?: Array<{ index: number; bytes: Hex }>; nonce?: bigint; deploy?: boolean }): Promise<SynthAccount>;
  fundNative(a: Address, wei: bigint): Promise<void>;
  fundToken(a: Address, units: bigint): Promise<void>;
  send(tx: { to: Address; data: Hex; value?: bigint; gas?: bigint }): Promise<Hex>;
  mine(n?: number): Promise<void>;
}

export async function startWorld(opts: { deployInfra?: boolean } = {}): Promise<World> {
  const tc = await startTestchain();
  const infra = loadInfraSteps(DEP, process.cwd());
  if (opts.deployInfra !== false) await deployEvidence(tc, infra.map((s) => ({ key: s.target, to: s.to, data: s.data })));
  await tc.setCode(TOKEN.id as Address, miniTokenCode(TOKEN.decimals));
  const [gasWallet] = await tc.rpc<Address[]>('eth_accounts');
  const w: World = {
    tc,
    infra,
    gasWallet: getAddress(gasWallet!),
    async account({ passkeys, others = [], nonce = 0n, deploy = true }) {
      const keys = new Map<number, SyntheticKey>();
      const slots: Array<{ index: number; bytes: Hex }> = [...others];
      for (const p of passkeys) {
        const k = syntheticKey(p.seed);
        keys.set(p.index, k);
        slots.push({ index: p.index, bytes: bytesToHex(k.publicKeyXY) });
      }
      slots.sort((a, b) => a.index - b.index);
      if (slots.some((s, i) => s.index !== i)) throw new Error('owner indexes must be 0..n-1');
      const owners = slots.map((s) => s.bytes.toLowerCase() as Hex);
      const address = deriveAddress(DEP, owners, nonce);
      if (deploy) await deployEvidence(tc, [{ key: 'account', to: DEP.factory, data: createAccountCalldata(owners, nonce) }]);
      return { address, owners, nonce, keys };
    },
    fundNative: (a, wei) => tc.setBalance(a, wei),
    async fundToken(a, units) {
      await tc.rpc('anvil_setStorageAt', [TOKEN.id, ...miniTokenBalanceSlot(a, units)]);
    },
    // The "EIP-1193 wallet": anvil automines, but returns the hash before the block exists, so wait
    // for the receipt (like a wallet that resolves once the transaction is included).
    async send(tx) {
      const hash = await tc.rpc<Hex>('eth_sendTransaction', [{ from: gasWallet, to: tx.to, data: tx.data, value: '0x' + (tx.value ?? 0n).toString(16), gas: '0x' + (tx.gas ?? 3_000_000n).toString(16) }]);
      for (let i = 0; i < 200; i++) {
        if (await tc.rpc<unknown>('eth_getTransactionReceipt', [hash])) return hash;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`transaction ${hash} was not mined within 5 s`);
    },
    async mine(n = 1) {
      await tc.rpc('anvil_mine', ['0x' + n.toString(16)]);
    },
  };
  return w;
}

export const depositToData = (a: Address) => encodeFunctionData({ abi: [{ type: 'function', name: 'depositTo', stateMutability: 'payable', inputs: [{ name: 'account', type: 'address' }], outputs: [] }], functionName: 'depositTo', args: [a] });
