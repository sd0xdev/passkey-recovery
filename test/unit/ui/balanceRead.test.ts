// PM-06 (design 6-recovery-atlas §10.7): when Move's balances are read again, which answer is applied, and
// when an amount is over the fresh balance.
import { describe, expect, it } from 'vitest';
import { answerApplies, coverBlock, landedAfter, overBalance, shownBalanceRead, type BalanceAsk } from '../../../src/ui/balanceRead';
import type { StoredTrack } from '../../../src/ui/trackingStore';
import type { TrackResult } from '../../../src/ui/types';

const MINE = `0x${'a1'.repeat(32)}`;
const OTHER = `0x${'b2'.repeat(32)}`;
const op = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const track = (n: number, sender = MINE, txHash: string | null = null) => ({ record: { userOpHash: op(n), senderHash: sender, txHash }, symbol: 'USDT0', decimals: 6, savedAt: 0, abandoned: false, scanCursor: null }) as unknown as StoredTrack;
const key = (n: number, txHash = '') => `${op(n)}:${txHash}`;
const base: TrackResult = { state: 'pending', detail: '', txHash: null, block: null, confirmations: null, finalityDepth: 64, scan: null, receipt: null, nonceNow: null, nonceFinal: null };
const res = (o: Partial<TrackResult>): TrackResult => ({ ...base, ...o });

describe('landedAfter', () => {
  it('a success of this wallet in a later block than the read → one read asked for it', () => {
    expect(landedAfter([track(4)], { [key(4)]: res({ state: 'confirmed', block: '120' }) }, MINE, '100', new Set())).toEqual([`${key(4)}@120`]);
  });
  it('failures in a block move the nonce too (inner-failed, reverted, final) → read again', () => {
    const tracks = [track(1), track(2), track(3)];
    const results = { [key(1)]: res({ state: 'inner-failed', block: '101' }), [key(2)]: res({ state: 'reverted', block: '102' }), [key(3)]: res({ state: 'final', block: '103' }) };
    expect(landedAfter(tracks, results, MINE, '100', new Set())).toEqual([`${key(1)}@101`, `${key(2)}@102`, `${key(3)}@103`]);
  });
  it('its block reported replaced (reorged) → one read, even when the read is from after that block', () => {
    const results = { [key(4)]: res({ state: 'reorged', block: '100' }) };
    expect(landedAfter([track(4)], results, MINE, '105', new Set())).toEqual([`${key(4)}@reorged:100`]);
    expect(landedAfter([track(4)], results, MINE, '105', new Set([`${key(4)}@100`]))).toEqual([`${key(4)}@reorged:100`]);
  });
  it('the same replacement already asked → nothing; replaced again in another block → asks again; another wallet → nothing', () => {
    const results = { [key(4)]: res({ state: 'reorged', block: '100' }) };
    expect(landedAfter([track(4)], results, MINE, '105', new Set([`${key(4)}@reorged:100`]))).toEqual([]);
    expect(landedAfter([track(4)], { [key(4)]: res({ state: 'reorged', block: '120' }) }, MINE, '105', new Set([`${key(4)}@reorged:100`]))).toEqual([`${key(4)}@reorged:120`]);
    expect(landedAfter([track(4, OTHER)], results, MINE, '105', new Set())).toEqual([]);
    expect(landedAfter([track(4)], { [key(4)]: res({ state: 'reorged', block: null }) }, MINE, '105', new Set())).toEqual([]);
  });
  it('not in a block yet, at or before the read, already asked, or another wallet → nothing', () => {
    const tracks = [track(1), track(2), track(3), track(4, OTHER), track(5)];
    const results = { [key(1)]: res({ state: 'pending' }), [key(2)]: res({ state: 'confirmed', block: '100' }), [key(3)]: res({ state: 'confirmed', block: '150' }), [key(4)]: res({ state: 'confirmed', block: '150' }), [key(5)]: res({ state: 'unknown', block: '150' }) };
    expect(landedAfter(tracks, results, MINE, '100', new Set([`${key(3)}@150`]))).toEqual([]);
  });
  it('no account or no read yet → nothing (empty edge)', () => {
    const results = { [key(4)]: res({ state: 'confirmed', block: '120' }) };
    expect(landedAfter([track(4)], results, null, '100', new Set())).toEqual([]);
    expect(landedAfter([track(4)], results, MINE, null, new Set())).toEqual([]);
    expect(landedAfter([], {}, MINE, '100', new Set())).toEqual([]);
  });
  it('the record keyed by its found tx hash is the one read', () => {
    const tx = `0x${'c3'.repeat(32)}`;
    expect(landedAfter([track(6, MINE, tx)], { [key(6, tx)]: res({ state: 'confirmed', block: '200' }) }, MINE, '199', new Set())).toEqual([`${key(6, tx)}@200`]);
  });
  it('a seen op turning up in a later block (a shallow reorg) → asked for again; the block already read → not', () => {
    const results = { [key(4)]: res({ state: 'confirmed', block: '130' }) };
    expect(landedAfter([track(4)], results, MINE, '122', new Set([`${key(4)}@120`]))).toEqual([`${key(4)}@130`]);
    expect(landedAfter([track(4)], results, MINE, '122', new Set([`${key(4)}@130`]))).toEqual([]);
  });
});

