// The on-chain ladder and the sound cue for each Track answer (src/ui/steps/TrackStep.tsx), and the pairing
// code normaliser (src/ui/PairPanel.tsx). UX behaviour 4/8: a hash alone, a failure or an unknown never
// reaches a success rung or the "done" cue.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '../../../src/ui/i18n';
import { Ladder, type LadderAt } from '../../../src/ui/ux';
import { cueFor, ladderAt } from '../../../src/ui/steps/TrackStep';
import { pairingCode } from '../../../src/ui/PairPanel';

describe('ladder and cue per Track state', () => {
  it.each([
    ['pending', true, 'sent', null],
    ['pending', false, 'unknown', null],
    ['confirmed', true, 'block', 'done'],
    ['final', true, 'final', 'done'],
    ['inner-failed', true, 'failed', 'attention'],
    ['reverted', true, 'failed', 'attention'],
    ['unknown', false, 'unknown', 'attention'],
    ['reorged', true, 'unknown', 'attention'],
    ['mismatch', true, 'unknown', 'attention'],
    ['loading', false, 'unknown', null],
  ] as const)('%s (tx known: %s) → ladder %s, cue %s', (state, tx, at, cue) => {
    expect(ladderAt(state, tx)).toBe(at);
    expect(cueFor(state)).toBe(cue);
  });
  it('regression: unknown while the event scan is still running → no cue (a just-sent transfer reads like this briefly)', () => {
    expect(cueFor('unknown', { cursor: '120', head: '130', complete: false })).toBeNull();
  });
  it('unknown after a finished scan, or when the RPC refused the scan → attention', () => {
    expect(cueFor('unknown', { cursor: '131', head: '130', complete: true })).toBe('attention');
    expect(cueFor('unknown', null)).toBe('attention');
  });
});

describe('pairing code', () => {
  it.each([
    ['ABCD-1234', 'ABCD-1234'],
    [' abcd1234 ', 'ABCD-1234'],
    ['k7p2-x9q4', 'K7P2-X9Q4'],
  ])('%j → %s', (raw, want) => expect(pairingCode(raw)).toBe(want));
  it.each(['', 'ABC-1234', 'ABCD-12345', 'ABCD 1234', 'http://127.0.0.1:4171/'])('%j → null', (raw) => expect(pairingCode(raw)).toBeNull());
});

describe('ladder as rendered', () => {
  const html = (at: LadderAt) => renderToStaticMarkup(createElement(LangProvider, null, createElement(Ladder, { at })));
  const states = (h: string) => [...h.matchAll(/data-state="([a-z]+)"/g)].map((m) => m[1]);

  it.each([
    ['failed', ['past', 'failed', 'later'], '✗'],
    ['unknown', ['later', 'later', 'later', 'unknown'], 'Not known yet'],
  ] as const)('%s → rungs %j, no ✓ and no "done" rung (the only one styled in the success colour)', (at, want, shown) => {
    const h = html(at);
    expect(states(h)).toEqual(want);
    expect(h).not.toContain('✓');
    expect(h).toContain(shown);
  });

  it.each([
    ['sent', ['past', 'now', 'later']],
    ['block', ['done', 'done', 'now']],
    ['final', ['done', 'done', 'done']],
  ] as const)('%s → rungs %j', (at, want) => expect(states(html(at))).toEqual(want));
});
