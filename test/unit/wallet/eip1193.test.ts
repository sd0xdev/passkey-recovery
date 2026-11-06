// The browser wallet adapter: exactly one eth_sendTransaction of the prepared tx, three outcomes, and
// refusal (nothing asked) when the wallet's account or chain is not the one the sidecar planned for.
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { SUPPORTED } from '../../../src/config/registry';
import { connect, sendExact, switchChain, WalletError, type Eip1193, type PreparedTx } from '../../../src/wallet/eip1193';

const dep = SUPPORTED[0]!;
const GAS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const HASH = ('0x' + 'ab'.repeat(32)) as Hex;
const TX: PreparedTx = { from: GAS, to: dep.factory, data: '0x1234', gas: '0x5208', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x1' };

/** Scripted provider: records every request; `send` decides what eth_sendTransaction does. */
function wallet(o: { account?: Address | null; chain?: number; send?: () => unknown; switchErr?: number; addErr?: number; afterSwitch?: number } = {}) {
  const calls: Array<{ method: string; params?: unknown[] }> = [];
  let chain = o.chain ?? dep.chainId;
  const p: Eip1193 = {
    async request(a) {
      calls.push(a);
      switch (a.method) {
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return o.account === null ? [] : [(o.account ?? GAS).toLowerCase()];
        case 'eth_chainId':
          return '0x' + chain.toString(16);
        case 'wallet_switchEthereumChain':
          if (o.switchErr) throw Object.assign(new Error('switch'), { code: o.switchErr });
          chain = o.afterSwitch ?? dep.chainId;
          return null;
        case 'wallet_addEthereumChain':
          if (o.addErr) throw Object.assign(new Error('add'), { code: o.addErr });
          chain = dep.chainId;
          return null;
        case 'eth_sendTransaction':
          return o.send ? o.send() : HASH;
      }
      throw new Error('unexpected ' + a.method);
    },
  };
  return { p, calls, sends: () => calls.filter((c) => c.method === 'eth_sendTransaction') };
}

describe('sendExact', () => {
  it('a hash from the wallet → outcome hash, the exact prepared fields sent once', async () => {
    const w = wallet();
    expect(await sendExact(w.p, TX, dep.chainId)).toEqual({ outcome: 'hash', txHash: HASH });
    // The chain id travels in the request (0x2611 = 9745), so a wallet switched away after the check refuses it.
    expect(w.sends()).toEqual([{ method: 'eth_sendTransaction', params: [{ ...TX, value: '0x0', chainId: '0x2611' }] }]);
  });

  it('given up during the account / chain checks → cancelled, eth_sendTransaction never asked; still wanted → sent once', async () => {
    const w = wallet();
    await expect(sendExact(w.p, TX, dep.chainId, () => false)).rejects.toMatchObject({ code: 'cancelled' });
    expect(w.sends()).toHaveLength(0);
    expect(w.calls.map((c) => c.method)).toEqual(['eth_accounts', 'eth_chainId']);
    const ok = wallet();
    expect(await sendExact(ok.p, TX, dep.chainId, () => true)).toEqual({ outcome: 'hash', txHash: HASH });
    expect(ok.sends()).toHaveLength(1);
  });

  it('EIP-1193 4001 → rejected (nothing sent), any other error → no-hash, never a retry', async () => {
    const rej = wallet({ send: () => Promise.reject(Object.assign(new Error('no'), { code: 4001 })) });
    expect(await sendExact(rej.p, TX, dep.chainId)).toEqual({ outcome: 'rejected' });
    const err = wallet({ send: () => Promise.reject(Object.assign(new Error('timeout'), { code: -32603 })) });
    expect((await sendExact(err.p, TX, dep.chainId)).outcome).toBe('no-hash');
    expect(err.sends()).toHaveLength(1);
  });

  it('an answer that is not a 32-byte hash → no-hash (unknown, not failure)', async () => {
    for (const bad of [null, '0x1234', { hash: HASH }, 'ab'.repeat(32)]) {
      const w = wallet({ send: () => bad });
      expect((await sendExact(w.p, TX, dep.chainId)).outcome).toBe('no-hash');
    }
  });

  it('wrong account or wrong chain → throws before asking; the right ones pass (both directions)', async () => {
    const acct = wallet({ account: OTHER });
    await expect(sendExact(acct.p, TX, dep.chainId)).rejects.toMatchObject({ code: 'wrong-account' });
    const none = wallet({ account: null });
    await expect(sendExact(none.p, TX, dep.chainId)).rejects.toMatchObject({ code: 'wrong-account' });
    const chain = wallet({ chain: 1 });
    await expect(sendExact(chain.p, TX, dep.chainId)).rejects.toMatchObject({ code: 'wrong-chain' });
    expect([...acct.sends(), ...none.sends(), ...chain.sends()]).toEqual([]);
    expect((await sendExact(wallet({ account: GAS.toLowerCase() as Address }).p, TX, dep.chainId)).outcome).toBe('hash');
  });
});

describe('connect / switchChain', () => {
  it('connect returns the checksummed account; a rejection is a WalletError rejected', async () => {
    expect(await connect(wallet().p)).toBe(GAS);
    const p: Eip1193 = { request: () => Promise.reject(Object.assign(new Error('no'), { code: 4001 })) };
    await expect(connect(p)).rejects.toMatchObject({ name: 'WalletError', code: 'rejected' });
  });

  it('4902 (unknown chain) → wallet_addEthereumChain with the public RPC, then verified', async () => {
    const w = wallet({ chain: 1, switchErr: 4902 });
    await switchChain(w.p, dep, 'https://rpc.plasma.to');
    const add = w.calls.find((c) => c.method === 'wallet_addEthereumChain')!;
    expect(add.params).toEqual([{ chainId: '0x' + dep.chainId.toString(16), chainName: dep.chainName, nativeCurrency: { name: 'XPL', symbol: 'XPL', decimals: 18 }, rpcUrls: ['https://rpc.plasma.to'] }]);
  });

  it('a switch the wallet claims but does not perform → wrong-chain; a declined switch → rejected', async () => {
    await expect(switchChain(wallet({ chain: 1, afterSwitch: 1 }).p, dep, 'https://rpc.plasma.to')).rejects.toBeInstanceOf(WalletError);
    await expect(switchChain(wallet({ chain: 1, afterSwitch: 1 }).p, dep, 'https://rpc.plasma.to')).rejects.toMatchObject({ code: 'wrong-chain' });
    await expect(switchChain(wallet({ chain: 1, switchErr: 4001 }).p, dep, 'https://rpc.plasma.to')).rejects.toMatchObject({ code: 'rejected' });
    await expect(switchChain(wallet({ chain: 1, switchErr: 4902, addErr: 4001 }).p, dep, 'https://rpc.plasma.to')).rejects.toMatchObject({ code: 'rejected' });
  });
});
