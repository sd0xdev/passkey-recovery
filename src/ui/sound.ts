// Optional sound cues (UX behaviour 9). Off by default and kept in memory only, like the language: a
// reload is silent again. Turning it on is a click, which is also the gesture the browser's autoplay
// rule needs to start audio. Two short tones synthesized with WebAudio (no files, nothing to license):
// `done` for an on-chain result verified by this page, `attention` for something that needs the user.
// A cue takes no data at all — it can never speak an amount, an address or a secret — and each event key
// plays once per page load, only while the tab is visible, never for a record loaded from before.
export type Cue = 'done' | 'attention';

type Ctx = Pick<AudioContext, 'currentTime' | 'destination' | 'createOscillator' | 'createGain' | 'resume' | 'state'>;
type Env = { createContext: () => Ctx | null; hidden: () => boolean };

const browserEnv: Env = {
  createContext: () => {
    const C = (globalThis as { AudioContext?: new () => AudioContext }).AudioContext;
    return C ? new C() : null;
  },
  hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
};

/** Two notes each: rising for done, level and lower for attention. Quiet (peak gain 0.06), 0.36 s in all. */
export const TONES: Record<Cue, Array<{ hz: number; at: number; len: number; type: OscillatorType }>> = {
  done: [
    { hz: 523.25, at: 0, len: 0.14, type: 'sine' },
    { hz: 783.99, at: 0.16, len: 0.2, type: 'sine' },
  ],
  attention: [
    { hz: 440, at: 0, len: 0.12, type: 'triangle' },
    { hz: 440, at: 0.18, len: 0.12, type: 'triangle' },
  ],
};

export function createSound(env: Env = browserEnv) {
  let on = false;
  let ctx: Ctx | null = null;
  const played = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((f) => f());
  const beep = (cue: Cue) => {
    if (!ctx) return;
    const t0 = ctx.currentTime + 0.02;
    for (const n of TONES[cue]) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = n.type;
      o.frequency.setValueAtTime(n.hz, t0 + n.at);
      g.gain.setValueAtTime(0, t0 + n.at);
      g.gain.linearRampToValueAtTime(0.06, t0 + n.at + 0.02);
      g.gain.linearRampToValueAtTime(0, t0 + n.at + n.len);
      o.connect(g).connect(ctx.destination);
      o.start(t0 + n.at);
      o.stop(t0 + n.at + n.len + 0.02);
    }
  };
  return {
    isOn: () => on,
    /** Call only from a click handler: that click is the gesture that may start audio. */
    setOn(next: boolean, preview = true) {
      on = next;
      if (on) {
        ctx ??= env.createContext();
        if (ctx && ctx.state === 'suspended') void ctx.resume();
        if (!ctx) on = false;
        else if (preview) beep('done');
      }
      emit();
    },
    /**
     * Plays `cue` once for `key` (an event id such as `track:<userOpHash>:confirmed`). Off, a hidden tab or
     * a key already used: nothing, and the key is used up either way, so a later poll or tab switch never
     * replays it. `fresh` false (a record from before this page load): never plays.
     */
    play(cue: Cue, key: string, fresh = true): boolean {
      if (played.has(key)) return false;
      played.add(key);
      if (!on || !fresh || env.hidden()) return false;
      beep(cue);
      return true;
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
  };
}

export const sound = createSound();
/** When this page was loaded: records saved before it are not this visit's events. */
export const PAGE_LOADED_AT = Date.now();
