// Step 4, Track (design guidelines §6.5–§6.7, §7). Stateless on the sidecar: each poll sends the stored
// record and gets the chain's answer. Unknown is never shown as failure; nothing here can send.
import { useEffect, useId, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import { addressDigest } from '../../transfer/intent';
import type { SupportedDeployment } from '../../config/registry';
import { api, ApiError } from '../api';
import { downloadJson } from '../common';
import { blockText, exact, fixed } from '../format';
import { useT, type MsgKey } from '../i18n';
import { AddressDisplay, AmountDisplay, Mark, Notice } from '../primitives';
import { GATE_NOTE, isSending, trackSettled, type IntentGate } from '../trackPoll';
import { isStored, putTrack, removeTrack, setScanCursor, type StoredTrack } from '../trackingStore';
import type { TrackResult } from '../types';
import { PAGE_LOADED_AT, sound } from '../sound';
import { Ladder, type LadderAt } from '../ux';

/** Where a Track answer sits on Submitted → In a block → Final; failures and unknowns never reach a success rung. */
export function ladderAt(state: TrackResult['state'] | 'loading', hasTx: boolean): LadderAt {
  if (state === 'final') return 'final';
  if (state === 'confirmed') return 'block';
  if (state === 'inner-failed' || state === 'reverted') return 'failed';
  if (state === 'pending' && hasTx) return 'sent';
  return 'unknown';
}

/** The one sound cue a Track answer may have: done for a success the chain shows, attention when the user must act. */
export function cueFor(state: TrackResult['state'] | 'loading', scan: TrackResult['scan'] = null): 'done' | 'attention' | null {
  if (state === 'confirmed' || state === 'final') return 'done';
  if (state === 'inner-failed' || state === 'reverted' || state === 'mismatch' || state === 'reorged') return 'attention';
  // "Unknown" while the event scan is still running is a passing moment (a just-sent transfer reads like
  // this for a poll or two), not something that needs the user: only a finished scan, or one the RPC
  // refused (scan: null — the user may paste the hash), calls for attention.
  if (state === 'unknown') return !scan || scan.complete ? 'attention' : null;
  return null;
}

/** Full addresses this page knows in this session; sent with a poll only when they match a record's digest. */
export interface TrackHints {
  account: Address | null;
  gasWallet: Address | null;
}

/** Re-scan this many blocks behind the head after a complete scan: an event in a reorged block is found again. */
const SCAN_OVERLAP = 64n;

/** `current`: the userOpHash Move sent last (PM-09); its row reads "This transfer", the others "Earlier transfer". */
/** `leads`: tx hashes a wallet returned in this visit that the browser refused to save, by userOpHash (memory only). */
export function TrackStep({ dep, tracks, gates, hints, onChange, onResult, onNewTransfer, current = null, leads = {} }: { dep: SupportedDeployment; tracks: StoredTrack[]; gates: Record<string, IntentGate>; hints: TrackHints; onChange: (l: StoredTrack[]) => void; onResult: (key: string, r: TrackResult | null) => void; onNewTransfer: () => void; current?: string | null; leads?: Record<string, Hex> }) {
  const { t } = useT();
  return (
    <div className="lb-form" data-testid="track">
      <p className="lb-lead">{t('track.lead')}</p>
      {tracks.length === 0 ? (
        <p className="lb-help" data-testid="track-empty">
          {t('track.empty')}
        </p>
      ) : (
        <ul className="lb-tracks">
          {tracks.map((s) => (
            <TrackRow key={`${s.record.userOpHash}:${s.record.txHash ?? ''}`} dep={dep} s={s} gate={gates[s.record.userOpHash] ?? 'unknown'} hints={hints} onChange={onChange} onResult={onResult} onNewTransfer={onNewTransfer} which={current === null ? null : current === s.record.userOpHash ? 'current' : 'earlier'} lead={leads[s.record.userOpHash] ?? null} />
          ))}
        </ul>
      )}
    </div>
  );
}

function TrackRow({ dep, s, gate, hints, onChange, onResult, onNewTransfer, which, lead = null }: { dep: SupportedDeployment; s: StoredTrack; gate: IntentGate; hints: TrackHints; onChange: (l: StoredTrack[]) => void; onResult: (key: string, r: TrackResult | null) => void; onNewTransfer: () => void; which: 'current' | 'earlier' | null; lead?: Hex | null }) {
  const { t } = useT();
  const pasteId = useId();
  const [r, setR] = useState<TrackResult | null>(null);
  const shown = useRef<TrackResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [hash, setHash] = useState('');
  const [notSaved, setNotSaved] = useState(false);
  const [pasteNotSaved, setPasteNotSaved] = useState(false);
  const cursor = useRef<string | null>(s.scanCursor);
  // A hash this row verified but the browser refused to store: later polls ask about it directly, so a scan
  // cursor that has moved past its block cannot lose it (memory only; a reload scans again).
  const foundHash = useRef<Hex | null>(null);
  // The wallet's unsaved hash for a record without one (a lead, verified like any hash); dropped with "unknown".
  const leadRef = useRef<Hex | null>(lead);
  leadRef.current = lead;
  const leadOff = useRef(false);
  const hintsRef = useRef(hints);
  hintsRef.current = hints;
  const key = `${s.record.userOpHash}:${s.record.txHash ?? ''}`;
  const native = dep.assets.find((a) => a.native)!.symbol;

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const h = hintsRef.current;
        const sender = h.account && addressDigest(h.account) === s.record.senderHash ? h.account : undefined;
        const gasWallet = h.gasWallet && addressDigest(h.gasWallet) === s.record.gasWalletHash ? h.gasWallet : undefined;
        const known = foundHash.current ?? (s.record.txHash === null && !leadOff.current ? leadRef.current : null);
        const record = known && known !== s.record.txHash ? { ...s.record, txHash: known } : s.record;
        const res = await api<TrackResult>('/api/track', { record, ...(cursor.current ? { scanCursor: cursor.current } : {}), ...(sender ? { sender } : {}), ...(gasWallet ? { gasWallet } : {}) });
        if (stop) return;
        // The op was found executed by a transaction other than the stored one (no hash, or a reported one
        // that reverted / did not carry it): keep that verified hash, so a refresh checks it directly
        // instead of relying on a scan whose cursor has moved past it. The row re-keys and polls again.
        // If the browser refuses to save it, the row cannot re-key: it shows this verified answer, says the
        // hash was not kept and keeps asking (so the save is tried again), rather than stopping on "loading".
        let unsaved = false;
        if (res.txHash && res.txHash.toLowerCase() !== s.record.txHash && (res.state === 'confirmed' || res.state === 'final' || res.state === 'inner-failed')) {
          const found: StoredTrack = { ...s, record: { ...s.record, txHash: res.txHash.toLowerCase() as Hex }, scanCursor: null };
          const list = putTrack(found);
          onChange(list);
          if (isStored(found, list)) return;
          setNotSaved(true);
          unsaved = true;
          foundHash.current = found.record.txHash;
        }
        shown.current = res;
        setR(res);
        setErr(null);
        onResult(key, res);
        // One cue per transfer and outcome, for a transfer sent in this visit only: a record loaded from
        // before a reload, a later poll or a tab coming back never replays it. Done counts once for the
        // first success (confirmed and final are one event).
        // A send this page has not had answered yet (wallet still open) is not yet "unknown" to the user.
        const cue = res.state === 'unknown' && isSending(s.record.userOpHash) ? null : cueFor(res.state, res.scan);
        if (cue) sound.play(cue, `track:${s.record.userOpHash}:${cue === 'done' ? 'success' : res.state}`, s.savedAt >= PAGE_LOADED_AT);
        // An incomplete event scan continues from its cursor right away; a complete one resumes next time a
        // little behind the head (reorg overlap), never from the start. The position survives a refresh.
        if (res.scan) {
          const back = BigInt(res.scan.head) - SCAN_OVERLAP;
          cursor.current = res.scan.complete ? (back > BigInt(s.record.fromBlock) ? back.toString() : null) : res.scan.cursor;
          setScanCursor(s.record.userOpHash, s.record.txHash, cursor.current);
        }
        if (unsaved) timer = setTimeout(() => void poll(), 5000);
        else if (!trackSettled(res, s.record.nonce)) timer = setTimeout(() => void poll(), res.scan && !res.scan.complete ? 50 : 3000);
      } catch (e) {
        if (stop) return;
        // The chain cannot be read now: an answer that could still change (confirmed, pending, unknown) is
        // no longer shown as current — no success heading, ladder or receipt from before the outage (a reorg
        // meanwhile would not show). A settled answer (final, a deep failure) cannot change and stays.
        // The same goes for the copy App keeps (the AI report, the next-transfer gate).
        if (shown.current && !trackSettled(shown.current, s.record.nonce)) {
          shown.current = null;
          setR(null);
          onResult(key, null);
        }
        setErr(e instanceof ApiError ? e.message : 'tracking failed');
        timer = setTimeout(() => void poll(), 5000);
      }
    };
    void poll();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [key]);

  const state = r?.state ?? 'loading';
  const tone = state === 'confirmed' || state === 'final' ? 'ok' : state === 'inner-failed' || state === 'reverted' ? 'bad' : 'idle';
  const amount = <AmountDisplay units={s.record.intent.amount} decimals={s.decimals} symbol={s.symbol} />;

  const useHash = () => {
    const h = hash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) return setErr('a transaction hash is 0x followed by 64 hex characters');
    // putTrack replaces the record of the same UserOperation in one write: nothing is removed first, so a
    // refused write leaves the open record (and the next-intent gate) as it was.
    const next: StoredTrack = { ...s, record: { ...s.record, txHash: h.toLowerCase() as Hex } };
    const list = putTrack(next);
    onChange(list);
    if (!isStored(next, list)) return setPasteNotSaved(true);
    setPasteNotSaved(false);
    setHash('');
  };
  const pasteField = (
    <div className="lb-field">
      <label htmlFor={pasteId}>{t('unknown.paste')}</label>
      <input id={pasteId} className="lb-input lb-mono" autoComplete="off" spellCheck={false} placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value)} data-testid="track-paste-hash" />
    </div>
  );
  const useHashButton = (
    <button type="button" className="lb-btn" onClick={useHash} disabled={!hash.trim()} data-testid="track-use-hash">
      {t('unknown.useHash')}
    </button>
  );
  const dropHash = () => {
    leadOff.current = true;
    foundHash.current = null;
    const next: StoredTrack = { ...s, record: { ...s.record, txHash: null } };
    const list = putTrack(next);
    onChange(list);
    setPasteNotSaved(!isStored(next, list));
  };

  const exportReceipt = () => {
    if (!r?.receipt) return;
    downloadJson(`receipt-${s.record.userOpHash.slice(2, 10)}.json`, {
      format: 'cbpr-receipt-v1',
      chain: { chainId: s.record.chainId, name: dep.chainName, deploymentId: s.record.deploymentId },
      state: r.state,
      from: r.receipt.sender,
      to: r.receipt.recipient,
      asset: s.symbol,
      amount: r.receipt.amount,
      walletNonce: s.record.nonce,
      userOpHash: s.record.userOpHash,
      txHash: r.txHash,
      block: r.block,
      confirmations: r.confirmations,
      networkFeeWei: r.receipt.outerFeeWei,
      walletFeeWei: r.receipt.actualGasCost,
      // Two legs, never summed: the network fee was paid by the bundle sender, the wallet fee by this wallet
      // to the handleOps beneficiary.
      networkFeePaidBy: r.receipt.bundler,
      walletFeePaidTo: r.receipt.beneficiary,
      evidence: { receipt: true, walletCall: true, tokenTransfer: s.record.intent.asset !== 'native' },
    });
  };

  return (
    <li className={`lb-track lb-tone-border-${tone}`} data-testid="track-row" data-state={state} data-abandoned={s.abandoned} data-userop-hash={s.record.userOpHash} data-current={which ?? undefined}>
      {which && (
        <p className="lb-help lb-track-which" data-testid="track-which">
          {t(which === 'current' ? 'track.thisTransfer' : 'track.earlierTransfer')}
        </p>
      )}
      <h3 className={`lb-tone-${tone}`} aria-live={tone === 'bad' ? 'assertive' : 'polite'}>
        {t(`track.state.${state}` as MsgKey)}
      </h3>
      {r && <Ladder at={ladderAt(state, !!(r.txHash ?? s.record.txHash))} />}
      <p>
        {amount} →{' '}
        {r?.receipt ? (
          <AddressDisplay value={r.receipt.recipient} />
        ) : (
          <span className="lb-mono" data-testid="track-recipient-short">
            {s.record.intent.recipientShort}
          </span>
        )}
      </p>
      <dl className="lb-dl lb-dl-tight">
        <div>
          <dt>{t('check.nonce')}</dt>
          <dd className="lb-mono">{s.record.nonce}</dd>
        </div>
        {r?.txHash && (
          <div>
            <dt>Tx</dt>
            <dd className="lb-mono lb-break" data-testid="track-tx">
              {r.txHash}
            </dd>
          </div>
        )}
      </dl>
      {err && <Notice tone="bad">{err}</Notice>}
      {pasteNotSaved && (
        <Notice tone="bad" testId="track-paste-not-saved">
          {t('track.pasteNotSaved')}
        </Notice>
      )}
      {notSaved && (
        <Notice tone="warn" testId="track-not-saved">
          {t('track.notSaved')}
        </Notice>
      )}
      {state === 'pending' && <p>{t('pending.body')}</p>}
      {state === 'reorged' && <p>{t('reorg.body')}</p>}
      {state === 'reverted' && <p>{t('reverted.body')}</p>}
      {state === 'inner-failed' && <p>{t('inner.body', { symbol: s.symbol })}</p>}
      {r && <p className="lb-help">{r.detail}</p>}
      {r?.scan && !r.scan.complete && <p className="lb-help">{t('track.scan', { from: blockText(r.scan.cursor), to: blockText(r.scan.head) })}</p>}
      {state === 'mismatch' && (
        <>
          <p>{t('mismatch.body')}</p>
          <button type="button" className="lb-btn" onClick={dropHash} data-testid="track-drop-hash">
            {t('track.state.unknown')}
          </button>
        </>
      )}
      {/* No answer yet and the last poll failed: a hash from the wallet can still be pasted for a record without one. */}
      {r === null && err !== null && !s.record.txHash && (
        <div className="lb-paper lb-paper-warn" data-testid="track-error-paste">
          {pasteField}
          <div className="lb-actions">{useHashButton}</div>
        </div>
      )}
      {state === 'unknown' && (
        <div className="lb-paper lb-paper-warn" data-testid="track-unknown">
          <p>{s.abandoned ? t('abandoned.body') : t('unknown.body')}</p>
          {pasteField}
          <div className="lb-actions">
            {useHashButton}
            {!s.abandoned && (
              <button type="button" className="lb-btn lb-btn-quiet" onClick={() => onChange(putTrack({ ...s, abandoned: true }))} data-testid="track-abandon">
                {t('unknown.abandon')}
              </button>
            )}
          </div>
          {s.abandoned && (
            <>
              <p data-testid="track-gate" data-gate={gate}>{t(GATE_NOTE[gate])}</p>
              <button type="button" className="lb-btn" onClick={onNewTransfer} disabled={gate === 'unknown'} data-testid="track-separate">
                {t('abandoned.separate')}
              </button>
            </>
          )}
        </div>
      )}
      {(state === 'confirmed' || state === 'final') && r?.receipt && (
        <div className="lb-receipt" data-testid="receipt">
          {s.abandoned && <Notice tone="ok">{t('abandoned.alreadyDone')}</Notice>}
          <h4>{t('track.receipt')}</h4>
          <p>
            {t('track.arrived', { amount: r.receipt.amount, symbol: r.receipt.symbol })} <AddressDisplay value={r.receipt.recipient} />
          </p>
          <p>{t('track.block', { block: blockText(r.block ?? '0'), n: r.confirmations ?? '0' })}</p>
          <p className="lb-help">{t('track.final', { n: r.finalityDepth })}</p>
          <ul className="lb-evidence" aria-label="evidence">
            <li>
              <Mark ok /> {t('track.evidence.receipt')}
            </li>
            <li>
              <Mark ok /> {t('track.evidence.call')}
            </li>
            {s.record.intent.asset !== 'native' && (
              <li>
                <Mark ok /> {t('track.evidence.transfer')}
              </li>
            )}
          </ul>
          <FeeLegs receipt={r.receipt} native={native} />
          <button type="button" className="lb-btn lb-btn-quiet" onClick={exportReceipt} data-testid="receipt-export">
            {t('track.export')}
          </button>
        </div>
      )}
      {/* Only a settled answer may be forgotten: an unsettled record still feeds the new-intent gate (a
          reverted outer tx whose op may yet run elsewhere, a shallow result a reorg can undo). */}
      {r && trackSettled(r, s.record.nonce) && (
        <button type="button" className="lb-btn lb-btn-quiet" onClick={() => onChange(removeTrack(s.record.userOpHash, s.record.txHash))} data-testid="track-remove">
          {t('track.remove')}
        </button>
      )}
    </li>
  );
}

