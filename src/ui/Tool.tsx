// Passkey Recovery by sd0x — the tool at /recover, the M4 logbook (design guidelines §3 Direction A, §4,
// §13.3). One vertical <ol>: Check wallet → Deploy wallet → Move funds → Track. Its own chunk: loaded on the
// first visit to /recover, then kept mounted (hidden) while the site pages show, so a step in progress
// survives reading the guide. All state is React memory except tracking records (./trackingStore.ts), which
// hold public chain data only.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SUPPORTED } from '../config/registry';
import { api, ApiError, hasConnection, lastDrop, onConnectionChange, pageKind, pairedRunner, retryRunner, runnerLost, setSignerBase, sidecarMode, sidecarSession, versionDiffers, type PageKind } from './api';
import { REPO_URL, VERSION } from '../config/release';
import { PATH } from './site/routes';
import { downloadJson } from './common';
import { shortAddress } from './format';
import { useT, type MsgKey } from './i18n';
import { Notice, Sheet, ToolShowing } from './primitives';
import { ProofPanel } from './ProofPanel';
import { buildReport } from './report';
import { RpcPanel, type RpcChange, type RpcState } from './RpcSettings';
import { CheckStep, type CheckInput } from './steps/CheckStep';
import { DeployStep } from './steps/DeployStep';
import { MoveStep, type MoveDraft } from './steps/MoveStep';
import { TrackStep } from './steps/TrackStep';
import { addressDigest } from '../transfer/intent';
import { newIntentGate, sameTrackAnswer, type IntentGate } from './trackPoll';
import { loadTracks, type StoredTrack } from './trackingStore';
import type { DeployPlan, Diagnosis, TrackResult, TransferPlan } from './types';
import { GasPanel } from './gas/GasPanel';
import { useGasPayer, type GasPayerState } from './gas/useGasPayer';
import { LOCAL_PREVIEW, PairPanel } from './PairPanel';
import { CopyButton, SoundToggle, StepIntro } from './ux';
import { checkWord, moveWord, trackWord, type DeployWord } from './stepWords';
import { answerApplies, coverBlock, landedAfter, shownBalanceRead, type BalanceAsk, type BalanceRead } from './balanceRead';
import type { Hex } from 'viem';

const dep = SUPPORTED[0]!;
const DEPLOY_WORD: Record<DeployWord, MsgKey> = { needsGas: 'step.needsGas', planning: 'step.planning', gasPayer: 'step.gasPayer', inBlock: 'step.inBlock', attention: 'step.attention', yourTurn: 'step.yourTurn' };
type StepKey = 'check' | 'deploy' | 'move' | 'track';
type StepState = 'done' | 'current' | 'waiting' | 'notNeeded';
/** The RPC-changed notice: loud until a check succeeds on that endpoint or it is dismissed, then a status note. */
type RpcNote = { at: number; epoch: number; demoted: boolean };

function rpcOverall(s: RpcState | null): MsgKey {
  const c = s?.capabilities;
  if (!c) return 'top.rpcUnchecked';
  if (c.simulationReady) return 'top.rpcReady';
  return c.chain.status === 'ok' && c.read.status === 'ok' ? 'top.rpcLimited' : 'top.rpcFailed';
}

