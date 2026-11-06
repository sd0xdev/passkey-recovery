// Step 1, Check wallet (design guidelines §6.1): reads the chain, never signs. A counterfactual wallet
// needs its creation evidence (createAccount calldata / initCode, or owners + nonce) so the address
// can be derived locally and through factory.getAddress before anything is deployed.
import { useId, useRef, useState } from 'react';
import type { SupportedDeployment } from '../../config/registry';
import { useT, type MsgKey } from '../i18n';
import { blockText } from '../format';
import { AddressDisplay, AmountDisplay, Field, Mark, Notice } from '../primitives';
import { BusyLine } from '../ux';
import type { Diagnosis } from '../types';

export interface CheckInput {
  account: string;
  evidence?: { calldata?: string; initCode?: string; owners?: string[]; nonce?: string };
}

/**
 * `busy`: a check is running now. `blocked`: nothing can check yet (no runner answers this page) — said as
 * such, never shown as a check in progress.
 */
export function CheckStep({ dep, diag, account0, busy, blocked, onCheck, onReport, onProve }: { dep: SupportedDeployment; diag: Diagnosis | null; account0?: string; busy: boolean; blocked: boolean; onCheck: (i: CheckInput) => void; onReport: () => void; onProve: () => void }) {
  const { t } = useT();
  const ids = { account: useId(), calldata: useId(), owners: useId(), nonce: useId() };
  const [account, setAccount] = useState(diag?.account ?? account0 ?? '');
  const [showEvidence, setShowEvidence] = useState(false);
  const [calldata, setCalldata] = useState('');
  const [owners, setOwners] = useState('');
  const [nonce, setNonce] = useState('0');
  // Only a Check sent with creation evidence may run the fork simulation, and only when the chain alone cannot
  // answer (not known until it does): its lines say "may". One without evidence only reads the chain (PM-09).
  const [withEvidence, setWithEvidence] = useState(false);

  // Whether the evidence section is open is read from the element when the check is submitted: the
  // native toggle event that updates `showEvidence` is queued, so state can lag behind what is on screen.
  const details = useRef<HTMLDetailsElement>(null);
  const input = (): CheckInput => {
    const a = account.trim();
    if (!(details.current?.open ?? showEvidence)) return { account: a };
    const pasted = calldata.trim();
    // initCode is the v1.1 factory address followed by the createAccount calldata; anything else is sent
    // as calldata (the sidecar's parser says exactly what is wrong with either).
    if (pasted) return { account: a, evidence: pasted.slice(0, 42).toLowerCase() === dep.factory.toLowerCase() && pasted.length > 42 ? { initCode: pasted } : { calldata: pasted } };
    const list = owners.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    return list.length ? { account: a, evidence: { owners: list, nonce: nonce.trim() } } : { account: a };
  };

  return (
    <form
      className="lb-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!account.trim()) return;
        const i = input();
        setWithEvidence(!!i.evidence);
        onCheck(i);
      }}
    >
      <p className="lb-lead">{t('check.lead')}</p>
      <Field id={ids.account} label={t('check.address')}>
        <input id={ids.account} className="lb-input lb-mono" autoComplete="off" spellCheck={false} placeholder="0x…" value={account} onChange={(e) => setAccount(e.target.value)} data-testid="check-account" />
      </Field>
      <details ref={details} className="lb-details" open={showEvidence} onToggle={(e) => setShowEvidence((e.target as HTMLDetailsElement).open)}>
        <summary data-testid="check-evidence-toggle">{t('check.evidence')}</summary>
        <p className="lb-help">{t('check.evidenceHelp')}</p>
        <Field id={ids.calldata} label={t('check.evidence.calldata')}>
          <textarea id={ids.calldata} className="lb-input lb-mono" rows={3} spellCheck={false} value={calldata} onChange={(e) => setCalldata(e.target.value)} data-testid="check-calldata" />
        </Field>
        <Field id={ids.owners} label={t('check.evidence.owners')}>
          <textarea id={ids.owners} className="lb-input lb-mono" rows={3} spellCheck={false} value={owners} onChange={(e) => setOwners(e.target.value)} data-testid="check-owners" />
        </Field>
        <Field id={ids.nonce} label={t('check.evidence.nonce')}>
          <input id={ids.nonce} className="lb-input lb-mono lb-input-short" inputMode="numeric" value={nonce} onChange={(e) => setNonce(e.target.value)} data-testid="check-nonce" />
        </Field>
      </details>

      {busy && (
        <BusyLine testId="check-busy" slow={withEvidence ? 'maybeSim' : 'other'}>
          {t(withEvidence ? 'check.running' : 'check.runningRead')}
        </BusyLine>
      )}
      {blocked && !busy && (
        <p className="lb-help" data-testid="check-blocked">
          {t('check.needRunner')}
        </p>
      )}
      {!busy && !blocked && !diag && !account.trim() && <p className="lb-help">{t('check.empty')}</p>}
      {diag && (
        <DiagnosisView
          dep={dep}
          d={diag}
          onReport={onReport}
          onProve={onProve}
          onAddEvidence={() => {
            // Opens the creation-evidence fields above and puts the cursor in the first one.
            setShowEvidence(true);
            if (details.current) details.current.open = true;
            requestAnimationFrame(() => document.getElementById(ids.calldata)?.focus());
          }}
        />
      )}

      <div className="lb-actionbar">
        <button type="submit" className="lb-btn lb-btn-primary" disabled={busy || blocked || !account.trim()} data-testid="check-run">
          {busy ? t(withEvidence ? 'check.running' : 'check.runningRead') : t('check.run')}
        </button>
      </div>
    </form>
  );
}