/**
 * The two fee legs of a receipt (design guidelines §13.4): never added together, each with who paid it. The
 * "same address" line only when the decoded handleOps beneficiary is the very address that sent the bundle.
 */
function FeeLegs({ receipt, native }: { receipt: NonNullable<TrackResult['receipt']>; native: string }) {
  const { t } = useT();
  const same = !!receipt.bundler && !!receipt.beneficiary && receipt.bundler.toLowerCase() === receipt.beneficiary.toLowerCase();
  return (
    <div className="lb-fees" data-testid="receipt-fees">
      <p className="lb-help">{t('track.feeApart')}</p>
      <dl className="lb-dl lb-dl-tight">
        <div data-testid="fee-network">
          <dt>{t('track.networkFee')}</dt>
          <dd className="lb-mono">{receipt.outerFeeWei === null ? '?' : `${fixed(receipt.outerFeeWei, 18)} ${native}`}</dd>
          <dd className="lb-help">
            {t('track.networkFee.role')} {receipt.bundler && <AddressDisplay value={receipt.bundler} />}
          </dd>
        </div>
        <div data-testid="fee-wallet">
          <dt>{t('track.walletFee')}</dt>
          <dd className="lb-mono">{`${exact(receipt.actualGasCost, 18)} ${native}`}</dd>
          <dd className="lb-help">
            {t('track.walletFee.role')} {receipt.beneficiary && <AddressDisplay value={receipt.beneficiary} />}
          </dd>
          {same && (
            <dd className="lb-help" data-testid="fee-same">
              {t('track.feeSame')}
            </dd>
          )}
        </div>
      </dl>
    </div>
  );
}