/** `active`: /recover is the page showing. While another page shows, the tool keeps its state but no sheet. */
export default function Tool({ active }: { active: boolean }) {
  const { t, lang } = useT();
  // Local: the page came from the runner (session in its meta tag). Hosted: connected once paired (HOST-05).
  const [hasSidecar, setHasSidecar] = useState(hasConnection);
  // Which pairing this page holds (hosted; null on the runner page): a new pairing is a new connection even
  // when "connected" stayed true across the switch.
  const [pairing, setPairing] = useState(pairedRunner);
  // Runner page, website, or a static preview no runner pairs with (6-recovery-atlas.md §6.2).
  const kind = pageKind();
  const hosted = kind === 'website';
  const mode = sidecarSession() !== null ? sidecarMode() : (pairedRunner()?.mode ?? null);
  const gas = useGasPayer(dep);
  const wallet = gas.wallet;
  const payer = gas.payer;
  useEffect(
    () =>
      onConnectionChange(() => {
        const now = hasConnection();
        const runner = pairedRunner();
        // Other events share this signal (the native signer's address arriving): only a different pairing —
        // or none, the paired runner having stopped answering — is a new connection.
        if (runner !== connRunner.current) {
          connRunner.current = runner;
          conn.current++;
          // What was read through the old connection is void as on an endpoint change, even when the new
          // runner reports the same epoch: its diagnosed accounts start empty. The typed account is kept, and a
          // check still in flight is dropped when it answers (or fails).
          voidForEndpoint();
        }
        // The runner page losing its own runner is not a new connection: the same process answers again (what
        // it holds is unchanged) or a restarted one refuses the session (only a reload continues). So a plan
        // the runner has not confirmed discarded — a Discard or Clear that failed to reach it — stays on screen.
        setHasSidecar(now);
        setPairing(runner);
        // The runner ended the session (restart, idle timeout): say what to do, not just "not paired".
        if (!now && lastDrop() === 'runner') setNotice('notice.repair');
        if (!now && lastDrop() === 'offline') setNotice('notice.lost');
      }),
    [],
  );
  // The runner says where its native signer listens (secret-bearing calls go there, never to the sidecar).
  // `signerFor` is the pairing whose runner named the signer the page holds (null on the runner page).
  const signerFor = useRef<ReturnType<typeof pairedRunner>>(null);
  useEffect(() => {
    const letGo = () => {
      signerFor.current = null;
      setSignerBase(null);
    };
    if (!hasSidecar) {
      // The runner page's lost runner is the same signer (one process tree): the gas payer it holds is not
      // another payer, so no plan is voided for it. Only an ended pairing (the hosted page) lets the signer go.
      // Decided by which page this is, not by whether the runner answers right now: a signer answer landing
      // between the loss and this effect would otherwise read as "not lost" and let the signer go.
      if (sidecarSession() === null) letGo();
      return;
    }
    // The answer belongs to the connection that asked: a late one for an earlier pairing (or after this
    // effect was left) never sets or clears the signer of the connection the page holds now.
    let live = true;
    const at = pairedRunner();
    const mine = () => live && pairedRunner() === at;
    void api<{ runner?: { nativeSignerUrl?: string | null } }>('/api/config').then(
      (c) => {
        if (!mine()) return;
        signerFor.current = at;
        setSignerBase(c.runner?.nativeSignerUrl ?? null);
      },
      // No answer about this connection's signer: the signer this same connection already named stands (the
      // runner page's runner failing again while it is reconnecting is still that signer, and a plan waiting on
      // it is not voided); one that another pairing named is let go.
      () => mine() && signerFor.current !== at && letGo(),
    );
    return () => {
      live = false;
    };
  }, [hasSidecar, pairing]);

  const [rpc, setRpc] = useState<RpcState | null>(null);
  const epoch = useRef<number | null>(null);
  // Which connection the page holds (bumped when the connection is lost or the pairing changes) and the one
  // `epoch` was read on: epochs only grow within one runner process, but a new runner starts again from its own.
  const conn = useRef(0);
  const connRunner = useRef(pairedRunner());
  const epochConn = useRef(0);
  const [epochKey, setEpochKey] = useState(0);
  const [diag, setDiag] = useState<Diagnosis | null>(null);
  const diagRef = useRef(diag);
  diagRef.current = diag;
  // The account a voided diagnosis was for: Check opens again with it typed in.
  const [checkAccount, setCheckAccount] = useState('');
  const [checking, setChecking] = useState(false);
  const [editCheck, setEditCheck] = useState(false);
  const [deployedHere, setDeployedHere] = useState(false);
  const [deployPlan, setDeployPlan] = useState<DeployPlan | null>(null);
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [tracks, setTracks] = useState<StoredTrack[]>(() => loadTracks());
  // Wallet tx hashes the browser refused to save, by userOpHash: Track still uses them in this visit.
  const [walletLeads, setWalletLeads] = useState<Record<string, Hex>>({});
  const [results, setResults] = useState<Record<string, TrackResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<MsgKey | null>(null);
  const [rpcNote, setRpcNote] = useState<RpcNote | null>(null);
  const [sheet, setSheet] = useState<null | 'rpc' | 'help' | 'report' | 'proof' | 'gas' | 'pair'>(null);
  // Leaving /recover closes whatever sheet was open; everything the steps hold stays as it was.
  useEffect(() => {
    if (!active) setSheet(null);
  }, [active]);
  const [moveKey, setMoveKey] = useState(0);
  // The unauthorised transfer the user is typing, per RPC epoch, transfer and account (memory only): it
  // outlives a gas-payer switch, which remounts Move and voids its plan and proof (MoveDraft).
  const moveDraft = useRef(new Map<string, MoveDraft>());
  const draftKey = (account: string) => `${epochKey}:${moveKey}:${account.toLowerCase()}`;
  const lastInput = useRef<CheckInput | null>(null);

  // Only the latest check's answer is shown: an older one arriving later never replaces it.
  const checkSeq = useRef(0);
  // PM-06: Move's balances read again after a transfer of this wallet lands or a new transfer starts. Only the
  // latest read, for the same account, RPC epoch and connection, is applied (balanceRead.ts).
  const balanceSeq = useRef(0);
  const [balanceRead, setBalanceRead] = useState<BalanceRead>({ state: 'fresh', error: null });
  // The transfer Move sent last (PM-09): Track marks it "this transfer" and is not "all final" until it is.
  const [currentOp, setCurrentOp] = useState<string | null>(null);
  // A new endpoint voids what was read through the old one: unsent plans, and the diagnosis — balances and
  // deployment state came from that endpoint, so Check opens again (the typed account kept) and a check
  // still in flight is dropped when it answers.
  const voidForEndpoint = useCallback(() => {
    setEpochKey((k) => k + 1);
    setDeployPlan(null);
    setPlan(null);
    checkSeq.current++;
    balanceSeq.current++;
    setBalanceRead({ state: 'fresh', error: null });
    setChecking(false);
    // Read now, not inside an updater: by the time React runs one, the diagnosis is already cleared.
    const was = diagRef.current?.account;
    if (was) setCheckAccount(was);
    setDiag(null);
  }, []);
  // An answer is applied only for the connection that asked, and never when it is older than the endpoint
  // state already shown (the first state request can answer after a change made in the RPC sheet).
  const onRpcState = useCallback((s: RpcState, at: number = conn.current) => {
    if (at !== conn.current) return;
    if (epochConn.current === at && epoch.current !== null && s.epoch < epoch.current) return;
    setRpc(s);
    if (epoch.current !== null && s.epoch !== epoch.current) {
      // The sidecar voided every unsent plan on the switch; drop ours so nothing stale is shown. The notice
      // belongs to this endpoint: a later switch raises a fresh one.
      voidForEndpoint();
      setNotice((n) => (n === 'notice.rpcChanging' ? null : n));
      setRpcNote({ at: Date.now(), epoch: s.epoch, demoted: false });
    }
    epoch.current = s.epoch;
    epochConn.current = at;
  }, [voidForEndpoint]);
  useEffect(() => {
    if (!hasSidecar) return;
    const at = conn.current;
    void api<RpcState>('/api/rpc/state').then((s) => onRpcState(s, at), () => undefined);
  }, [hasSidecar, onRpcState]);
  // A gas payer change voids this page's unsent plans as the runner does (GAS-04); records stay tracked.
  const payerEpoch = useRef(payer.epoch);
  useEffect(() => {
    if (payerEpoch.current === payer.epoch) return;
    payerEpoch.current = payer.epoch;
    setDeployPlan(null);
    setPlan(null);
    // An error about a plan this voids (e.g. "Not cleared") would point at something no longer on screen.
    setError(null);
    setNotice('notice.payerChanged');
  }, [payer.epoch]);
  // An endpoint change voids this page's unsent plans when it starts, not when its answer arrives: the
  // sidecar switches (and a re-check re-pins) before it answers, and a send still inside the wallet's
  // account/chain checks must not go out on a plan that is already void. Remounting the steps voids their
  // in-flight requests; the answer is applied here, so closing the RPC sheet meanwhile loses nothing.
  const changeRpc = useCallback<RpcChange>(
    async (path, body) => {
      voidForEndpoint();
      setNotice('notice.rpcChanging');
      const at = conn.current;
      const s = await api<RpcState>(path, body);
      onRpcState(s, at);
      return s;
    },
    [onRpcState, voidForEndpoint],
  );

  const check = async (input: CheckInput) => {
    const seq = ++checkSeq.current;
    const at = epoch.current;
    lastInput.current = input;
    setChecking(true);
    setError(null);
    try {
      const d = await api<Diagnosis>('/api/diagnose', { account: input.account, ...(input.evidence ? { evidence: input.evidence } : {}) });
      if (seq !== checkSeq.current) return;
      balanceSeq.current++;
      // A Check answered from before this account's last transfer in a block is not shown as fresh: see `shownRead`.
      setBalanceRead({ state: 'fresh', error: null });
      setDiag(d);
      // A successful check through the new endpoint is what makes the RPC-changed notice old news; a receipt
      // that happens to succeed does not (it says nothing about what this page read before the switch).
      if (at !== null && at === epoch.current) setRpcNote((n) => (n && n.epoch === at ? { ...n, demoted: true } : n));
      setEditCheck(false);
      setDeployPlan(null);
      setPlan(null);
      setMoveKey((k) => k + 1);
    } catch (e) {
      if (seq === checkSeq.current) setError(e instanceof ApiError ? (e.kind === 'no-sidecar' ? t('error.noSidecar') : e.kind === 'offline' ? t('error.offline') : e.message) : 'check failed');
    } finally {
      if (seq === checkSeq.current) setChecking(false);
    }
  };

  // Reads the balances again (a read of state only: no plan, no signature, no unlock). Merged into the
  // diagnosis without remounting Move, so what the user typed and any plan on screen stay as they are.
  const refreshBalances = useCallback(async () => {
    const d = diagRef.current;
    if (!d) return;
    if (!hasConnection()) {
      // No runner to ask (PM-06): the figure on screen is not fresh, Review waits, and "Try again" asks once more.
      balanceSeq.current++;
      setBalanceRead({ state: 'failed', error: t(sidecarSession() !== null ? 'error.offline' : 'error.noSidecar') });
      return;
    }
    const asked: BalanceAsk = { seq: ++balanceSeq.current, epoch: epoch.current, conn: conn.current, account: d.account };
    const now = (): BalanceAsk => ({ seq: balanceSeq.current, epoch: epoch.current, conn: conn.current, account: diagRef.current?.account ?? '' });
    setBalanceRead({ state: 'reading', error: null });
    const ev = lastInput.current && lastInput.current.account.toLowerCase() === d.account.toLowerCase() ? lastInput.current.evidence : undefined;
    try {
      const fresh = await api<Diagnosis>('/api/diagnose', { account: d.account, ...(ev ? { evidence: ev } : {}) });
      if (!answerApplies(asked, now()) || fresh.account.toLowerCase() !== d.account.toLowerCase()) return;
      // An RPC answering from before this account's last transfer in a block: not the latest balances. The figure
      // on screen stays, Review waits, and "Try again" reads once more.
      const need = coverRef.current;
      if (need !== null && BigInt(fresh.block) < BigInt(need)) {
        setBalanceRead({ state: 'failed', error: t('move.balanceBehind', { got: fresh.block, need }) });
        return;
      }
      setDiag((cur) => (cur && cur.account.toLowerCase() === fresh.account.toLowerCase() ? { ...cur, balances: fresh.balances, block: fresh.block } : cur));
      setBalanceRead({ state: 'fresh', error: null });
    } catch (e) {
      if (!answerApplies(asked, now())) return;
      setBalanceRead({ state: 'failed', error: e instanceof ApiError ? (e.kind === 'no-sidecar' ? t('error.noSidecar') : e.kind === 'offline' ? t('error.offline') : e.message) : 'read failed' });
    }
  }, [t]);
  const coverRef = useRef<string | null>(null);
  coverRef.current = coverBlock(tracks, results, diag ? addressDigest(diag.account) : null);
  // What Move is shown, against the tracking state of this render (PM-06).
  const shownRead = shownBalanceRead(balanceRead, diag?.block ?? null, coverRef.current, (got, need) => t('move.balanceBehind', { got, need }));
  // A transfer of this wallet landed in a block later than the balances on screen: read them once (a failed
  // read waits for the user's retry, never a loop).
  const autoFor = useRef(new Set<string>());
  useEffect(() => {
    if (!diag) return;
    const hit = landedAfter(tracks, results, addressDigest(diag.account), diag.block, autoFor.current);
    if (!hit.length) return;
    for (const k of hit) autoFor.current.add(k);
    void refreshBalances();
  }, [diag, tracks, results, refreshBalances]);
  // "Next transfer" / "Clear and start over" (PM-07): a fresh form, the balances read again. Nothing is sent or
  // revoked; records and their nonce gates stay as they are.
  const newTransfer = useCallback(() => {
    setError(null);
    setMoveKey((k) => k + 1);
    setCurrentOp(null);
    void refreshBalances();
  }, [refreshBalances]);
  const currentResult = useMemo(() => {
    const h = plan?.userOpHash ?? currentOp;
    if (!h) return null;
    const s = tracks.find((x) => x.record.userOpHash === h.toLowerCase());
    return s ? (results[`${s.record.userOpHash}:${s.record.txHash ?? ''}`] ?? null) : null;
  }, [plan?.userOpHash, currentOp, tracks, results]);

  const deployNeeded = !!diag?.supported && diag.needs.length > 0;
  const [deployW, setDeployW] = useState<DeployWord>(payer.ready ? 'yourTurn' : 'needsGas');
  // Track's word comes from the latest answer for every record, not from being the last step.
  const tWord = trackWord(
    tracks.map((s) => ({ result: results[`${s.record.userOpHash}:${s.record.txHash ?? ''}`], nonce: s.record.nonce, hash: s.record.userOpHash })),
    currentOp,
  );
  const steps: Record<StepKey, StepState> = {
    check: !diag || !diag.supported || editCheck ? 'current' : 'done',
    deploy: !diag?.supported || editCheck ? 'waiting' : deployNeeded ? 'current' : deployedHere ? 'done' : 'notNeeded',
    move: diag?.supported && !deployNeeded && !editCheck ? 'current' : 'waiting',
    track: !tracks.length ? 'waiting' : tWord === 'final' ? 'done' : 'current',
  };
  const word = (k: StepKey, st: StepState): MsgKey => {
    // Check is "in progress" only while it reads; before that it says what it needs or where to start.
    if (k === 'check' && st === 'current') {
      const w = checkWord({ connected: hasSidecar, reading: checking, hasResult: !!diag && !editCheck });
      return w === 'needsRunner' ? 'step.needsRunner' : w === 'reading' ? 'step.reading' : w === 'result' ? 'step.seeResult' : 'step.start';
    }
    if (k === 'track' && tracks.length) return tWord === 'final' ? 'step.allFinal' : tWord === 'attention' ? 'step.attention' : 'step.current';
    if (k === 'move' && st === 'current') {
      const w = moveWord(plan);
      return w === 'choose' ? 'step.chooseTransfer' : w === 'ready' ? 'step.readyToSend' : w === 'sent' ? 'step.sent' : 'step.continueTransfer';
    }
    // Deploy says what really runs (planning, the gas payer, the block) and is otherwise the user's turn.
    if (k === 'deploy' && st === 'current') return DEPLOY_WORD[deployW];
    return stateWord[st];
  };

  const onDeployComplete = useCallback(() => {
    setDeployedHere(true);
    if (lastInput.current) void check({ account: lastInput.current.account });
    // eslint-free: check is stable enough for this one-shot re-read after deployment
  }, []);

  const report = useMemo(
    () =>
      buildReport({
        generatedAt: new Date().toISOString(),
        mode,
        chain: { chainId: dep.chainId, name: dep.chainName, deploymentId: dep.id },
        rpc: rpc && { source: rpc.upstream.source, overall: rpcOverall(rpc).replace('top.rpc', '').toLowerCase(), capabilities: rpc.capabilities ? (['chain', 'read', 'consistency', 'estimate', 'stateOverride', 'fork', 'archive', 'broadcast'] as const).map((id) => ({ id, status: rpc.capabilities![id].status })) : [] },
        wallet: wallet.provider ? { connected: !!wallet.account, chainId: wallet.chainId } : null,
        gasPayer: { mode: payer.mode, ready: payer.ready },
        diagnosis: diag && { account: diag.account, supported: diag.supported, block: diag.block, checks: diag.checks, blockers: diag.blockers, needs: diag.needs, passkeyOwnerIndexes: diag.passkeyOwners.map((o) => o.index), nonce: diag.balances.nonce },
        deploy: deployPlan && { complete: deployPlan.complete, steps: deployPlan.steps.map((s) => ({ key: s.key, state: s.state })) },
        transfer: plan && { state: plan.state, asset: plan.asset.symbol, amount: plan.intent.amount, recipient: plan.intent.recipient, nonce: plan.op.nonce, ownerIndex: plan.ownerIndex, signable: plan.signable, notSignableReason: plan.notSignableReason, signedSim: plan.signedSim && { success: plan.signedSim.success, problems: plan.signedSim.problems }, sendOutcome: plan.send?.outcome ?? null },
        tracks: tracks.map((s) => {
          const r = results[`${s.record.userOpHash}:${s.record.txHash ?? ''}`];
          return { state: r?.state ?? 'not-read', detail: r?.detail ?? '', confirmations: r?.confirmations ?? null, asset: s.symbol, amount: s.record.intent.amount };
        }),
        lastError: error,
      }),
    // Rebuilt when the sheet opens, so generatedAt is the moment the user looked.
    // eslint-free dependency list: sheet toggles the rebuild.
    [sheet, mode, rpc, wallet.provider, wallet.account, wallet.chainId, payer.mode, payer.ready, diag, deployPlan, plan, tracks, results, error],
  );

  // Any field a gate or the report reads counts as a change: the nonce or the scan's completeness can move
  // while the state stays "unknown", and that is what opens a new intent.
  const onResult = useCallback(
    (key: string, r: TrackResult | null) =>
      setResults((m) => {
        const o = m[key];
        if (!r) {
          if (!o) return m;
          const { [key]: _gone, ...rest } = m;
          return rest;
        }
        return o && sameTrackAnswer(o, r) ? m : { ...m, [key]: r };
      }),
    [],
  );
  // Before a new intent (architecture §5): every earlier record of THIS account must be reconciled — its
  // op ran, its nonce is still the op's, or a complete scan shows the nonce went to another op.
  const gates = useMemo(() => {
    const mine = diag ? addressDigest(diag.account) : null;
    const byOp: Record<string, IntentGate> = {};
    const own: string[] = [];
    const nonceOf: Record<string, string> = {};
    for (const s of tracks) {
      byOp[s.record.userOpHash] = newIntentGate(results[`${s.record.userOpHash}:${s.record.txHash ?? ''}`], s.record.nonce);
      nonceOf[s.record.userOpHash] = s.record.nonce;
      if (s.record.senderHash === mine) own.push(s.record.userOpHash);
    }
    return { byOp, own, nonceOf };
  }, [diag, tracks, results]);
  const onPlan = useCallback((p: TransferPlan | null) => setPlan(p), []);
  const onSendStart = useCallback((userOpHash: string) => setCurrentOp(userOpHash.toLowerCase()), []);
  const onSendNone = useCallback((userOpHash: string) => setCurrentOp((c) => (c === userOpHash.toLowerCase() ? null : c)), []);
  const onDeployPlan = useCallback((p: DeployPlan | null) => setDeployPlan(p), []);

  const label = (k: StepKey) => t(`step.${k}` as MsgKey);
  const stateWord: Record<StepState, MsgKey> = { done: 'step.done', current: 'step.current', waiting: 'step.waiting', notNeeded: 'step.notNeeded' };
  const glyph: Record<StepState, string> = { done: '✓', current: '●', waiting: '○', notNeeded: '–' };
  const summary: Partial<Record<StepKey, ReactNode>> = {
    check: diag && (
      <>
        <code className="lb-mono" title={diag.account}>
          {shortAddress(diag.account)}
        </code>{' '}
        <button type="button" className="lb-btn lb-btn-link" onClick={() => setEditCheck(true)} data-testid="check-edit">
          {t('check.run')}
        </button>
        {diag.passkeyOwners.length > 0 && (
          <>
            {' '}
            <button type="button" className="lb-btn lb-btn-link" onClick={() => setSheet('proof')} data-testid="summary-prove">
              {t('proof.open')}
            </button>
          </>
        )}
      </>
    ),
  };

  const time = (ms: number) => new Date(ms).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });

  return (
    <ToolShowing.Provider value={active}>
      <div className="lb-toolbar" data-testid="topbar">
        <span className="lb-chain" data-testid="top-chain">
          {dep.chainName} {dep.chainId}
        </span>
        <div className="lb-top-actions" role="group" aria-label={t('top.label')}>
          <button type="button" className="lb-chip" onClick={() => setSheet('rpc')} disabled={!hasSidecar} data-testid="top-rpc">
            {t('top.rpc', { state: t(rpcOverall(rpc)) })}
          </button>
          {hosted && (
            <button type="button" className={`lb-chip${hasSidecar ? '' : ' lb-chip-strong'}`} onClick={() => setSheet('pair')} data-testid="top-pair">
              {hasSidecar ? t('pair.chipPaired') : t('pair.chip')}
            </button>
          )}
          <GasChip g={gas} onOpen={() => setSheet('gas')} />
          <SoundToggle />
          <button type="button" className="lb-chip" onClick={() => setSheet('help')} data-testid="top-help">
            {t('top.help')}
          </button>
          <button type="button" className="lb-chip" onClick={() => setSheet('report')} data-testid="top-report">
            {t('top.report')}
          </button>
        </div>
      </div>

      <CapabilityStrip kind={kind} connected={hasSidecar} rpc={rpc} g={gas} onPair={() => setSheet('pair')} onGas={() => setSheet('gas')} />
      {mode === 'testchain' && <p className="lb-banner lb-banner-local" data-testid="testchain-banner">{t('app.testchain')}</p>}
      {!hasSidecar && <Notice tone="bad" testId="no-sidecar">{t(hosted ? 'error.notPaired' : kind === 'static-preview' ? 'error.staticPreview' : 'error.offline', { url: LOCAL_PREVIEW })}</Notice>}
      {rpcNote &&
        (rpcNote.demoted ? (
          <p className="lb-help lb-status-note" data-testid="rpc-changed-note">
            {t('notice.rpcChangedNote', { time: time(rpcNote.at) })}
          </p>
        ) : (
          <div className="lb-notice-row">
            <Notice tone="warn" testId="rpc-changed">
              {t('notice.rpcChangedAt', { time: time(rpcNote.at) })} {t('notice.rpcChanged')}
            </Notice>
            <button type="button" className="lb-btn lb-btn-link" onClick={() => setRpcNote((n) => n && { ...n, demoted: true })} data-testid="rpc-changed-close">
              {t('sheet.close')}
            </button>
          </div>
        ))}
      {notice && (
        <div className="lb-notice-row">
          <Notice tone={notice === 'notice.paired' ? 'ok' : 'warn'} testId="app-notice">{t(notice)}</Notice>
          <button type="button" className="lb-btn lb-btn-link" onClick={() => setNotice(null)}>
            {t('sheet.close')}
          </button>
        </div>
      )}
      {error && <Notice tone="bad" testId="app-error">{error}</Notice>}
      {wallet.error && <Notice tone="bad" testId="wallet-error">{t('wallet.error', { reason: wallet.error })}</Notice>}

      <ol className="lb-steps" data-testid="logbook">
        {(['check', 'deploy', 'move', 'track'] as const).map((k) => {
          const st = steps[k];
          const current = st === 'current' && k !== 'track';
          // Track's records stay reachable whatever its word: a final receipt is still something to read.
          const open = k === 'track' ? tracks.length > 0 : st === 'current';
          return (
            <li key={k} className={`lb-step lb-step-${st}`} data-step={k} data-state={st} data-word={word(k, st).replace('step.', '')} aria-current={current ? 'step' : undefined} id={current ? 'current-step' : undefined} tabIndex={current ? -1 : undefined}>
              <h2 className="lb-step-head">
                <span className="lb-step-glyph" aria-hidden="true">
                  {k === 'track' && tWord === 'attention' && tracks.length ? '!' : glyph[st]}
                </span>
                <span className="lb-step-name">{label(k)}</span>
                <span className="lb-step-state" data-testid={`step-word-${k}`}>{t(word(k, st))}</span>
                {st === 'done' && summary[k] && <span className="lb-step-summary">{summary[k]}</span>}
              </h2>
              {open && (
                <div className="lb-step-body">
                  <StepIntro step={k} />
                  {k === 'check' && <CheckStep dep={dep} diag={diag} account0={checkAccount} busy={checking} blocked={!hasSidecar} onCheck={(i) => void check(i)} onReport={() => setSheet('report')} onProve={() => setSheet('proof')} />}
                  {k === 'deploy' && diag && <DeployStep key={`d${epochKey}-${payer.epoch}`} dep={dep} account={diag.account} payer={payer} onComplete={onDeployComplete} onPlan={onDeployPlan} onError={setError} onWord={setDeployW} />}
                  {k === 'move' && diag && <MoveStep key={`m${epochKey}-${moveKey}-${payer.epoch}`} dep={dep} diag={diag} payer={payer} gates={gates} draft={moveDraft.current.get(draftKey(diag.account)) ?? null} onDraft={(d) => void (d ? moveDraft.current.set(draftKey(diag.account), d) : moveDraft.current.delete(draftKey(diag.account)))} onPlan={onPlan} onTracked={setTracks} onError={setError} balance={shownRead} onRefreshBalance={() => void refreshBalances()} onSendStart={onSendStart} onSendNone={onSendNone} result={currentResult} onNewTransfer={newTransfer} onHashNotSaved={(op, h) => setWalletLeads((m) => ({ ...m, [op]: h }))} />}
                  {k === 'track' && <TrackStep dep={dep} tracks={tracks} gates={gates.byOp} hints={{ account: diag?.account ?? null, gasWallet: payer.address }} onChange={setTracks} onResult={onResult} onNewTransfer={newTransfer} current={currentOp} leads={walletLeads} />}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      <Sheet open={sheet === 'rpc'} onClose={() => setSheet(null)} title={t('rpc.title')} testId="sheet-rpc" wide>
        <div lang={lang} data-testid="rpc-settings">
          <p className="lb-lead">{t('rpc.lead')}</p>
          <RpcPanel onState={onRpcState} change={changeRpc} />
        </div>
      </Sheet>
      <Sheet open={sheet === 'proof' && !!diag && diag.passkeyOwners.length > 0} onClose={() => setSheet(null)} title={t('proof.title')} testId="sheet-proof" wide>
        {diag && diag.passkeyOwners.length > 0 && <ProofPanel key={`p${epochKey}-${diag.account}`} dep={dep} account={diag.account} owners={diag.passkeyOwners} />}
      </Sheet>
      <Sheet open={sheet === 'gas'} onClose={() => setSheet(null)} title={t('gas.title')} testId="sheet-gas" wide>
        <GasPanel dep={dep} g={gas} onReady={() => setSheet(null)} />
      </Sheet>
      {hosted && (
        <Sheet open={sheet === 'pair'} onClose={() => setSheet(null)} title={t('pair.title')} testId="sheet-pair" wide>
          <PairPanel
            onPaired={() => {
              setSheet(null);
              setNotice('notice.paired');
            }}
          />
        </Sheet>
      )}
      <Sheet open={sheet === 'help'} onClose={() => setSheet(null)} title={t('help.title')} testId="sheet-help">
        <HelpBody />
      </Sheet>
      <Sheet open={sheet === 'report'} onClose={() => setSheet(null)} title={t('report.title')} testId="sheet-report" wide>
        <p>{t('report.lead')}</p>
        <pre className="lb-code-block" tabIndex={0} data-testid="report-json">
          {JSON.stringify(report, null, 2)}
        </pre>
        <div className="lb-actions">
          <button type="button" className="lb-btn" onClick={() => downloadJson(`passkey-recovery-report-${Date.now()}.json`, report)} data-testid="report-download">
            {t('report.download')}
          </button>
          <CopyButton text={JSON.stringify(report, null, 2)} label={t('report.copy')} done={t('report.copied')} testId="report-copy" />
        </div>
      </Sheet>
    </ToolShowing.Provider>
  );
}

/** Local page whose runner stopped answering: ask it again in place; only a restarted runner needs a reload. */
function RunnerLost() {
  const { t } = useT();
  const [tried, setState] = useState<'idle' | 'busy' | 'offline' | 'restarted'>('idle');
  // A refused session is known without a retry (a call already got it): say "reload" straight away.
  const state = tried === 'idle' && runnerLost() === 'stale' ? 'restarted' : tried;
  return (
    <span data-testid="caps-lost">
      {t('caps.runner.lost')}{' '}
      <button
        type="button"
        className="lb-btn lb-btn-link"
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy');
          void retryRunner().then((r) => setState(r === 'ok' ? 'idle' : r));
        }}
        data-testid="caps-retry"
      >
        {t(state === 'busy' ? 'caps.runner.retrying' : 'caps.runner.retry')}
      </button>
      {state === 'offline' && (
        <span className="lb-help" role="status" data-testid="caps-still-lost">
          {' '}
          {t('caps.runner.stillLost')}
        </span>
      )}
      {state === 'restarted' && (
        <span className="lb-help" role="alert" data-testid="caps-reload">
          {' '}
          {t('caps.runner.reload')}
        </span>
      )}
    </span>
  );
}

/**
 * Who does what (UX behaviour 10): where this page came from, whether a runner answers it, where checks
 * and simulations run, who pays gas and when XPL is spent. Facts, not an "online/local" badge.
 */
function CapabilityStrip({ kind, connected, rpc, g, onPair, onGas }: { kind: PageKind; connected: boolean; rpc: RpcState | null; g: GasPayerState; onPair: () => void; onGas: () => void }) {
  const { t } = useT();
  const p = pairedRunner();
  const modeLabel = t(`gas.mode.${g.mode}` as MsgKey);
  const payerText = g.payer.ready && g.payer.address ? t('caps.payer.ready', { mode: modeLabel, addr: shortAddress(g.payer.address) }) : g.mode === 'wallet' && !g.walletId ? t('caps.payer.none') : t('caps.payer.setup', { mode: modeLabel });
  const rows: Array<{ k: string; label: MsgKey; value: ReactNode; ok: boolean }> = [
    { k: 'ui', label: 'caps.ui', value: t(kind === 'website' ? 'caps.ui.site' : kind === 'runner' ? 'caps.ui.local' : 'caps.ui.preview', { origin: location.origin }), ok: true },
    {
      k: 'runner',
      label: 'caps.runner',
      value:
        kind === 'runner' ? (
          connected ? t('caps.runner.self', { version: VERSION }) : <RunnerLost />
        ) : kind === 'static-preview' ? (
          <span data-testid="caps-preview">
            {t('caps.runner.preview')}{' '}
            <a href={LOCAL_PREVIEW} data-testid="caps-preview-link">
              {LOCAL_PREVIEW}
            </a>
          </span>
        ) : p ? (
          <>
            {t('caps.runner.paired', { base: p.base, version: p.version })}
            {versionDiffers(p.version, VERSION) && (
              <span className="lb-help" data-testid="caps-version-differs">
                {' '}
                {t('caps.runner.versionDiffers', { runner: p.version, page: VERSION })}
              </span>
            )}
          </>
        ) : (
        <>
          {t('caps.runner.none')}{' '}
          <button type="button" className="lb-btn lb-btn-link" onClick={onPair} data-testid="caps-pair">
            {t('caps.runner.connect')}
          </button>
        </>
      ),
      ok: connected,
    },
    { k: 'sim', label: 'caps.sim', value: connected ? t('caps.sim.local', { rpc: rpc ? t(`rpc.source.${rpc.upstream.source}` as MsgKey) : t('top.rpcUnchecked') }) : t('caps.sim.none'), ok: connected },
    {
      k: 'payer',
      label: 'caps.payer',
      value: (
        <button type="button" className="lb-btn lb-btn-link" onClick={onGas} title={g.payer.address ?? undefined} data-testid="caps-payer">
          {payerText}
        </button>
      ),
      ok: g.payer.ready,
    },
    { k: 'spend', label: 'caps.spend', value: t('caps.spend.when'), ok: true },
  ];
  return (
    <section className="lb-caps" aria-label={t('caps.title')} data-testid="caps">
      <dl>
        {rows.map((r) => (
          <div key={r.k} data-cap={r.k} data-ok={r.ok}>
            <dt>
              <span className="lb-caps-mark" aria-hidden="true">
                {r.ok ? '●' : '○'}
              </span>
              {t(r.label)}
            </dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The gas payer at a glance; the browser-wallet chip keeps its quick connect / switch actions. */
function GasChip({ g, onOpen }: { g: GasPayerState; onOpen: () => void }) {
  const { t } = useT();
  const native = dep.assets.find((a) => a.native)!.symbol;
  const wallet = g.wallet;
  if (g.mode === 'wallet') {
    if (g.wallets.length === 0)
      return (
        <button type="button" className="lb-chip" title={t('wallet.noneHelp', { native })} onClick={onOpen} data-testid="wallet-none">
          {t('wallet.none')}
        </button>
      );
    if (!g.walletId)
      return (
        <button type="button" className="lb-chip lb-chip-strong" onClick={onOpen} data-testid="wallet-pick">
          {t('gas.wallet.pick')}
        </button>
      );
    if (!wallet.account)
      return (
        <button type="button" className="lb-chip lb-chip-strong" onClick={() => void wallet.connect()} disabled={wallet.busy} data-testid="wallet-connect">
          {wallet.busy ? t('wallet.connecting') : t('wallet.connect')}
        </button>
      );
    if (!g.payer.ready)
      return (
        <button type="button" className="lb-chip lb-chip-warn" onClick={() => void wallet.switchChain()} disabled={wallet.busy} data-testid="wallet-switch">
          {t('wallet.wrongChain', { id: wallet.chainId ?? '?' })} — {t('wallet.switch', { name: dep.chainName })}
        </button>
      );
    return (
      <button type="button" className="lb-chip" title={wallet.account} onClick={onOpen} data-testid="wallet-connected" data-account={wallet.account}>
        {t('wallet.connected', { addr: shortAddress(wallet.account) })}
      </button>
    );
  }
  // The short title: the chip sits in the top bar, where the long mode name wrapped the bar.
  const label = t(`gas.opt.${g.mode}` as MsgKey);
  return (
    <button type="button" className={`lb-chip${g.payer.ready ? '' : g.nativeLost ? ' lb-chip-warn' : ' lb-chip-strong'}`} title={g.payer.address ?? undefined} onClick={onOpen} data-testid="gas-chip" data-ready={g.payer.ready ? 'yes' : 'no'} data-lost={g.nativeLost ? 'yes' : 'no'} data-account={g.payer.address ?? ''}>
      {g.payer.ready && g.payer.address ? t('gas.chipReady', { mode: label, addr: shortAddress(g.payer.address) }) : g.nativeLost ? t('gas.chipLost', { mode: label }) : t('gas.chipSetup', { mode: label })}
    </button>
  );
}

function HelpBody() {
  const { t } = useT();
  const parts: Array<[MsgKey, MsgKey]> = [
    ['help.what', 'help.whatBody'],
    ['help.never', 'help.neverBody'],
    ['help.steps', 'help.stepsBody'],
    ['help.unknown', 'help.unknownBody'],
    ['help.ai', 'help.aiBody'],
    ['help.status', 'help.statusBody'],
  ];
  return (
    <div data-testid="help">
      {parts.map(([h, b]) => (
        <section key={h}>
          <h3>{t(h)}</h3>
          <p>{t(b)}</p>
        </section>
      ))}
      <p>
        <a href={PATH.download}>{t('help.steps.link')}</a>
      </p>
      <p>
        {t('help.runbook')} <a href={REPO_URL}>{t('help.repo')}</a>
      </p>
    </div>
  );
}
