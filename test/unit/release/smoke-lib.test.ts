// scripts/release/smoke-lib.mjs: the preview smoke always signals the runner's process group, even when the
// browser close rejects or never settles, and escalates to SIGKILL when SIGINT does not stop it in time.
import { describe, expect, it } from 'vitest';
import { bounded, createInterrupt, reapGroups, stopAll } from '../../../scripts/release/smoke-lib.mjs';

const never = () => new Promise<never>(() => {});

describe('bounded', () => {
  it('a value in time → the value; too late or rejected → the fallback', async () => {
    expect(await bounded(Promise.resolve(7), 50)).toBe(7);
    expect(await bounded(never(), 20, 'late')).toBe('late');
    expect(await bounded(Promise.reject(new Error('boom')), 50)).toBeNull();
  });
});

describe('stopAll', () => {
  it('the browser close rejects → SIGINT is still sent; the group exits → true, no SIGKILL', async () => {
    const sent: string[] = [];
    const ok = await stopAll({ closeBrowser: () => Promise.reject(new Error('browser crashed')), signal: (s: string) => sent.push(s), exited: Promise.resolve({ code: 0 }), closeMs: 50, graceMs: 50 });
    expect(sent).toEqual(['SIGINT']);
    expect(ok).toBe(true);
  });
  it('the browser close never settles → SIGINT after closeMs; no exit in time → SIGKILL and false', async () => {
    const sent: string[] = [];
    const ok = await stopAll({ closeBrowser: never, signal: (s: string) => sent.push(s), exited: never(), closeMs: 20, graceMs: 20 });
    expect(sent).toEqual(['SIGINT', 'SIGKILL']);
    expect(ok).toBe(false);
  });
  it('the npm wrapper exits but a child still holds a port → SIGKILL and false', async () => {
    const sent: string[] = [];
    const ok = await stopAll({ closeBrowser: undefined, signal: (s: string) => sent.push(s), exited: Promise.resolve({ code: 0 }), portsClosed: async () => false, graceMs: 50 });
    expect(sent).toEqual(['SIGINT', 'SIGKILL']);
    expect(ok).toBe(false);
  });
  it('the browser close throws synchronously → SIGINT, the exit wait still runs; ports closed → true', async () => {
    const sent: string[] = [];
    const closeBrowser = () => { throw new Error('sync'); };
    const ok = await stopAll({ closeBrowser, signal: (s: string) => sent.push(s), exited: Promise.resolve({ code: 0 }), portsClosed: async () => true, closeMs: 50, graceMs: 50 });
    expect(sent).toEqual(['SIGINT']);
    expect(ok).toBe(true);
  });
  it('no browser was launched (the start failed) → the group is still signalled', async () => {
    const sent: string[] = [];
    await stopAll({ closeBrowser: undefined, signal: (s: string) => sent.push(s), exited: Promise.resolve({ code: 1 }), graceMs: 50 });
    expect(sent).toEqual(['SIGINT']);
  });
});

describe('createInterrupt', () => {
  const harness = (held: number[][]) => {
    const sent: Array<[number, string]> = [];
    const out: { report?: number[]; code?: number } = {};
    let i = 0;
    const ctl = createInterrupt({
      signalGroup: (g: number, s: string) => sent.push([g, s]),
      portsHeld: async () => held[Math.min(i++, held.length - 1)]!,
      wait: async () => {},
      exit: (c: number) => (out.code = c),
      report: (h: number[]) => (out.report = h),
      graceMs: 600,
    });
    return { ctl, sent, out };
  };
  it('the npm wrapper exited but its child still holds 4181 → the group is still signalled, SIGINT then SIGKILL', async () => {
    const { ctl, sent, out } = harness([[4181], [4181], [4181], []]);
    ctl.started(1234); // no stopped(): a wrapper exit alone does not unregister the group
    await ctl.interrupt();
    expect(sent).toEqual([[1234, 'SIGINT'], [1234, 'SIGKILL']]);
    expect(out).toEqual({ report: [], code: 130 });
  });
  it('a second signal during the grace period runs no second cleanup; pending is that one cleanup', async () => {
    const { ctl, sent } = harness([[4171], []]);
    ctl.started(7);
    expect(ctl.pending).toBeNull();
    const first = ctl.interrupt();
    expect(ctl.pending).toBe(first);
    await Promise.all([first, ctl.interrupt()]);
    expect(sent.filter(([, s]) => s === 'SIGINT')).toHaveLength(1);
  });
  it('a phase whose cleanup could not free its port keeps its group → a later interrupt still kills it', async () => {
    const { ctl, sent } = harness([[4181], []]);
    ctl.started(1234);
    expect(ctl.finish(1234, false)).toBe(false);
    await ctl.interrupt();
    expect(sent).toEqual([[1234, 'SIGINT'], [1234, 'SIGKILL']]);
  });
  it('a group the smoke already stopped is not signalled; ports still held are reported', async () => {
    const { ctl, sent, out } = harness([[4172]]);
    ctl.started(1); ctl.finish(1, true); ctl.started(2);
    await ctl.interrupt();
    expect(sent.map(([g]) => g)).toEqual([2, 2]);
    expect(out.report).toEqual([4172]);
  });
});

describe('reapGroups', () => {
  it('a timed-out case whose wrapper is still running → SIGKILLed, and released only once the group is really gone', async () => {
    const live = new Set([11, 12]);
    const killed: number[] = [];
    let waits = 0;
    const left = await reapGroups({
      groups: [11, 12],
      alive: (g: number) => live.has(g),
      kill: (g: number) => killed.push(g),
      wait: async () => { waits++; if (waits === 2) live.clear(); }, // the kill takes effect a moment later
      stepMs: 10,
      graceMs: 100,
    });
    expect(killed).toEqual([11, 12]);
    expect(left).toEqual([]);
    expect(waits).toBe(2);
  });
  it('a group already gone is not signalled; one that survives SIGKILL is returned so it stays registered', async () => {
    const killed: number[] = [];
    const left = await reapGroups({ groups: [21, 22], alive: (g: number) => g === 22, kill: (g: number) => killed.push(g), wait: async () => {}, stepMs: 10, graceMs: 30 });
    expect(killed).toEqual([22]);
    expect(left).toEqual([22]);
  });
  it('no groups → nothing signalled, no wait', async () => {
    let waited = false;
    expect(await reapGroups({ groups: [], alive: () => true, kill: () => {}, wait: async () => { waited = true; } })).toEqual([]);
    expect(waited).toBe(false);
  });
});
