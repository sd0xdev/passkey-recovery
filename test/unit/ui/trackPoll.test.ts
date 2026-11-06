// A Track row keeps polling until its answer can no longer change. A revert or inner failure above the
// finality depth can still be reorged away; an outer revert also leaves the signed op executable by
// another transaction until the account's nonce moves past it.
import { describe, expect, it } from 'vitest';
import type { TrackResult } from '../../../src/ui/types';
import { beginSending, GATE_NOTE, gatesOnlyUnreadable, isSending, newIntentGate, nonceAgrees, sameTrackAnswer, trackSettled } from '../../../src/ui/trackPoll';

// nonceFinal: the account's nonce at the finality depth below the head.
const at = (state: string, confirmations: string | null, nonceFinal: string | null = '6', complete = true) =>
  ({ state, confirmations, finalityDepth: 12, nonceFinal, scan: { cursor: '60001', head: '60000', complete } }) as Parameters<typeof trackSettled>[0];
const OP_NONCE = '5';

describe('trackSettled', () => {
  it('final settles; pending, unknown, confirmed, reorged and mismatch never do', () => {
    expect(trackSettled(at('final', '12'), OP_NONCE)).toBe(true);
    // (unknown with the nonce still the op's here; its superseded case is below)
    for (const s of ['pending', 'unknown', 'confirmed', 'reorged', 'mismatch']) expect(trackSettled(at(s, '40', '5'), OP_NONCE)).toBe(false);
    for (const s of ['pending', 'confirmed', 'reorged', 'mismatch']) expect(trackSettled(at(s, '40', '6'), OP_NONCE)).toBe(false);
  });

  it('inner-failed settles only at the finality depth (the op ran; its nonce is used)', () => {
    expect(trackSettled(at('inner-failed', '11'), OP_NONCE)).toBe(false);
    expect(trackSettled(at('inner-failed', '12', null), OP_NONCE)).toBe(true);
  });

  it('an outer revert settles only at the finality depth AND once the nonce moved past the op', () => {
    expect(trackSettled(at('reverted', '1'), OP_NONCE)).toBe(false);
    expect(trackSettled(at('reverted', '12', '5'), OP_NONCE)).toBe(false);
    expect(trackSettled(at('reverted', '12', null), OP_NONCE)).toBe(false);
    expect(trackSettled(at('reverted', '13', '6'), OP_NONCE)).toBe(true);
  });

  it('a deep revert whose nonce moved only in shallow blocks keeps polling: a short reorg can give the nonce back', () => {
    // Reverted at block 100 (901 confirmations); another op used nonce 5 only at the head. At the depth the nonce is still 5.
    const r = { ...at('reverted', '901', '5'), nonceNow: '6' } as Parameters<typeof trackSettled>[0];
    expect(trackSettled(r, OP_NONCE)).toBe(false);
    expect(trackSettled({ ...r, nonceFinal: '6' }, OP_NONCE)).toBe(true);
  });

  it('a deep revert with the nonce moved on still polls while the event search past it is incomplete', () => {
    // Reported revert at block 1; the same op may have succeeded in another tx beyond the first 50,000 blocks.
    expect(trackSettled(at('reverted', '59999', '6', false), OP_NONCE)).toBe(false);
    expect(trackSettled(at('reverted', '59999', '6', true), OP_NONCE)).toBe(true);
    expect(trackSettled({ ...at('reverted', '59999', '6'), scan: null }, OP_NONCE)).toBe(false);
  });

  it('unknown settles only as superseded: complete scan AND the nonce moved at the finality depth', () => {
    expect(trackSettled(at('unknown', null, '6', true), OP_NONCE)).toBe(true);
    expect(trackSettled(at('unknown', null, '5', true), OP_NONCE)).toBe(false); // nonce not used at depth yet
    expect(trackSettled(at('unknown', null, '6', false), OP_NONCE)).toBe(false); // the scan may still find it
    expect(trackSettled(at('unknown', null, null, true), OP_NONCE)).toBe(false);
    expect(trackSettled({ ...at('unknown', null, '6'), scan: null }, OP_NONCE)).toBe(false); // event search refused
  });

  it('a failure with no confirmation count (null) keeps polling', () => {
    expect(trackSettled(at('inner-failed', null), OP_NONCE)).toBe(false);
  });
});

describe('newIntentGate (architecture §5: before a new intent)', () => {
  const r = (state: string, nonceNow: string | null, complete: boolean | null) =>
    ({ state, nonceNow, scan: complete === null ? null : { cursor: '1', head: '1', complete } }) as Parameters<typeof newIntentGate>[0];

  it('no answer yet, or an unreadable nonce → unknown (nothing new opens)', () => {
    expect(newIntentGate(undefined, OP_NONCE)).toBe('unknown');
    expect(newIntentGate(r('unknown', null, true), OP_NONCE)).toBe('unknown');
  });

  it('live nonce still the op’s → same-nonce, whatever the scan', () => {
    expect(newIntentGate(r('unknown', '5', false), OP_NONCE)).toBe('same-nonce');
    expect(newIntentGate(r('pending', '5', true), OP_NONCE)).toBe('same-nonce');
  });

  it('the op’s event was found (success or inner failure) → executed', () => {
    for (const s of ['confirmed', 'final', 'inner-failed']) expect(newIntentGate(r(s, '6', false), OP_NONCE)).toBe('executed');
  });

  it('nonce moved past the op: complete scan → nonce-used; incomplete or absent scan → unknown', () => {
    expect(newIntentGate(r('unknown', '6', true), OP_NONCE)).toBe('nonce-used');
    expect(newIntentGate(r('unknown', '6', false), OP_NONCE)).toBe('unknown');
    expect(newIntentGate(r('reorged', '6', null), OP_NONCE)).toBe('unknown');
  });

  it('every gate has its own note; only same-nonce carries the same-nonce assurance', () => {
    expect(new Set(Object.values(GATE_NOTE)).size).toBe(4);
    expect(Object.entries(GATE_NOTE).filter(([, k]) => k === 'abandoned.sameNonce').map(([g]) => g)).toEqual(['same-nonce']);
  });
});

