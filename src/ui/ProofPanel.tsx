// Proof of control (tech spec §3.2), ported from the M0 console to the logbook: the user signs a plain
// statement — never a transaction — with one of the wallet's Passkey owners, and the page checks the
// signature against that owner's on-chain key. Session, helper and assertion live only in React state.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Address } from 'viem';
import type { SupportedDeployment } from '../config/registry';
import { bytesToBase64url } from '../crypto/bytes';
import { createProofSession, type ProofSession } from '../proof/challenge';
import { verifyProof, type ProofOutcome } from '../proof/verifyProof';
import { buildHelper } from '../webauthn/helper';
import { downloadJson } from './common';
import { BookmarkletSigner } from './BookmarkletSigner';
import { ExtensionBridge } from './ExtensionBridge';
import { useT, type MsgKey } from './i18n';
import { Field, Mark, Notice } from './primitives';
import type { OwnerInfo } from './types';

export function ProofPanel({ dep, account, owners }: { dep: SupportedDeployment; account: Address; owners: OwnerInfo[] }) {
  const { t } = useT();
  const ids = { owner: useId(), input: useId() };
  const [ownerIndex, setOwnerIndex] = useState(owners[0]?.index ?? 0);
  const [session, setSession] = useState<ProofSession | null>(null);
  const [input, setInput] = useState('');
  // The verdict is bound to the exact text it was computed from; editing the input discards it.
  const [verified, setVerified] = useState<{ input: string; outcome: ProofOutcome } | null>(null);
  const owner = owners.find((o) => o.index === (session?.subject.ownerIndex ?? ownerIndex));
  const helper = useMemo(() => (session ? buildHelper(session.challenge, 'proof') : null), [session]);

  const start = () => {
    setSession(createProofSession({ account, chainId: dep.chainId, ownerIndex, rpId: dep.rp.id, origin: dep.rp.origin }));
    setInput('');
    setVerified(null);
  };
  const check = (text: string) => (session && owner ? verifyProof(session, text, { index: owner.index, publicKey: owner.value }) : null);

  // When the window closes, re-evaluate so a shown `valid` turns into `expired`.
  useEffect(() => {
    if (!session || !verified) return;
    const ms = session.expiresAt.getTime() - Date.now() + 1;
    if (ms <= 0) return;
    const id = setTimeout(() => setVerified((v) => (v ? { input: v.input, outcome: check(v.input)! } : v)), ms);
    return () => clearTimeout(id);
  }, [session, verified]);

  // The result renders below the input, often past the sheet's fold: bring a new verdict into view.
  const resultRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (verified) resultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [verified]);

  const outcome = verified?.outcome ?? null;
  return (
    <div className="lb-form" data-testid="proof">
      <p className="lb-lead">{t('proof.lead')}</p>
      <div className="lb-row2">
        <Field id={ids.owner} label={t('proof.owner')}>
          <select id={ids.owner} className="lb-input" value={ownerIndex} onChange={(e) => (setOwnerIndex(Number(e.target.value)), setSession(null), setVerified(null))} data-testid="proof-owner">
            {owners.map((o) => (
              <option key={o.index} value={o.index}>
                {t('check.ownerIndex', { index: o.index })}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="lb-actions">
        <button type="button" className="lb-btn" onClick={start} data-testid="proof-start">
          {session ? t('proof.restart') : t('proof.start')}
        </button>
      </div>

      {session && helper && (
        <>
          <p className="lb-help" data-testid="proof-expires">
            {t('proof.valid', { time: session.expiresAt.toLocaleTimeString() })}
          </p>
          <details className="lb-details" open>
            <summary>{t('proof.statement')}</summary>
            <pre className="lb-code-block" tabIndex={0} data-testid="proof-statement">
              {session.statement}
            </pre>
            <p className="lb-help lb-mono lb-break" data-testid="proof-challenge">
              {bytesToBase64url(session.challenge)}
            </p>
          </details>
          <BookmarkletSigner kind="proof" challenge={session.challenge} entryUrl={dep.rp.entryUrl} testId="proof-bookmarklet" />
          <ExtensionBridge kind="proof" challenge={session.challenge} onAssertion={(json) => (setInput(json), setVerified(null))} />
          <details className="lb-details" data-testid="proof-advanced">
            <summary>{t('sign.advanced')}</summary>
            <p>{t('sign.helperSteps', { url: dep.rp.entryUrl })}</p>
            <p className="lb-help lb-mono lb-break" data-testid="proof-helper-sha256">
              {t('sign.helperHash', { hash: helper.sha256Hex })}
            </p>
            <pre className="lb-code-block" tabIndex={0} data-testid="proof-helper">
              {helper.source}
            </pre>
          </details>
          <Field id={ids.input} label={t('sign.paste')}>
            <textarea id={ids.input} className="lb-input lb-mono" rows={4} spellCheck={false} autoComplete="off" value={input} onChange={(e) => (setInput(e.target.value), setVerified(null))} data-testid="proof-input" />
          </Field>
          <div className="lb-actions">
            <button type="button" className="lb-btn lb-btn-primary" disabled={!input.trim()} onClick={() => setVerified({ input: input.trim(), outcome: check(input.trim())! })} data-testid="proof-verify">
              {t('proof.verify')}
            </button>
          </div>
        </>
      )}

      {session && verified && outcome && (
        <section ref={resultRef} className={`lb-paper lb-tone-border-${outcome.status === 'valid' ? 'ok' : 'bad'}`} data-testid="proof-result" data-status={outcome.status}>
          <Notice tone={outcome.status === 'valid' ? 'ok' : 'bad'}>{t(`proof.result.${outcome.status}` as MsgKey, { index: session.subject.ownerIndex })}</Notice>
          <ul className="lb-checks">
            {outcome.checks.map((c) => (
              <li key={c.id} data-check={c.id} data-ok={c.ok}>
                <Mark ok={c.ok} /> <span className="lb-check-name">{c.id}</span> <span className="lb-detail">{c.detail}</span>
              </li>
            ))}
            <li data-check="expiry" data-ok={outcome.expiry.ok}>
              <Mark ok={outcome.expiry.ok} /> <span className="lb-check-name">{t('proof.expiry')}</span> <span className="lb-detail">{outcome.expiry.detail}</span>
            </li>
          </ul>
          <button
            type="button"
            className="lb-btn lb-btn-quiet"
            data-testid="proof-download"
            onClick={() => {
              // Re-verify the exact exported text at export time: a report never pairs a verdict with text it was not computed from.
              const fresh = check(verified.input)!;
              setVerified({ input: verified.input, outcome: fresh });
              // The pasted assertion itself is never exported (INV-004): text that failed the proof checks may be
              // a transfer authorization pasted by mistake, so only the statement, challenge and results leave.
              downloadJson(`cbpr-proof-report-${session.issuedAt.toISOString().replace(/[:.]/g, '-')}.json`, {
                format: 'cbpr-proof-report-v3',
                note: 'Proof-of-control report: the statement, the challenge and the verification results. It holds no signature.',
                statement: session.statement,
                challenge: bytesToBase64url(session.challenge),
                status: fresh.status,
                checks: fresh.checks,
                expiry: fresh.expiry,
                verifiedAt: new Date().toISOString(),
              });
            }}
          >
            {t('proof.download')}
          </button>
          <p className="lb-help">{t('proof.downloadNote')}</p>
        </section>
      )}
    </div>
  );
}
