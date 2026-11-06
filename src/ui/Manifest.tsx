// The manifest (design guidelines §3, §6.3): the seven fields of the transfer the Passkey will sign.
// Before a review it mirrors the form as typed (marked as a draft); after it shows only what the
// sidecar previewed — the values the UserOp hash commits to.
import { useId } from 'react';
import type { SupportedDeployment } from '../config/registry';
import { blockText, exact } from './format';
import { useT } from './i18n';
import { AddressDisplay, AmountDisplay } from './primitives';
import type { TransferPlan } from './types';

export interface Draft {
  source: string;
  recipient: string;
  assetId: string;
  amount: string;
}

export function Manifest({ dep, plan, draft }: { dep: SupportedDeployment; plan: TransferPlan | null; draft: Draft }) {
  const { t } = useT();
  const titleId = useId();
  const native = dep.assets.find((a) => a.native)!.symbol;
  // No asset chosen yet → nothing is implied: the draft shows a dash, never a default asset.
  const asset = plan ? plan.asset : dep.assets.find((a) => a.id === draft.assetId) ?? null;
  const valid = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
  return (
    <aside className="lb-manifest" aria-labelledby={titleId} data-testid="manifest" data-verified={!!plan}>
      <h3 id={titleId}>{t('review.title')}</h3>
      <p className="lb-manifest-amount" data-testid="manifest-amount">
        {plan ? <AmountDisplay units={plan.intent.amount} decimals={plan.asset.decimals} symbol={plan.asset.symbol} big /> : <span className="lb-amount lb-amount-big lb-draft"><span className="lb-mono">{draft.amount || '—'}</span> <span className="lb-unit">{asset?.symbol ?? ''}</span></span>}
      </p>
      <dl className="lb-dl">
        <div>
          <dt>{t('review.network')}</dt>
          <dd>
            {dep.chainName} ({dep.chainId})
          </dd>
        </div>
        <div>
          <dt>{t('review.from')}</dt>
          <dd>{valid(plan?.intent.source ?? draft.source) ? <AddressDisplay value={plan?.intent.source ?? draft.source} testId="manifest-from" /> : '—'}</dd>
        </div>
        <div>
          <dt>{t('review.to')}</dt>
          <dd>{valid(plan?.intent.recipient ?? draft.recipient) ? <AddressDisplay value={plan?.intent.recipient ?? draft.recipient} testId="manifest-to" /> : '—'}</dd>
        </div>
        <div>
          <dt>{t('review.asset')}</dt>
          <dd>
            {asset?.symbol ?? '—'}
            {asset && asset.id !== 'native' && (
              <>
                {' '}
                <code className="lb-mono lb-small">{asset.id}</code>
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>{t('review.nonce')}</dt>
          <dd className="lb-mono" data-testid="manifest-nonce">
            {plan ? plan.op.nonce : '—'}
          </dd>
        </div>
        {plan && (
          <>
            <div>
              <dt>{t('review.owner')}</dt>
              <dd>{t('check.ownerIndex', { index: plan.ownerIndex })}</dd>
            </div>
            <div>
              <dt>{t('review.gasWallet')}</dt>
              <dd>
                <AddressDisplay value={plan.gasWallet} testId="manifest-payer" />
              </dd>
            </div>
            <div className="lb-fee" data-testid="fee-network">
              <dt>{t('fee.network')}</dt>
              <dd className="lb-mono">{t('fee.networkValue', { max: exact(plan.feeSummary.networkMaxWei, 18), native })}</dd>
            </div>
            <div className="lb-fee" data-testid="fee-wallet">
              <dt>{t('fee.wallet')}</dt>
              <dd className="lb-mono">{t('fee.walletValue', { max: exact(plan.feeSummary.walletMaxWei, 18), native })}</dd>
            </div>
            {BigInt(plan.feeSummary.reserveWei) > 0n && (
              <div className="lb-fee" data-testid="fee-reserve">
                <dt />
                <dd>{t('fee.reserve', { reserve: exact(plan.feeSummary.reserveWei, 18), native })}</dd>
              </div>
            )}
            <div>
              <dt>{t('review.checked')}</dt>
              <dd>{t('review.checkedValue', { block: blockText(plan.signedSim?.forkBlock ?? plan.snapshotBlock) })}</dd>
            </div>
          </>
        )}
      </dl>
    </aside>
  );
}
