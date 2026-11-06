// SYNTHETIC addresses for unit tests: none of these is a real user's wallet, recipient or gas wallet.
import { getAddress, type Address, type Hex } from 'viem';
import { SUPPORTED } from '../../src/config/registry';

export const DEP = SUPPORTED[0]!;
export const USDT0 = DEP.assets.find((a) => a.symbol === 'USDT0')!.id as Address;
export const SRC_A: Address = getAddress('0x5a00000000000000000000000000000000000a01');
export const SRC_B: Address = getAddress('0x5a00000000000000000000000000000000000b02');
export const RCPT: Address = getAddress('0x5a000000000000000000000000000000000c0c03');
export const GAS: Address = getAddress('0x5a0000000000000000000000000000000006a504');
/** A 64-byte synthetic P-256 owner (x ‖ y of a throwaway key) and a 32-byte address owner. */
export const ADDR_OWNER: Hex = `0x${'0'.repeat(24)}${RCPT.slice(2).toLowerCase()}`;
