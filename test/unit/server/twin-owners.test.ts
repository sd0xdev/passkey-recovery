// The twin wallet used to measure validation gas copies the account's owner list. Coinbase Smart Wallet
// v1.1 refuses a repeated owner (AlreadyOwner), so every removed slot needs its own filler — one shared
// filler made any wallet with two removed owners impossible to preview.
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import type { OwnerSlot } from '../../../server/reader';
import { twinOwners } from '../../../server/sim';

const PASSKEY = ('0x' + 'ab'.repeat(64)) as Hex;
const TWIN = ('0x' + 'cd'.repeat(64)) as Hex;
const EOA_OWNER = ('0x' + '0'.repeat(24) + '7e57a11ce0000000000000000000000000000001') as Hex;
const removed = (index: number): OwnerSlot => ({ index, bytes: '0x' });

describe('twinOwners', () => {
  it('[removed, removed, passkey] → two distinct fillers, the twin key at the signing index', () => {
    const list = twinOwners([removed(0), removed(1), { index: 2, bytes: PASSKEY }], 2, TWIN);
    expect(list).toHaveLength(3);
    expect(list[2]).toBe(TWIN);
    expect(new Set(list).size).toBe(3);
    for (const f of list.slice(0, 2)) expect(f).toMatch(/^0x0{24}[0-9a-f]{40}$/); // address-shaped
  });

  it('a filler never equals an owner the account keeps', () => {
    const first = twinOwners([removed(0), { index: 1, bytes: PASSKEY }], 1, TWIN)[0]!;
    const list = twinOwners([{ index: 0, bytes: first }, removed(1), removed(2), { index: 3, bytes: PASSKEY }], 3, TWIN);
    expect(new Set(list).size).toBe(4);
    expect(list[0]).toBe(first);
  });

  it('no removed slot → the list is the account’s, with only the signing slot swapped', () => {
    expect(twinOwners([{ index: 0, bytes: EOA_OWNER }, { index: 1, bytes: PASSKEY }], 1, TWIN)).toEqual([EOA_OWNER, TWIN]);
  });
});
