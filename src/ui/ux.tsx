// UX pass building blocks (2026-11-01): what each step does, live status with elapsed time (never a fake
// percentage), the on-chain ladder, the capability strip, the sound toggle and a copy button that says
// when the browser refused. All text comes from ./copy-ux.ts.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useT, type MsgKey } from './i18n';
import { sound } from './sound';

export type StepKey = 'check' | 'deploy' | 'move' | 'track';

/** What this step does, why it is needed, what the user has afterwards — three short lines. */
export function StepIntro({ step }: { step: StepKey }) {
  const { t } = useT();
  return (
    <dl className="lb-intro" data-testid={`intro-${step}`}>
      {(['what', 'why', 'result'] as const).map((k) => (
        <div key={k}>
          <dt>{t(`intro.${k}`)}</dt>
          <dd>{t(`intro.${step}.${k}` as MsgKey)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Whole seconds since `active` became true; 0 while inactive. */
export function useElapsed(active: boolean): number {
  const [start, setStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      setStart(null);
      return;
    }
    const s = Date.now();
    setStart(s);
    setNow(s);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return start === null ? 0 : Math.max(0, Math.floor((now - start) / 1000));
}

/**
 * A long operation in progress: what is happening now, how long it has taken, and after 20 s a line
 * saying it is still working. The bar moves only to show life — it is not a progress measure — and stands
 * still under reduced motion. The text is the status; the seconds are hidden from screen readers so they
 * do not announce every tick.
 */
/**
 * What the line after `slowAfter` seconds says, by what really runs (PM-09): a fork simulation (nothing is sent),
 * a send with the gas payer (it may already be broadcast), or anything else.
 */
export type SlowKind = 'sim' | 'maybeSim' | 'send' | 'other';
const SLOW_KEY: Record<SlowKind, MsgKey> = { sim: 'busy.slow', maybeSim: 'busy.slowMaybeSim', send: 'busy.slowSend', other: 'busy.slowOther' };

export function BusyLine({ children, testId, slowAfter = 20, slow = 'other' }: { children: ReactNode; testId?: string; slowAfter?: number; slow?: SlowKind }) {
  const { t } = useT();
  const s = useElapsed(true);
  return (
    <div className="lb-busy" role="status" data-testid={testId} data-elapsed={s}>
      <span className="lb-busy-bar" aria-hidden="true" />
      <p className="lb-busy-text">
        {children} <span className="lb-busy-time" aria-hidden="true">{t('busy.elapsed', { s })}</span>
      </p>
      {s >= slowAfter && (
        <p className="lb-help" data-testid={testId ? `${testId}-slow` : undefined} data-slow={slow}>
          {t(SLOW_KEY[slow])}
        </p>
      )}
    </div>
  );
}

export type LadderAt = 'sent' | 'block' | 'final' | 'failed' | 'unknown';

/**
 * Submitted → In a block → Final. Only a state the chain confirmed lights a rung (✓, success colour); a
 * hash alone or a failure marks "Submitted" as merely passed (•, neutral) and stops at "Did not go through" (✗), and an
 * unknown lights nothing — neither ever shows a ✓, the success colour or the seal.
 */
export function Ladder({ at }: { at: LadderAt }) {
  const { t } = useT();
  const reached = { sent: 1, block: 2, final: 3, failed: 1, unknown: 0 }[at];
  const rungs = [
    { k: 'sent', label: t('ladder.sent') },
    { k: 'block', label: at === 'failed' ? t('ladder.failed') : t('ladder.block') },
    { k: 'final', label: t('ladder.final') },
  ];
  return (
    <ol className="lb-ladder" aria-label={t('ladder.label')} data-testid="ladder" data-at={at}>
      {rungs.map((r, i) => {
        // "Submitted" alone (a hash) is passed, not confirmed: neutral until a block holds the transfer.
        const state = at === 'failed' ? (i === 0 ? 'past' : i === 1 ? 'failed' : 'later') : at === 'sent' && i === 0 ? 'past' : i < reached ? 'done' : i === reached && at !== 'unknown' ? 'now' : 'later';
        return (
          <li key={r.k} data-state={state} aria-current={state === 'now' ? 'step' : undefined}>
            <span className="lb-ladder-mark" aria-hidden="true">
              {state === 'done' ? '✓' : state === 'failed' ? '✗' : state === 'now' ? '●' : state === 'past' ? '•' : '○'}
            </span>
            {r.label}
          </li>
        );
      })}
      {at === 'unknown' && <li data-state="unknown">{t('ladder.unknown')}</li>}
    </ol>
  );
}

export function useSoundOn(): boolean {
  return useSyncExternalStore(sound.subscribe, sound.isOn, () => false);
}

/** Off by default; the click that turns it on is the gesture that lets audio start. */
export function SoundToggle() {
  const { t } = useT();
  const on = useSoundOn();
  return (
    <button type="button" className="lb-chip" aria-pressed={on} title={t('sound.label')} onClick={() => sound.setOn(!on)} data-testid="sound-toggle">
      <span aria-hidden="true">{on ? '♪' : '♪̸'}</span>&nbsp;{t(on ? 'sound.on' : 'sound.off')}
      <span className="lb-sr"> — {t('sound.label')}</span>
    </button>
  );
}

/** Copies `text`; says so, or says the browser refused (then the text stays selectable on screen). */
export interface CopyState<W extends string> {
  status: 'idle' | 'ok' | 'failed';
  /** Which of the place's texts the status is about. */
  what: W | null;
  /** The text whose copy failed: shown for copying by hand. */
  text: string | null;
}

/**
 * One copy state for the texts of one place (PM-08). It starts over when `key` changes (a new request code: an
 * earlier "copied" is not this text's), and only the latest copy decides it — an earlier write answering later
 * changes nothing. No Clipboard API, a synchronous throw or a refusal is a failure, with the text kept for copying
 * by hand. It only writes: the clipboard is never read.
 */
export function useCopy<W extends string>(key: string) {
  const [st, setSt] = useState<CopyState<W>>({ status: 'idle', what: null, text: null });
  const seq = useRef(0);
  useEffect(() => {
    seq.current++;
    setSt({ status: 'idle', what: null, text: null });
  }, [key]);
  const copy = useCallback((text: string, what: W) => {
    const my = ++seq.current;
    const end = (ok: boolean) => {
      if (my === seq.current) setSt({ status: ok ? 'ok' : 'failed', what, text: ok ? null : text });
    };
    let p: Promise<void>;
    try {
      const c = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (!c || typeof c.writeText !== 'function') return end(false);
      p = c.writeText(text);
    } catch {
      return end(false);
    }
    Promise.resolve(p).then(
      () => end(true),
      () => end(false),
    );
  }, []);
  return { ...st, copy };
}

/** The text a copy could not put on the clipboard, selected on focus so the keyboard can copy it. */
export function ManualCopy({ text, testId }: { text: string; testId: string }) {
  const { t } = useT();
  return (
    <label className="lb-manual-copy">
      <span className="lb-help">{t('copy.manual')}</span>
      <textarea className="lb-input lb-mono" readOnly rows={Math.min(6, Math.max(2, Math.ceil(text.length / 60)))} value={text} spellCheck={false} onFocus={(e) => e.currentTarget.select()} data-testid={testId} />
    </label>
  );
}

export function CopyButton({ text, label, done, testId }: { text: string; label: string; done: string; testId: string }) {
  const { t } = useT();
  const c = useCopy<'text'>(text);
  return (
    <span className="lb-copy">
      <button type="button" className="lb-btn lb-btn-quiet" onClick={() => c.copy(text, 'text')} data-testid={testId} data-copy={c.status === 'failed' ? 'blocked' : c.status}>
        {c.status === 'ok' ? done : label}
      </button>
      {c.status === 'failed' && (
        <>
          <span className="lb-help lb-tone-bad" role="alert" data-testid={`${testId}-blocked`}>
            {t('copy.blocked')}
          </span>
          <ManualCopy text={c.text ?? text} testId={`${testId}-manual`} />
        </>
      )}
    </span>
  );
}
