// Four moments from the real tool (6-recovery-atlas.md §3, section 3), captured on the e2e synthetic testchain by
// scripts/design/capture-demo.mjs. Each still is labelled as a demo with synthetic data; nothing here is live.
// One still at a time (PM-03): the reader steps through with the four named buttons or Previous / Next. All four stay
// in the DOM; the hidden ones are `hidden`, so their lazy images are not fetched until the reader gets there.
import { useState } from 'react';
import { useT, type MsgKey } from '../../i18n';
import check from '../assets/demo-check.webp';
import deploy from '../assets/demo-deploy.webp';
import approve from '../assets/demo-approve.webp';
import track from '../assets/demo-track.webp';

const STILLS = [
  ['check', check],
  ['deploy', deploy],
  ['approve', approve],
  ['track', track],
] as const;

export function Demo() {
  const { t } = useT();
  const [at, setAt] = useState(0);
  const last = STILLS.length - 1;
  return (
    <div className="lb-at-demo" data-testid="atlas-demo" data-at={at}>
      <div className="lb-at-demo-nav" role="group" aria-label={t('demo.steps')}>
        {STILLS.map(([k], i) => (
          <button
            key={k}
            type="button"
            className="lb-at-demo-step"
            aria-pressed={i === at}
            aria-controls={`demo-${k}`}
            data-testid={`demo-step-${k}`}
            onClick={() => setAt(i)}
          >
            <span aria-hidden="true">{i + 1}</span> {t(`demo.${k}` as MsgKey)}
          </button>
        ))}
      </div>
      <ol className="lb-at-demo-stills">
        {STILLS.map(([k, src], i) => (
          <li key={k} id={`demo-${k}`} hidden={i !== at}>
            <figure className="lb-at-sheet">
              <img src={src} width={960} height={552} loading="lazy" decoding="async" alt={t(`demo.${k}.alt` as MsgKey)} />
              <figcaption>
                <b>{t(`demo.${k}` as MsgKey)}</b>
                <span>{t(`demo.${k}.d` as MsgKey)}</span>
                <small className="lb-at-tag">{t('demo.tag')}</small>
              </figcaption>
            </figure>
          </li>
        ))}
      </ol>
      <div className="lb-at-demo-pager">
        <button type="button" className="lb-btn lb-btn-quiet" disabled={at === 0} onClick={() => setAt(at - 1)} data-testid="demo-prev">
          {t('demo.prev')}
        </button>
        <span className="lb-at-demo-count" aria-live="polite" data-testid="demo-count">
          {t('demo.count', { n: String(at + 1), total: String(STILLS.length) })}
        </span>
        <button type="button" className="lb-btn lb-btn-quiet" disabled={at === last} onClick={() => setAt(at + 1)} data-testid="demo-next">
          {t('demo.next')}
        </button>
      </div>
    </div>
  );
}