describe('nonceAgrees (a plan against the gates it was opened under)', () => {
  it('same-nonce record at 7 and a plan at 7 → agrees; a plan at 8 (the earlier op moved it) → refused', () => {
    expect(nonceAgrees('7', [['same-nonce', '7']])).toBe(true);
    expect(nonceAgrees('8', [['same-nonce', '7']])).toBe(false);
  });
  it('executed or nonce-used at 7 → only a plan past 7 agrees', () => {
    expect(nonceAgrees('8', [['executed', '7'], ['nonce-used', '6']])).toBe(true);
    expect(nonceAgrees('7', [['executed', '7']])).toBe(false);
    expect(nonceAgrees('7', [['nonce-used', '7']])).toBe(false);
  });
  it('an unknown record agrees with nothing; no earlier records → agrees', () => {
    expect(nonceAgrees('7', [['unknown', '7']])).toBe(false);
    expect(nonceAgrees('0', [])).toBe(true);
  });
  it('one disagreeing record among agreeing ones → refused', () => {
    expect(nonceAgrees('9', [['executed', '3'], ['same-nonce', '8']])).toBe(false);
  });
});

describe('beginSending / isSending (a send this page has not had answered yet)', () => {
  const h = `0x${'ab'.repeat(32)}`;
  it('is under way from begin until its end, whatever the hash case', () => {
    expect(isSending(h)).toBe(false);
    const end = beginSending(h.toUpperCase().replace('0X', '0x'));
    expect(isSending(h)).toBe(true);
    end();
    expect(isSending(h)).toBe(false);
  });
  it('ending twice is a no-op and does not end another send of the same op', () => {
    const a = beginSending(h);
    const b = beginSending(h);
    a();
    a();
    expect(isSending(h)).toBe(true);
    b();
    expect(isSending(h)).toBe(false);
  });
  it('an empty or unrelated hash is never under way', () => {
    const end = beginSending(h);
    expect(isSending('')).toBe(false);
    expect(isSending(`0x${'cd'.repeat(32)}`)).toBe(false);
    end();
  });
});

describe('gatesOnlyUnreadable (a signed plan is held, not voided, while an earlier record cannot be read)', () => {
  const then = [
    ['0xaaa', 'same-nonce'],
    ['0xbbb', 'executed'],
  ] as const;

  it('the same gates again → not a hold (nothing changed)', () => {
    expect(gatesOnlyUnreadable(then, then)).toBe(true);
  });

  it('one or every earlier record dropping to unknown → held', () => {
    expect(gatesOnlyUnreadable(then, [['0xaaa', 'unknown'], ['0xbbb', 'executed']])).toBe(true);
    expect(gatesOnlyUnreadable(then, [['0xaaa', 'unknown'], ['0xbbb', 'unknown']])).toBe(true);
  });

  it('a gate moving to another verified state → a real change, not a hold', () => {
    expect(gatesOnlyUnreadable(then, [['0xaaa', 'executed'], ['0xbbb', 'executed']])).toBe(false);
    expect(gatesOnlyUnreadable(then, [['0xaaa', 'nonce-used'], ['0xbbb', 'unknown']])).toBe(false);
  });

  it('a record gone, added or swapped → a real change', () => {
    expect(gatesOnlyUnreadable(then, [['0xaaa', 'same-nonce']])).toBe(false);
    expect(gatesOnlyUnreadable(then, [...then, ['0xccc', 'unknown']])).toBe(false);
    expect(gatesOnlyUnreadable(then, [['0xaaa', 'same-nonce'], ['0xccc', 'unknown']])).toBe(false);
  });

  it('no earlier records → nothing to hold on (and nothing changed)', () => {
    expect(gatesOnlyUnreadable([], [])).toBe(true);
    expect(gatesOnlyUnreadable([], [['0xaaa', 'unknown']])).toBe(false);
  });
});

describe('sameTrackAnswer (what a new Track answer must change to be taken)', () => {
  const r = { ...at('confirmed', '1'), block: '100', txHash: `0x${'11'.repeat(32)}`, detail: '1 confirmation(s)' } as TrackResult;
  it('the same answer again → unchanged', () => {
    expect(sameTrackAnswer(r, { ...r })).toBe(true);
  });
  it('a shallow reorg moves the transaction to a later block, same state and depth → changed', () => {
    expect(sameTrackAnswer(r, { ...r, block: '120' })).toBe(false);
  });
  it('state, depth, nonce or scan completeness moving → changed', () => {
    expect(sameTrackAnswer(r, { ...r, state: 'final' })).toBe(false);
    expect(sameTrackAnswer(r, { ...r, confirmations: '2' })).toBe(false);
    expect(sameTrackAnswer(r, { ...r, nonceFinal: '7' })).toBe(false);
    expect(sameTrackAnswer(r, { ...r, scan: null })).toBe(false);
  });
});
