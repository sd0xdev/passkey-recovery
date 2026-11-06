// SYNTHETIC stand-in for a registry token on the offline testchain: a hand-assembled ERC-20 subset
// (balanceOf, transfer with a Transfer event, decimals) installed with anvil_setCode at the token's
// registry address. Balances live at storage slot = holder address, so a test funds a holder with one
// anvil_setStorageAt. No compiler, no network; this is test-only bytecode, never shipped.
import { pad, toHex, toEventSelector, type Address, type Hex } from 'viem';

type Item = string | { label: string } | { ref: string };

const OP: Record<string, number> = {
  STOP: 0x00, ADD: 0x01, SUB: 0x03, LT: 0x10, EQ: 0x14, SHR: 0x1c, CALLER: 0x33, CALLDATALOAD: 0x35,
  MSTORE: 0x52, SLOAD: 0x54, SSTORE: 0x55, JUMPI: 0x57, JUMPDEST: 0x5b, DUP1: 0x80, DUP2: 0x81,
  LOG3: 0xa3, RETURN: 0xf3, REVERT: 0xfd,
};

function assemble(items: Item[]): Hex {
  // Two passes: label offsets first (every ref is a PUSH2), then bytes.
  const labels = new Map<string, number>();
  const size = (it: Item) => (typeof it === 'string' ? (it.startsWith('0x') ? 1 + (it.length - 2) / 2 : 1) : 'label' in it ? 1 : 3);
  let pc = 0;
  for (const it of items) {
    if (typeof it === 'object' && 'label' in it) labels.set(it.label, pc);
    pc += size(it);
  }
  const out: number[] = [];
  for (const it of items) {
    if (typeof it === 'string' && it.startsWith('0x')) {
      const n = (it.length - 2) / 2;
      out.push(0x5f + n, ...Buffer.from(it.slice(2), 'hex'));
    } else if (typeof it === 'string') {
      const o = OP[it];
      if (o === undefined) throw new Error(`unknown opcode ${it}`);
      out.push(o);
    } else if ('label' in it) out.push(OP.JUMPDEST!);
    else {
      const at = labels.get(it.ref);
      if (at === undefined) throw new Error(`unknown label ${it.ref}`);
      out.push(0x61, at >> 8, at & 0xff);
    }
  }
  return toHex(Uint8Array.from(out));
}

const TRANSFER_TOPIC = toEventSelector('Transfer(address,address,uint256)');

export function miniTokenCode(decimals: number): Hex {
  const ret32 = ['0x00', 'MSTORE', '0x20', '0x00', 'RETURN'];
  return assemble([
    '0x00', 'CALLDATALOAD', '0xe0', 'SHR',
    'DUP1', '0x70a08231', 'EQ', { ref: 'balanceOf' }, 'JUMPI',
    'DUP1', '0xa9059cbb', 'EQ', { ref: 'transfer' }, 'JUMPI',
    'DUP1', '0x313ce567', 'EQ', { ref: 'decimals' }, 'JUMPI',
    { label: 'fail' }, '0x00', 'DUP1', 'REVERT',
    { label: 'balanceOf' }, '0x04', 'CALLDATALOAD', 'SLOAD', ...ret32,
    { label: 'decimals' }, toHex(decimals, { size: 1 }), ...ret32,
    { label: 'transfer' },
    '0x24', 'CALLDATALOAD', 'CALLER', 'SLOAD', // amount, balance
    'DUP2', 'DUP2', 'LT', { ref: 'fail' }, 'JUMPI', // balance < amount → revert
    'SUB', 'CALLER', 'SSTORE', // balance − amount
    '0x24', 'CALLDATALOAD', '0x04', 'CALLDATALOAD', 'SLOAD', 'ADD', '0x04', 'CALLDATALOAD', 'SSTORE',
    '0x24', 'CALLDATALOAD', '0x00', 'MSTORE',
    '0x04', 'CALLDATALOAD', 'CALLER', TRANSFER_TOPIC, '0x20', '0x00', 'LOG3',
    '0x01', ...ret32,
  ]);
}

/** anvil_setStorageAt params that set `holder`'s balance. */
export function miniTokenBalanceSlot(holder: Address, amount: bigint): [Hex, Hex] {
  return [pad(holder), pad(toHex(amount))];
}
