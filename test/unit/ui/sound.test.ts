// Sound cues (src/ui/sound.ts, UX behaviour 9): off by default, started only by the toggle click, one
// play per event key, never in a hidden tab, never for a record from before this page load. A FAKE
// AudioContext records what would be played — no real audio in tests.
import { describe, expect, it } from 'vitest';
import { createSound, TONES, type Cue } from '../../../src/ui/sound';

function fakeEnv(o: { hidden?: boolean; noAudio?: boolean } = {}) {
  const started: number[] = [];
  let created = 0;
  let resumed = 0;
  const env = {
    hidden: () => !!o.hidden,
    createContext: () => {
      if (o.noAudio) return null;
      created++;
      const param = () => ({ setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined });
      const node = () => ({ connect: (n: unknown) => n });
      return {
        currentTime: 0,
        state: 'suspended' as AudioContextState,
        destination: {} as AudioDestinationNode,
        resume: async () => void resumed++,
        createGain: () => ({ ...node(), gain: param() }) as unknown as GainNode,
        createOscillator: () => ({ ...node(), type: 'sine', frequency: param(), start: (t: number) => void started.push(t), stop: () => undefined }) as unknown as OscillatorNode,
      };
    },
  };
  return { env, started, counts: () => ({ created, resumed }) };
}

describe('sound cues', () => {
  it('default off: play() makes no AudioContext and no sound', () => {
    const f = fakeEnv();
    const s = createSound(f.env);
    expect(s.isOn()).toBe(false);
    expect(s.play('done', 'track:0xaa:success')).toBe(false);
    expect(f.counts()).toEqual({ created: 0, resumed: 0 });
  });

  it('turning on (the click) creates and resumes the context and plays one preview', () => {
    const f = fakeEnv();
    const s = createSound(f.env);
    s.setOn(true);
    expect(s.isOn()).toBe(true);
    expect(f.counts()).toEqual({ created: 1, resumed: 1 });
    expect(f.started).toHaveLength(TONES.done.length);
  });

  it('one play per event key: a later poll with the same key is silent', () => {
    const f = fakeEnv();
    const s = createSound(f.env);
    s.setOn(true, false);
    expect(s.play('done', 'track:0xaa:success')).toBe(true);
    expect(s.play('done', 'track:0xaa:success')).toBe(false);
    expect(s.play('attention', 'track:0xbb:unknown')).toBe(true);
    expect(f.started).toHaveLength(TONES.done.length + TONES.attention.length);
  });

  it.each([
    ['a hidden tab', { hidden: true }, true],
    ['a record from before this page load', {}, false],
  ])('%s → silent, and the key is used up (no replay later)', (_l, env, fresh) => {
    const f = fakeEnv(env);
    const s = createSound(f.env);
    s.setOn(true, false);
    expect(s.play('done', 'k1', fresh)).toBe(false);
    expect(s.play('done', 'k1')).toBe(false);
    expect(f.started).toEqual([]);
  });

  it('an event while off stays used up: turning on later does not replay it', () => {
    const f = fakeEnv();
    const s = createSound(f.env);
    expect(s.play('done', 'k2')).toBe(false);
    s.setOn(true, false);
    expect(s.play('done', 'k2')).toBe(false);
    expect(f.started).toEqual([]);
  });

  it('no WebAudio in this browser → stays off', () => {
    const s = createSound(fakeEnv({ noAudio: true }).env);
    s.setOn(true);
    expect(s.isOn()).toBe(false);
  });

  it('cues are two short quiet notes each and take no data (only a cue name and an event key)', () => {
    for (const c of Object.keys(TONES) as Cue[]) {
      expect(TONES[c]).toHaveLength(2);
      expect(Math.max(...TONES[c].map((n) => n.at + n.len))).toBeLessThanOrEqual(0.4);
    }
    expect(createSound(fakeEnv().env).play.length).toBe(2);
  });
});
