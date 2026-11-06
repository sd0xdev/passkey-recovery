// Who holds what, as a night-edition chart (6-recovery-atlas.md §3, section 4): four jurisdictions, the runner
// and its native signer drawn as two separate blocks, and only the channels that exist. HTML regions so every
// word is selectable and it reflows on a phone; the dashed borders are the jurisdiction lines. The home page shows it
// once; the channels between the regions are behind a disclosure.
import type { ReactNode } from 'react';
import { useT, type MsgKey } from '../../i18n';

const CHANNELS = ['pageRunner', 'pageKeys', 'runnerChain', 'signerRunner'] as const;

function Region({ k, children }: { k: string; children?: ReactNode }) {
  const { t } = useT();
  return (
    <section className="lb-at-region" data-region={k} aria-labelledby={`bound-${k}`}>
      <h3 id={`bound-${k}`}>{t(`bound.${k}` as MsgKey)}</h3>
      {children ?? <p>{t(`bound.${k}.d` as MsgKey)}</p>}
    </section>
  );
}

export function Boundary() {
  const { t } = useT();
  return (
    <div className="lb-at-night" data-testid="atlas-boundary">
      <div className="lb-at-map">
        <Region k="site" />
        <Region k="computer">
          <div className="lb-at-blocks">
            <div className="lb-at-block" data-block="runner">
              <b>{t('bound.runner')}</b>
              <p>{t('bound.runner.d')}</p>
            </div>
            <div className="lb-at-block" data-block="signer">
              <b>{t('bound.signer')}</b>
              <p>{t('bound.signer.d')}</p>
            </div>
          </div>
        </Region>
        <Region k="keys" />
        <Region k="chain" />
      </div>
      {/* The map says who holds what once; how they talk is a detail, so it opens on request (PM-03). */}
      <details className="lb-at-chdetails" data-testid="bound-channels">
        <summary className="lb-at-channels-head">{t('bound.channels')}</summary>
        <ul className="lb-at-channels">
          {CHANNELS.map((c) => (
            <li key={c}>{t(`bound.ch.${c}` as MsgKey)}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