function DiagnosisView({ dep, d, onReport, onProve, onAddEvidence }: { dep: SupportedDeployment; d: Diagnosis; onReport: () => void; onProve: () => void; onAddEvidence: () => void }) {
  const { t } = useT();
  const needsEvidence = !d.supported && !!d.needsEvidence;
  return (
    <section className="lb-paper" aria-live="polite" data-testid="diagnosis" data-supported={d.supported} data-needs={d.needs.join(',')} data-needs-evidence={needsEvidence}>
      {/* PM-03: a wallet not yet on Plasma that only lacks its creation evidence is one more input away, not refused. */}
      {needsEvidence && (
        <div className="lb-next-input" data-testid="check-needs-evidence">
          <h3>{t('check.needsEvidence')}</h3>
          <p>{t('check.needsEvidenceLead')}</p>
          <button type="button" className="lb-btn" onClick={onAddEvidence} data-testid="check-add-evidence">
            {t('check.addEvidence')}
          </button>
        </div>
      )}
      {!d.supported && !needsEvidence && (
        <>
          <h3 className="lb-tone-bad">{t('check.unsupported')}</h3>
          <p>{t('check.unsupportedLead')}</p>
        </>
      )}
      <p className="lb-kv">
        <span className="lb-k">{t('check.address')}</span>
        <AddressDisplay value={d.account} testId="diag-account" />
      </p>
      <ul className="lb-checks">
        {d.checks.map((c) => (
          <li key={c.id} data-check={c.id} data-ok={c.ok}>
            <Mark ok={c.ok} />
            <span className="lb-check-name">{t(`check.${c.id}` as MsgKey)}</span>
            <span className="lb-detail">{c.detail}</span>
          </li>
        ))}
      </ul>
      {d.blockers.length > 0 && !needsEvidence && (
        <ul className="lb-blockers" data-testid="diag-blockers">
          {d.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      <h3>{t('check.balances')}</h3>
      <p className="lb-help">{t('check.at', { block: blockText(d.block) })}</p>
      <dl className="lb-dl">
        {dep.assets.map((a) => {
          const v = a.native ? d.balances.native : d.balances.tokens[a.id as string];
          return (
            <div key={a.id}>
              <dt>{a.symbol}</dt>
              <dd data-testid={`bal-${a.symbol}`}>{v === null || v === undefined ? '?' : <AmountDisplay units={v} decimals={a.decimals} symbol={a.symbol} />}</dd>
            </div>
          );
        })}
        <div>
          <dt>{t('check.deposit')}</dt>
          <dd>
            <AmountDisplay units={d.balances.deposit} decimals={18} symbol={dep.assets.find((a) => a.native)!.symbol} />
          </dd>
        </div>
        <div>
          <dt>{t('check.nonce')}</dt>
          <dd className="lb-mono" data-testid="diag-nonce">
            {d.balances.nonce}
          </dd>
        </div>
        {d.passkeyOwners.length > 0 && (
          <div>
            <dt>{t('check.owners')}</dt>
            <dd>
              {d.passkeyOwners.map((o) => t('check.ownerIndex', { index: o.index })).join(', ')}{' '}
              <button type="button" className="lb-btn lb-btn-link" onClick={onProve} data-testid="diag-prove">
                {t('proof.open')}
              </button>
            </dd>
          </div>
        )}
      </dl>
      {d.supported ? (
        <Notice tone="ok" testId="diag-verdict">
          {d.needs.length ? t('check.needsDeploy', { chain: dep.chainName }) : t('check.ready')}
        </Notice>
      ) : (
        <div className="lb-actions">
          <button type="button" className="lb-btn lb-btn-quiet" onClick={onReport} data-testid="diag-report">
            {t('top.report')}
          </button>
        </div>
      )}
    </section>
  );
}
