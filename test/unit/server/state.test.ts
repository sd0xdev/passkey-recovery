import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { deploymentVerdict, type StateView } from '../../../server/state';
import { ADDR_OWNER, DEP } from '../../fixtures/accounts';

const PK: Hex = `0x${'ab'.repeat(64)}`;
const full = (o: Partial<StateView> = {}): StateView => ({
  infraCode: { entryPoint: DEP.codeHash.entryPoint, singletonFactory: DEP.codeHash.singletonFactory, implementation: DEP.codeHash.implementation, factory: DEP.codeHash.factory },
  accountCode: DEP.codeHash.walletProxy,
  accountImplementation: DEP.implementation,
  owners: [{ index: 0, bytes: PK }, { index: 1, bytes: ADDR_OWNER }],
  nextOwnerIndex: 2n,
  removedOwnersCount: 0n,
  ...o,
});
const codes = (v: StateView) => deploymentVerdict(DEP, v).stops.map((s) => s.code);

describe('deploymentVerdict', () => {
  it('everything present and matching → complete, no stops', () => {
    const v = deploymentVerdict(DEP, full(), [PK, ADDR_OWNER]);
    expect(v.complete).toBe(true);
    expect(v.stops).toEqual([]);
  });
  it('nothing deployed yet → absent targets, not complete, no stop', () => {
    const v = deploymentVerdict(DEP, full({ infraCode: { ...full().infraCode, implementation: null, factory: null }, accountCode: null }));
    expect(v.targets).toEqual({ implementation: 'absent', factory: 'absent', account: 'absent' });
    expect(v.complete).toBe(false);
    expect(v.stops).toEqual([]);
  });
  it.each([
    ['implementation', { infraCode: { ...full().infraCode, implementation: `0x${'00'.repeat(32)}` as Hex } }, 'unknown-code'],
    ['factory', { infraCode: { ...full().infraCode, factory: `0x${'11'.repeat(32)}` as Hex } }, 'unknown-code'],
    ['account', { accountCode: `0x${'22'.repeat(32)}` as Hex }, 'unknown-code'],
    ['EntryPoint', { infraCode: { ...full().infraCode, entryPoint: null } }, 'infra-missing'],
  ] as const)('unexpected %s code → hard stop %s', (_n, o, code) => {
    expect(codes(full(o as Partial<StateView>))).toContain(code);
  });
  it('upgraded implementation slot → wrong-implementation stop', () => {
    expect(codes(full({ accountImplementation: '0x0000000000000000000000000000000000000bad' }))).toContain('wrong-implementation');
  });
  it('owners differing from the derivation evidence → owner-mismatch; same owners pass (both directions)', () => {
    expect(deploymentVerdict(DEP, full(), [ADDR_OWNER, PK]).stops.map((s) => s.code)).toContain('owner-mismatch');
    expect(deploymentVerdict(DEP, full(), [PK, ADDR_OWNER]).stops).toEqual([]);
  });
  it('a removed owner slot counts as an owner change versus the evidence', () => {
    expect(deploymentVerdict(DEP, full({ removedOwnersCount: 1n, owners: [{ index: 0, bytes: PK }, { index: 1, bytes: '0x' }] }), [PK, ADDR_OWNER]).complete).toBe(false);
  });
  it('more owner slots than supported → too-many-owners; exactly the maximum passes', () => {
    expect(codes(full({ nextOwnerIndex: BigInt(DEP.maxOwners + 1) }))).toContain('too-many-owners');
    expect(codes(full({ nextOwnerIndex: BigInt(DEP.maxOwners) }))).not.toContain('too-many-owners');
  });
  it('unreadable owners → owners-unreadable, not complete', () => {
    const v = deploymentVerdict(DEP, full({ owners: null }));
    expect(v.complete).toBe(false);
    expect(v.stops.map((s) => s.code)).toContain('owners-unreadable');
  });
});
