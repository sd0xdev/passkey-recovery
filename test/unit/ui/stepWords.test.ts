// Step header words (design guidelines §13.4, UX-1): from the latest answer per record and the open plan.
import { describe, expect, it } from 'vitest';
import { checkWord, deployWord, moveWord, trackWord } from '../../../src/ui/stepWords';
import type { TrackResult } from '../../../src/ui/types';

const base: TrackResult = { state: 'pending', detail: '', txHash: null, block: null, confirmations: null, finalityDepth: 64, scan: null, receipt: null, nonceNow: null, nonceFinal: null };
const r = (o: Partial<TrackResult>): TrackResult => ({ ...base, ...o });
const final = r({ state: 'final', confirmations: '80' });
const deepRevert = r({ state: 'reverted', confirmations: '80', nonceFinal: '8', scan: { cursor: '1', head: '1', complete: true } });
const superseded = r({ state: 'unknown', nonceFinal: '8', scan: { cursor: '1', head: '1', complete: true } });

describe('trackWord', () => {
  it('the only transfer is final → all final (not "in progress")', () => {
    expect(trackWord([{ result: final, nonce: '7' }])).toBe('final');
  });
  it('any record unanswered or not settled → in progress', () => {
    expect(trackWord([{ result: final, nonce: '7' }, { result: undefined, nonce: '8' }])).toBe('progress');
    expect(trackWord([{ result: final, nonce: '7' }, { result: r({ state: 'confirmed', confirmations: '3' }), nonceFinal: null } as never])).toBe('progress');
    expect(trackWord([{ result: r({ state: 'reverted', confirmations: '2' }), nonce: '7' }])).toBe('progress');
  });
  it('settled with a failure or a superseded op → needs attention', () => {
    expect(trackWord([{ result: final, nonce: '6' }, { result: deepRevert, nonce: '7' }])).toBe('attention');
    expect(trackWord([{ result: superseded, nonce: '7' }])).toBe('attention');
  });
  it('PM-09: the transfer being sent has no record yet, or no settled answer → in progress, whatever earlier records say', () => {
    const earlier = { result: final, nonce: '3', hash: '0xaa' };
    expect(trackWord([earlier])).toBe('final');
    expect(trackWord([earlier], '0xbb')).toBe('progress');
    expect(trackWord([earlier, { result: undefined, nonce: '4', hash: '0xbb' }], '0xbb')).toBe('progress');
    expect(trackWord([earlier, { result: r({ state: 'unknown' }), nonce: '4', hash: '0xbb' }], '0xbb')).toBe('progress');
  });
  it('PM-09: the transfer being sent is final too → all final', () => {
    expect(trackWord([{ result: final, nonce: '3', hash: '0xaa' }, { result: final, nonce: '4', hash: '0xbb' }], '0xbb')).toBe('final');
  });
});

describe('moveWord', () => {
  const sim = (success: boolean) => ({ success, problems: [], forkBlock: '1' }) as never;
  it('no plan, or a discarded one → choose a transfer', () => {
    expect(moveWord(null)).toBe('choose');
    expect(moveWord({ state: 'discarded', signedSim: null } as never)).toBe('choose');
  });
  it('"ready" only when signed and the signed transfer simulated successfully', () => {
    expect(moveWord({ state: 'signed', signedSim: sim(true) } as never)).toBe('ready');
    expect(moveWord({ state: 'signed', signedSim: sim(false) } as never)).toBe('progress');
    expect(moveWord({ state: 'previewed', signedSim: null } as never)).toBe('progress');
    expect(moveWord({ state: 'sim-failed', signedSim: sim(false) } as never)).toBe('progress');
  });
  it('sent → sent', () => {
    expect(moveWord({ state: 'sent', signedSim: sim(true) } as never)).toBe('sent');
  });
});

describe('checkWord (PM finding 3: never "in progress" unless it reads)', () => {
  it('no runner answers → needs the runner, even mid-read or with an old result on screen', () => {
    expect(checkWord({ connected: false, reading: false, hasResult: false })).toBe('needsRunner');
    expect(checkWord({ connected: false, reading: true, hasResult: true })).toBe('needsRunner');
  });
  it('connected and reading → reading the chain', () => {
    expect(checkWord({ connected: true, reading: true, hasResult: false })).toBe('reading');
    expect(checkWord({ connected: true, reading: true, hasResult: true })).toBe('reading');
  });
  it('connected, idle, empty account → start here; with an answer on screen → see the result', () => {
    expect(checkWord({ connected: true, reading: false, hasResult: false })).toBe('start');
    expect(checkWord({ connected: true, reading: false, hasResult: true })).toBe('result');
  });
});

describe('deployWord (PM-01: busy words only while something runs)', () => {
  const base = { gasReady: true, planning: false, run: 'idle' as const, settled: false, settledBad: false };
  it('nothing sent, gas payer ready → your turn; no gas payer → choose one', () => {
    expect(deployWord(base)).toBe('yourTurn');
    expect(deployWord({ ...base, gasReady: false })).toBe('needsGas');
  });
  it('planning → planning; handed to the gas payer → waiting for it; sent, unsettled → waiting for the block', () => {
    expect(deployWord({ ...base, planning: true })).toBe('planning');
    expect(deployWord({ ...base, run: 'awaiting' })).toBe('gasPayer');
    expect(deployWord({ ...base, run: 'sent' })).toBe('inBlock');
  });
  it('sent and settled well → your turn (next step); reverted / mismatch → needs attention', () => {
    expect(deployWord({ ...base, run: 'sent', settled: true })).toBe('yourTurn');
    expect(deployWord({ ...base, run: 'sent', settled: true, settledBad: true })).toBe('attention');
  });
  it('refused, changed, failed or an unknown outcome → needs attention, even while re-planning', () => {
    for (const run of ['rejected', 'changed', 'failed', 'unknown'] as const) expect(deployWord({ ...base, run, planning: true })).toBe('attention');
  });
});
