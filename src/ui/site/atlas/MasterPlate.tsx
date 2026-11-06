// The hero plate with its controls (6-recovery-atlas.md §5). Shot I is the static first paint; the story plays
// only when the visitor presses Play (about 10 s, once). Plate buttons jump to a shot; the HTML caption is the
// content (aria-live) and the SVG is decoration. It pauses when the page is hidden or the plate leaves the
// viewport, and never resumes by itself. Reduced motion: no entrance, Play steps one plate per press.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useT, type MsgKey } from '../../i18n';
import { SHOTS, TALL, WIDE, type Shot } from './geometry';
import { Plate } from './Plate';

/** When each shot begins, in ms from the start of the story; the story ends at END. */
export const SHOT_AT: Readonly<Record<Shot, number>> = { 0: 0, 1: 2000, 2: 5000, 3: 8000 };
export const END = 10_000;

function prefersReduced(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function MasterPlate() {
  const { t } = useT();
  const [shot, setShot] = useState<Shot>(0);
  const [playing, setPlaying] = useState(false);
  const timers = useRef<number[]>([]);
  const fig = useRef<HTMLElement>(null);

  const stop = useCallback(() => {
    timers.current.forEach((id) => clearTimeout(id));
    timers.current = [];
    setPlaying(false);
  }, []);

  const playFrom = useCallback(
    (from: Shot) => {
      stop();
      if (prefersReduced()) {
        setShot(from);
        return;
      }
      setShot(from);
      setPlaying(true);
      const t0 = SHOT_AT[from];
      for (const s of SHOTS) if (s > from) timers.current.push(window.setTimeout(() => setShot(s), SHOT_AT[s] - t0));
      timers.current.push(window.setTimeout(() => setPlaying(false), END - t0));
    },
    [stop],
  );

  const onPlay = () => {
    if (prefersReduced()) setShot((s) => (s === 3 ? 0 : ((s + 1) as Shot)));
    else playFrom(shot === 3 ? 0 : shot);
  };

  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && stop();
    document.addEventListener('visibilitychange', onHide);
    let io: IntersectionObserver | undefined;
    if (fig.current && typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((es) => es.some((e) => !e.isIntersecting) && stop());
      io.observe(fig.current);
    }
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      io?.disconnect();
      timers.current.forEach((id) => clearTimeout(id));
    };
  }, [stop]);

  const reduced = prefersReduced();
  return (
    <figure ref={fig} className="lb-at-master" data-testid="atlas-master" data-shot={shot} data-playing={playing}>
      <div className="lb-at-paper">
        <Plate layout={WIDE} shot={shot} station="atlas-station" />
        <Plate layout={TALL} shot={shot} station="atlas-station" />
      </div>
      <div className="lb-at-controls" role="group" aria-label={t('atlas.controls')}>
        {playing ? (
          <button type="button" className="lb-at-btn" onClick={stop} data-testid="atlas-pause">
            {t('atlas.pause')}
          </button>
        ) : (
          <button type="button" className="lb-at-btn" onClick={onPlay} data-testid="atlas-play">
            {t(reduced ? 'atlas.step' : 'atlas.play')}
          </button>
        )}
        <button type="button" className="lb-at-btn" onClick={() => playFrom(0)} data-testid="atlas-replay">
          {t('atlas.replay')}
        </button>
        <span className="lb-at-nums">
          {([0, 1, 2] as const).map((s) => (
            <button
              key={s}
              type="button"
              className="lb-at-btn lb-at-num"
              aria-pressed={Math.min(shot, 2) === s}
              aria-label={t('atlas.goto', { n: ['I', 'II', 'III'][s]! })}
              onClick={() => {
                stop();
                setShot(s);
              }}
              data-testid={`atlas-shot-${s}`}
            >
              {['I', 'II', 'III'][s]}
            </button>
          ))}
        </span>
      </div>
      <figcaption className="lb-at-caption" aria-live="polite" data-testid="atlas-caption">
        {shot === 3 ? t('atlas.cap.3') : `${['I', 'II', 'III'][shot]}. ${t(`plate.${shot}.d` as MsgKey)}`}
      </figcaption>
    </figure>
  );
}
