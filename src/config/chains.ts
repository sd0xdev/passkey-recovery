// Supported-chain registry (open-source spec §3.3, M1). A chain is identified by chainId AND genesis
// block hash: an RPC that reports the right chainId on a different chain (a fork, a testnet reusing the
// id, a misconfigured node) fails closed. Add a chain only after its contracts and RPC behaviour were
// verified; nothing here is a claim that other chains work.
import type { Hex } from 'viem';

export interface ChainEntry {
  chainId: number;
  name: string;
  /** keccak hash of block 0, read from the chain itself (source and date below). */
  genesisHash: Hex;
  /** Default public JSON-RPC: read/estimate/fork use only, never broadcast. */
  publicRpc: string;
}

export const CHAINS: Record<number, ChainEntry> = {
  // genesis: eth_getBlockByNumber("0x0") on https://rpc.plasma.to, 2026-10-31T12:09Z.
  9745: { chainId: 9745, name: 'Plasma', genesisHash: '0x0d0ccca452bdb244100115e37de64ca640a255585d5a94df5610052a6dada558', publicRpc: 'https://rpc.plasma.to' },
};

export function chainEntry(chainId: number): ChainEntry | null {
  return CHAINS[chainId] ?? null;
}
