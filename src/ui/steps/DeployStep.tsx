// Step 2, Deploy wallet (design guidelines §6.2, §7 step_unknown). One step = one transaction the user
// confirms with their gas payer (wallet, File key or the runner's native signer). The sidecar plans from the chain each time, so a step already on chain
// is never offered again; a lost wallet answer re-plans instead of resending. The send is recorded before
// the wallet is asked (trackingStore deploy record), so a reload mid-step resumes tracking that step.
import { useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { addressDigest } from '../../transfer/intent';
import type { SupportedDeployment } from '../../config/registry';
import { WalletError } from '../../wallet/eip1193';
import { refusalText, sendDeploy, type GasPayer } from '../gas/payer';
import { api, ApiError } from '../api';
import { blockText, exact, shortAddress } from '../format';
import { useT, type MsgKey } from '../i18n';
import { AddressDisplay, AddressShort, IrreversibleButton, Mark, Notice } from '../primitives';
import { clearDeploy, clearDeployIf, getDeploy, putDeploy, type DeployRecord } from '../trackingStore';
import { sound } from '../sound';
import { BusyLine } from '../ux';
import { deployWord, type DeployWord } from '../stepWords';
import type { DeployPlan, DeployPlanStep, StepVerdict } from '../types';

type Run =
  | { s: 'idle' }
  | { s: 'awaiting'; key: string }
  | { s: 'sent'; key: string; txHash: Hex; verdict: StepVerdict | null; errors?: number }
  | { s: 'unknown'; key: string; resolved: boolean }
  | { s: 'rejected'; reason?: string }
  | { s: 'changed' }
  | { s: 'failed'; message: string };

const hex = (v: string | bigint) => ('0x' + BigInt(v).toString(16)) as Hex;
/** A send whose outcome is still open: planning again must not drop it. */
const inFlight = (r: Run) => r.s === 'awaiting' || r.s === 'unknown' || (r.s === 'sent' && (!r.verdict || r.verdict.state === 'pending' || r.verdict.state === 'not-found'));

export function DeployStep({
  dep,
  account,
  payer,
  onComplete,
  onPlan,
  onError,
  onWord,
}: {
  dep: SupportedDeployment;
  account: Address;
  payer: GasPayer;
  onComplete: () => void;
  onPlan: (p: DeployPlan | null) => void;
  onError: (m: string) => void;
  /** The step header's word (deployWord): reported, so the header never says "in progress" before a send. */
  onWord?: (w: DeployWord) => void;
}) {
  const { t } = useT();
  const native = dep.assets.find((a) => a.native)!.symbol;
  // The gas payer (browser wallet, File key or the runner's native signer) decides who signs; the step
  // logic is the same for all of them.
  const gasWallet = payer.address;
  const walletReady = payer.ready;
  const [plan, setPlan] = useState<DeployPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [run, setRun] = useState<Run>({ s: 'idle' });
  // Unmounted (RPC switch, a new check): answers still on their way must not ask the wallet. Set in the
  // effect too, so a remount (StrictMode) starts alive again.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const accountHash = addressDigest(account);
  const forget = () => clearDeploy(dep.chainId, dep.id, accountHash);
  // Bumped whenever a send attempt writes its record. A re-plan started before that (a slow "plan again"
  // or re-check) answers about an older picture: it must neither clear the newer record nor reset its run.
  const attempt = useRef(0);
  /** Records the in-flight step; null when storage did not keep it (then the wallet is not asked). */
  const remember = (key: string, txHash: Hex | null): DeployRecord | null => {
    if (!gasWallet) return null;
    const rec: DeployRecord = { format: 'cbpr-deploy-v1', chainId: dep.chainId, deploymentId: dep.id, accountHash, gasWalletHash: addressDigest(gasWallet), key, txHash, savedAt: Date.now() };
    return putDeploy(rec) ? rec : null;
  };

  const replan = async (): Promise<DeployPlan | null> => {
    if (!gasWallet) return null;
    setPlanning(true);
    try {
      const p = await api<DeployPlan>('/api/deploy/plan', { account, gasWallet });
      if (!alive.current) return null;
      setPlan(p);
      onPlan(p);
      if (p.complete) {
        // Only a deployment this page saw through (a step confirmed here) is this visit's event.
        if (attempt.current > 0) sound.play('done', `deploy:${dep.id}:${accountHash}:complete`);
        onComplete();
      }
      return p;
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'deployment plan failed');
      return null;
    } finally {
      setPlanning(false);
    }
  };

  const current = plan?.steps.find((s) => s.state === 'needed') ?? null;
  const n = current ? plan!.steps.indexOf(current) + 1 : 0;
  const done = plan ? plan.steps.filter((s) => s.state === 'done').length : 0;

  // After a hash: poll the step verdict until it settles, then plan again from the chain. A failed poll
  // (sidecar or RPC hiccup) retries with backoff; the in-flight record stays until a verdict arrives.
  useEffect(() => {
    if (run.s !== 'sent' || (run.verdict && run.verdict.state !== 'pending' && run.verdict.state !== 'not-found')) return;
    const errors = run.errors ?? 0;
    const delay = errors ? Math.min(30_000, 1500 * 2 ** errors) : run.verdict ? 1500 : 300;
    const id = setTimeout(async () => {
      try {
        const v = await api<StepVerdict>('/api/deploy/track', { account, key: run.key, gasWallet, txHash: run.txHash });
        if (!alive.current) return;
        // A confirmed verdict stays shown (settled: only "plan again" is offered, never this step's send)
        // until a fresh plan reads the chain; the plan from before the send is not offered again.
        setRun({ ...run, verdict: v, errors: 0 });
        if (v.state === 'reverted' || v.state === 'mismatch' || v.state === 'confirmed-no-code') sound.play('attention', `deploy:${run.txHash}:${v.state}`);
        if (v.state === 'confirmed') {
          forget();
          const p = await replan();
          if (p && alive.current) setRun({ s: 'idle' });
        }
      } catch (e) {
        if (!alive.current) return;
        onError(e instanceof ApiError ? e.message : 'tracking failed');
        setRun({ ...run, errors: errors + 1 });
      }
    }, delay);
    return () => clearTimeout(id);
  }, [run]);

  /** No hash (lost answer, or a reload before one arrived): never resend — check the chain for the step. */
  // `resolved` means a fresh plan was read from the chain and the step is still needed; a failed re-read
  // stays unresolved (only "check again" is offered) and the record is kept.
  const resolveUnknown = async (key: string) => {
    const gen = attempt.current;
    const before = getDeploy(dep.chainId, dep.id, accountHash);
    setRun({ s: 'unknown', key, resolved: false });
    const p = await replan();
    if (!p || gen !== attempt.current) return;
    if (p.steps.find((x) => x.key === key)?.state === 'done') {
      if (before) clearDeployIf(before);
      setRun({ s: 'idle' });
    } else setRun({ s: 'unknown', key, resolved: true });
  };

  /**
   * The user's explicit "plan again" after an unknown or a settled failure: the record is dropped and the
   * step can be offered only after a fresh plan succeeds. If the re-read fails, nothing changes.
   */
  const planAgain = async () => {
    const gen = attempt.current;
    const before = getDeploy(dep.chainId, dep.id, accountHash);
    const p = await replan();
    if (!p || gen !== attempt.current) return;
    if (before) clearDeployIf(before);
    setRun({ s: 'idle' });
  };

  // A send recorded before a reload: resume it instead of offering the step again. A record from another
  // gas wallet cannot be tracked by hash here, so it is treated like a lost answer.
  useEffect(() => {
    if (!gasWallet || !walletReady) return;
    const rec = getDeploy(dep.chainId, dep.id, accountHash);
    if (!rec) return;
    if (rec.txHash && rec.gasWalletHash === addressDigest(gasWallet)) setRun({ s: 'sent', key: rec.key, txHash: rec.txHash, verdict: null });
    else void resolveUnknown(rec.key);
  }, [gasWallet, walletReady, accountHash]);

  // Entering the step plans at once (a chain read and a fork simulation — nothing is signed or spent), so
  // the first thing on screen is the step to confirm. A send recorded before a reload resumes instead.
  const autoPlanned = useRef(false);
  useEffect(() => {
    if (autoPlanned.current || !gasWallet || !walletReady || plan || planning) return;
    if (getDeploy(dep.chainId, dep.id, accountHash)) return;
    autoPlanned.current = true;
    void replan();
  }, [gasWallet, walletReady]);

  const deploy = async (shown: DeployPlanStep) => {
    if (!gasWallet || !walletReady || !plan) return;
    const shownFees = plan.fees;
    // Re-read the chain right before the wallet is asked: someone else may have deployed this target while
    // the user reviewed it (a duplicate CREATE2 would revert and spend gas), or the transaction / fee may
    // have changed. Only the exact step the user confirmed, still needed and unchanged, is sent.
    const fresh = await replan();
    if (!fresh) return;
    const s = fresh.steps.find((x) => x.key === shown.key);
    const next = fresh.steps.find((x) => x.state === 'needed');
    if (!s || s.state !== 'needed' || next?.key !== s.key || s.to !== shown.to || s.data !== shown.data || s.gasLimit !== shown.gasLimit || BigInt(fresh.fees.maxFeePerGas) > BigInt(shownFees.maxFeePerGas)) {
      // Nothing was asked. The fresh plan is on screen; the user reviews and confirms again (or moves on).
      return setRun({ s: 'changed' });
    }
    // This attempt's own record: a late answer to it touches the store only while that record is still
    // the stored one — a newer attempt for the same account (after leaving and planning again) keeps its own.
    const own = remember(s.key, null);
    const gen = ++attempt.current;
    // Whether this attempt is still the latest one: a wallet answer to an older attempt (for example after
    // a gas-wallet switch and an explicit re-plan) never replaces the newer attempt's state on screen.
    const latest = () => gen === attempt.current;
    if (!own) {
      // Without the record a reload mid-step could offer this step again: do not ask the wallet.
      return setRun({ s: 'failed', message: t('storage.unavailable') });
    }
    setRun({ s: 'awaiting', key: s.key });
    try {
      const r = await sendDeploy(payer, { account, key: s.key, tx: { from: gasWallet, to: s.to, data: s.data, gas: hex(s.gasLimit!), maxFeePerGas: hex(fresh.fees.maxFeePerGas), maxPriorityFeePerGas: hex(fresh.fees.maxPriorityFeePerGas) } }, dep.chainId, () => alive.current);
      if (r.outcome === 'rejected') {
        clearDeployIf(own);
        // A browser wallet's refusal is the user's cancel; a File / native relay refusal has a reason.
        if (latest()) setRun(payer.via === 'browser-wallet' ? { s: 'rejected' } : { s: 'rejected', reason: refusalText(t, r) });
        return;
      }
      if (r.outcome === 'hash') {
        // If this update is lost, the hash-less record still makes a reload re-check the chain, never resend.
        if (JSON.stringify(getDeploy(dep.chainId, dep.id, accountHash)) === JSON.stringify(own)) remember(s.key, r.txHash);
        if (latest()) setRun({ s: 'sent', key: s.key, txHash: r.txHash, verdict: null });
        return;
      }
      if (latest()) await resolveUnknown(s.key);
    } catch (e) {
      // sendExact throws only before the request (wrong account / chain, or this step was left during
      // those checks): nothing was sent.
      clearDeployIf(own);
      if ((e instanceof WalletError && e.code === 'cancelled') || !latest()) return;
      setRun({ s: 'failed', message: e instanceof WalletError ? e.message : 'the wallet did not answer' });
    }
  };

  const settled = run.s === 'sent' && !!run.verdict && run.verdict.state !== 'pending' && run.verdict.state !== 'not-found';
  const settledBad = settled && (run.verdict?.state === 'reverted' || run.verdict?.state === 'mismatch' || run.verdict?.state === 'confirmed-no-code');
  const word = deployWord({ gasReady: !!gasWallet && walletReady, planning, run: run.s, settled, settledBad });
  useEffect(() => onWord?.(word), [word, onWord]);

  if (!gasWallet || !walletReady) return <p className="lb-help" data-testid="deploy-need-wallet">{t('deploy.needWallet')}</p>;

  const stepName = (k: string) => t(`deploy.step.${k}` as MsgKey);
  const busy = planning || run.s === 'awaiting' || run.s === 'sent';
  const sentSettled = settled;

  return (
    <div className="lb-form" data-testid="deploy" data-progress={plan ? `${done}/${plan.steps.length}` : ''}>
      <p className="lb-lead">{t('deploy.lead')}</p>
      {planning && <BusyLine testId="deploy-planning" slow="sim">{t('deploy.planning')}</BusyLine>}
      {plan && (
        <section className="lb-paper">
          <p className="lb-progress" data-testid="deploy-progress">
            {t('deploy.progress', { done, total: plan.steps.length })}
          </p>
          <ol className="lb-substeps">
            {plan.steps.map((s, i) => (
              <li key={s.key} data-step={s.key} data-state={s.state} aria-current={s === current ? 'step' : undefined}>
                <Mark ok={s.state === 'done'} pending={s.state !== 'done'} />
                <span className="lb-substep-name">
                  {i + 1}. {stepName(s.key)}
                </span>
                <span className="lb-detail">{s.state === 'done' ? t('deploy.verified') : s === current ? '' : t('deploy.waiting')}</span>
                {s === current && (
                  <dl className="lb-dl lb-dl-tight">
                    {payer.address && (
                      <div>
                        <dt>{t('deploy.payer')}</dt>
                        <dd>
                          <AddressDisplay value={payer.address} testId="deploy-payer" />
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>{t('deploy.to')}</dt>
                      <dd>
                        <AddressShort value={s.to} />
                      </dd>
                    </div>
                    <div>
                      <dt>{t('deploy.input')}</dt>
                      <dd className="lb-mono" title={s.inputHash}>
                        {shortAddress(s.inputHash)}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('deploy.gas')}</dt>
                      <dd className="lb-mono">{blockText(s.gasLimit ?? '0')}</dd>
                    </div>
                    <div>
                      <dt>{t('deploy.maxFee')}</dt>
                      <dd className="lb-mono">{exact(plan.fees.maxFeePerGas, 9)} gwei</dd>
                    </div>
                    <div>
                      <dt />
                      <dd>{t('deploy.cost', { cost: exact(s.maxCostWei ?? '0', 18), native })}</dd>
                    </div>
                    <div>
                      <dt />
                      <dd className="lb-help">{t('deploy.simulated', { block: blockText(plan.block) })}</dd>
                    </div>
                  </dl>
                )}
              </li>
            ))}
          </ol>
          {plan.gasWalletSufficient === false && plan.gasWallet && (
            <Notice tone="bad" testId="deploy-gas-short">
              {t('deploy.gasShort', { balance: exact(plan.gasWallet.balance, 18), native, need: exact(plan.totalMaxCostWei, 18) })}
            </Notice>
          )}
          {plan.complete && <Notice tone="ok" testId="deploy-done">{t('deploy.done')}</Notice>}
        </section>
      )}

      {run.s === 'rejected' && (
        <Notice tone="warn" testId={run.reason === undefined ? 'deploy-rejected' : 'deploy-refused'}>
          {run.reason === undefined ? t('deploy.rejected') : t('deploy.refused', { reason: run.reason || t('gas.refusedUnknown') })}
        </Notice>
      )}
      {run.s === 'changed' && <Notice tone="warn" testId="deploy-changed">{t('deploy.changed')}</Notice>}
      {run.s === 'failed' && <Notice tone="bad">{t('wallet.error', { reason: run.message })}</Notice>}
      {run.s === 'awaiting' && <BusyLine testId="deploy-awaiting" slow="send">{t('deploy.awaiting', { n })}</BusyLine>}
      {run.s === 'sent' && !sentSettled && <BusyLine testId="deploy-in-flight">{t('deploy.inBlockWait', { hash: shortAddress(run.txHash) })}</BusyLine>}
      {run.s === 'sent' && sentSettled && (
        <Notice tone={run.verdict?.state === 'reverted' || run.verdict?.state === 'mismatch' || run.verdict?.state === 'confirmed-no-code' ? 'bad' : 'idle'} testId="deploy-sent">
          {run.verdict?.state === 'reverted'
            ? t('deploy.reverted', { n })
            : run.verdict?.state === 'mismatch' || run.verdict?.state === 'confirmed-no-code'
              ? t('deploy.mismatch', { detail: run.verdict.detail })
              : t('deploy.sent', { hash: shortAddress(run.txHash) })}
        </Notice>
      )}
      {run.s === 'unknown' && (
        <div className="lb-paper lb-paper-warn" data-testid="deploy-unknown">
          <p>{t('deployUnknown.body', { n })}</p>
          {!run.resolved && !planning && (
            <button type="button" className="lb-btn" onClick={() => void resolveUnknown(run.key)} data-testid="deploy-recheck">
              {t('deployUnknown.recheck')}
            </button>
          )}
          {run.resolved && (
            <>
              <p className="lb-help">{t('deployUnknown.cost')}</p>
              <button type="button" className="lb-btn" disabled={planning} onClick={() => void planAgain()} data-testid="deploy-replan">
                {t('deployUnknown.replan', { n })}
              </button>
            </>
          )}
        </div>
      )}

      <div className="lb-actionbar">
        {!plan || sentSettled ? (
          <button type="button" className="lb-btn lb-btn-primary" disabled={planning} onClick={() => void (sentSettled ? planAgain() : replan().then((p) => p && setRun((r) => (inFlight(r) ? r : { s: 'idle' }))))} data-testid="deploy-plan">
            {planning ? t('deploy.planning') : t('deploy.plan')}
          </button>
        ) : current && run.s !== 'unknown' ? (
          <IrreversibleButton
            label={t('deploy.cta', { n })}
            title={t('deploy.confirmTitle', { n, step: stepName(current.key) })}
            confirmLabel={t('deploy.cta', { n })}
            disabled={busy || plan.gasWalletSufficient === false}
            onConfirm={() => void deploy(current)}
            testId="deploy-send"
          >
            <p>{t('deploy.confirmBody')}</p>
            {payer.address && (
              <p className="lb-kv">
                <span className="lb-k">{t('deploy.payer')}</span>
                <AddressDisplay value={payer.address} testId="deploy-confirm-payer" />
              </p>
            )}
            <p className="lb-kv">
              <span className="lb-k">{t('deploy.to')}</span>
              <code className="lb-mono">{current.to}</code>
            </p>
            <p>{t('deploy.cost', { cost: exact(current.maxCostWei ?? '0', 18), native })}</p>
          </IrreversibleButton>
        ) : null}
      </div>
    </div>
  );
}
