// PM-01 (2026-11-02): the current stage of opening an existing gas wallet is never "busy" before a request runs.
import { describe, expect, it } from 'vitest';
import { STAGE_MARK, stageState } from '../../../src/ui/gas/stages';

const idle = { waiting: false, working: false, failed: false };

describe('stageState', () => {
  it('nothing started (empty link, button disabled) → the current stage is the user’s turn, not busy', () => {
    expect(stageState(1, 1, idle)).toBe('input');
  });
  it('stages before and after the current one → done / next, whatever runs now', () => {
    expect(stageState(0, 1, { waiting: true, working: true, failed: true })).toBe('done');
    expect(stageState(2, 1, { waiting: true, working: true, failed: true })).toBe('next');
  });
  it('a request that waits on the 1Password app → waiting; any other signer request → working', () => {
    expect(stageState(1, 1, { ...idle, waiting: true })).toBe('waiting');
    expect(stageState(1, 1, { ...idle, working: true })).toBe('working');
  });
  it('a running request outranks an earlier failure; with nothing running the failure shows', () => {
    expect(stageState(3, 3, { waiting: true, working: false, failed: true })).toBe('waiting');
    expect(stageState(3, 3, { ...idle, failed: true })).toBe('failed');
  });
  it('every overlap of waiting / working / failed on the current stage → waiting first, then working, then failed', () => {
    for (const waiting of [false, true])
      for (const working of [false, true])
        for (const failed of [false, true])
          expect(stageState(2, 2, { waiting, working, failed })).toBe(waiting ? 'waiting' : working ? 'working' : failed ? 'failed' : 'input');
  });
  it('a request not sent yet (the signer still answers an earlier one) → queued, never working or waiting, and outranks a failure', () => {
    expect(stageState(3, 3, { ...idle, queued: true })).toBe('queued');
    expect(stageState(3, 3, { waiting: true, working: true, failed: true, queued: true })).toBe('queued');
    expect(stageState(2, 3, { ...idle, queued: true })).toBe('done');
    expect(stageState(4, 3, { ...idle, queued: true })).toBe('next');
    expect(STAGE_MARK.queued).toBeTruthy();
  });
  it('every state has its own mark (state is never shown by colour alone)', () => {
    expect(new Set(Object.values(STAGE_MARK)).size).toBe(Object.keys(STAGE_MARK).length);
  });
});