describe('shownBalanceRead', () => {
  const behind = (got: string, need: string) => `behind ${got}<${need}`;
  const fresh = { state: 'fresh' as const, error: null };
  it('a fresh read older than the latest landing of this wallet (whichever answered last) → shown as failed, with why', () => {
    expect(shownBalanceRead(fresh, '120', '130', behind)).toEqual({ state: 'failed', error: 'behind 120<130' });
  });
  it('at or after that block, or nothing landed → shown as it is', () => {
    expect(shownBalanceRead(fresh, '130', '130', behind)).toBe(fresh);
    expect(shownBalanceRead(fresh, '131', '130', behind)).toBe(fresh);
    expect(shownBalanceRead(fresh, '120', null, behind)).toBe(fresh);
  });
  it('reading or failed reads are never relabelled (edge)', () => {
    const reading = { state: 'reading' as const, error: null };
    const failed = { state: 'failed' as const, error: 'upstream' };
    expect(shownBalanceRead(reading, '120', '130', behind)).toBe(reading);
    expect(shownBalanceRead(failed, '120', '130', behind)).toBe(failed);
  });
});

describe('coverBlock', () => {
  it('the latest block holding an op of this wallet, success or failure → a read older than it is not the latest', () => {
    const tracks = [track(1), track(2), track(3)];
    const results = { [key(1)]: res({ state: 'confirmed', block: '120' }), [key(2)]: res({ state: 'inner-failed', block: '135' }), [key(3)]: res({ state: 'reverted', block: '9' }) };
    expect(coverBlock(tracks, results, MINE)).toBe('135');
  });
  it('ops not in a block, of another wallet, or without an answer → not counted', () => {
    const tracks = [track(1), track(2, OTHER), track(3), track(4)];
    const results = { [key(1)]: res({ state: 'pending' }), [key(2)]: res({ state: 'confirmed', block: '500' }), [key(3)]: res({ state: 'unknown', block: '400' }) };
    expect(coverBlock(tracks, results, MINE)).toBeNull();
  });
  it('no account or no records → null (empty edge)', () => {
    expect(coverBlock([track(1)], { [key(1)]: res({ state: 'confirmed', block: '120' }) }, null)).toBeNull();
    expect(coverBlock([], {}, MINE)).toBeNull();
  });
});

describe('answerApplies', () => {
  const asked: BalanceAsk = { seq: 3, epoch: 2, conn: 1, account: '0xAbC0000000000000000000000000000000000001' };
  it('the same request, endpoint, connection and wallet (address case aside) → applied', () => {
    expect(answerApplies(asked, { ...asked, account: asked.account.toLowerCase() })).toBe(true);
  });
  it('a newer request, RPC epoch, connection or another wallet → dropped', () => {
    expect(answerApplies(asked, { ...asked, seq: 4 })).toBe(false);
    expect(answerApplies(asked, { ...asked, epoch: 3 })).toBe(false);
    expect(answerApplies(asked, { ...asked, conn: 2 })).toBe(false);
    expect(answerApplies(asked, { ...asked, account: '0xAbC0000000000000000000000000000000000002' })).toBe(false);
  });
});

describe('overBalance', () => {
  it('more than the balance → over; equal or less → not', () => {
    expect(overBalance('1.000001', 6, 1_000_000n)).toBe(true);
    expect(overBalance('1', 6, 1_000_000n)).toBe(false);
    expect(overBalance('0.5', 6, 1_000_000n)).toBe(false);
  });
  it('zero balance: any positive amount is over; zero is not', () => {
    expect(overBalance('0.000001', 6, 0n)).toBe(true);
    expect(overBalance('0', 6, 0n)).toBe(false);
  });
  it('empty, malformed, too many decimals or no balance known → not judged here', () => {
    for (const a of ['', ' ', 'abc', '-1', '1e3', '1.0000001']) expect(overBalance(a, 6, 1n)).toBe(false);
    expect(overBalance('5', 6, null)).toBe(false);
  });
  it('18 decimals, large values and surrounding spaces are exact', () => {
    expect(overBalance(' 1681.000000000000000001 ', 18, 1681n * 10n ** 18n)).toBe(true);
    expect(overBalance('1681.', 18, 1681n * 10n ** 18n)).toBe(false);
  });
});
