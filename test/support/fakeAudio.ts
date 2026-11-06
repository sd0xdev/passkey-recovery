// A recording stand-in for WebAudio, installed with page.addInitScript(fakeAudio): it counts contexts,
// resumes and the notes started, and produces no sound. Tests never play real audio. `kinds` names each note's
// oscillator type, which tells the two cues apart (src/ui/sound.ts TONES: 'sine' for done, 'triangle' for attention).
export type AudioLog = { created: number; resumed: number; notes: number[]; kinds: string[] };

export function fakeAudio() {
  const w = window as unknown as { __audio: AudioLog };
  w.__audio = { created: 0, resumed: 0, notes: [], kinds: [] };
  const param = () => ({ setValueAtTime() {}, linearRampToValueAtTime() {} });
  class FakeAudioContext {
    currentTime = 0;
    state = 'suspended';
    destination = {};
    constructor() {
      w.__audio.created++;
    }
    resume() {
      w.__audio.resumed++;
      this.state = 'running';
      return Promise.resolve();
    }
    createGain() {
      return { gain: param(), connect: (n: unknown) => n };
    }
    createOscillator() {
      const o = {
        type: 'sine',
        frequency: param(),
        connect: (n: unknown) => n,
        start: (t: number) => void (w.__audio.notes.push(t), w.__audio.kinds.push(o.type)),
        stop() {},
      };
      return o;
    }
  }
  Object.defineProperty(window, 'AudioContext', { value: FakeAudioContext, configurable: true });
}
