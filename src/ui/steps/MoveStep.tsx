// Step 3, Move funds (design guidelines §6.3–§6.4, §8). Four states kept apart on screen and in the
// sidecar: draft → review (previewed) → signed (the exact signed op passed a fork simulation) → send
// (one wallet request, never repeated). A tracking record is stored before the wallet is asked, so a
// reload during the wallet prompt still finds the transfer.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { getAddress, type Address, type Hex } from 'viem';
import type { SupportedDeployment } from '../../config/registry';
import { hexToBytes } from '../../crypto/bytes';
import { buildHelper } from '../../webauthn/helper';
import { sendExact, WalletError, type Eip1193 } from '../../wallet/eip1193';
import { refusalText, relayTransfer, type GasPayer } from '../gas/payer';
import { api, ApiError } from '../api';
import { BookmarkletSigner } from '../BookmarkletSigner';
import { ExtensionBridge } from '../ExtensionBridge';
import { exact, mmss, shortAddress } from '../format';
import { useT } from '../i18n';
import { Manifest } from '../Manifest';
import { AddressDisplay, Field, IrreversibleButton, Notice } from '../primitives';
import { beginSending, GATE_NOTE, gatesOnlyUnreadable, nonceAgrees, type IntentGate } from '../trackPoll';
import { isStored, loadTracks, putTrack, removeTrackIf, trackListFull, type StoredTrack } from '../trackingStore';
import type { Diagnosis, SendRequest, TrackResult, TransferPlan } from '../types';
import { overBalance, type BalanceRead } from '../balanceRead';
import { BusyLine, CopyButton } from '../ux';

const ADDR = /^0x[0-9a-fA-F]{40}$/;

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * What the user typed for a transfer that is not authorised yet. Kept by the parent (memory only) so a
 * gas-payer switch, which remounts this step and voids any plan and Passkey proof, does not also throw
 * the typing away. The cross-check tick and the Terminal payer address are not kept: both belong to the
 * payer and the exact moment they were given.
 */
export interface MoveDraft {
  ownerIndex: number;
  assetId: string;
  amount: string;
  to: string;
  again: string;
  pasted: boolean;
}

export function MoveStep({
  dep,
  diag,
  payer: gas,
  gates,
  draft = null,
  onDraft,
  onPlan,
  onTracked,
  onError,
  balance: balanceRead = { state: 'fresh', error: null },
  onRefreshBalance,
  onSendStart,
  onSendNone,
  result = null,
  onNewTransfer,
  onHashNotSaved,
}: {
  dep: SupportedDeployment;
  diag: Diagnosis;
  payer: GasPayer;
  /** Each record's gate (architecture §5), the records of THIS account, and each record's op nonce. */
  gates: { byOp: Record<string, IntentGate>; own: string[]; nonceOf: Record<string, string> };
  draft?: MoveDraft | null;
  onDraft?: (d: MoveDraft | null) => void;
  onPlan: (p: TransferPlan | null) => void;
  onTracked: (list: StoredTrack[]) => void;
  onError: (m: string) => void;
  /** Whether the balances in `diag` are the latest read (PM-06): Review waits while they are read again or failed. */
  balance?: BalanceRead;
  onRefreshBalance?: () => void;
  /** A send or hand-off of this plan starts: it is "this transfer" in Track (PM-09). */
  onSendStart?: (userOpHash: string) => void;
  /** Definitely nothing left and no record is kept for it: Track stops calling it this transfer. */
  onSendNone?: (userOpHash: string) => void;
  /** Track's latest answer for this plan's record, if any (PM-07: "Next transfer" only after a success). */
  result?: TrackResult | null;
  /** A fresh form for the next transfer, or to start over (the parent remounts this step). */
  onNewTransfer?: () => void;
  /** The browser refused to save the wallet's tx hash in the tracking record: Track uses it from memory for this visit. */
  onHashNotSaved?: (userOpHash: Hex, txHash: Hex) => void;
}) {
  const { t } = useT();
  const provider = gas.provider;
  const gasWallet = gas.address;
  const walletReady = gas.ready;
  const ids = { owner: useId(), asset: useId(), amount: useId(), to: useId(), again: useId(), cross: useId(), assertion: useId(), payer: useId() };
  const [ownerIndex, setOwnerIndex] = useState(draft && diag.passkeyOwners.some((o) => o.index === draft.ownerIndex) ? draft.ownerIndex : (diag.passkeyOwners[0]?.index ?? 0));
  // Every part of the intent is the user's choice: no asset is preselected (M3-1).
  const [assetId, setAssetId] = useState<string>(draft?.assetId ?? '');
  const [amount, setAmount] = useState(draft?.amount ?? '');
  const [to, setTo] = useState(draft?.to ?? '');
  const [again, setAgain] = useState(draft?.again ?? '');
  const [pasted, setPasted] = useState(draft?.pasted ?? false);
  const [crossChecked, setCrossChecked] = useState(false);
  // Without a browser wallet the transfer can still be prepared for the Terminal signer (hand-off): the
  // user types that signer's public gas-wallet address (`npm run signer -- status` prints it). Only the
  // hand-off is offered then; sending from this page needs that same address connected as the wallet.
  const [termPayer, setTermPayer] = useState('');
  const [plan, setPlanState] = useState<TransferPlan | null>(null);
  const [busy, setBusy] = useState<null | 'review' | 'sign' | 'send' | 'handoff' | 'clear' | 'discard'>(null);
  const [assertion, setAssertion] = useState('');
  const [sigError, setSigError] = useState<string | null>(null);
  // The wallet's hash for this plan that the browser refused to save (shown so it can be pasted after a reload).
  // Shown only while the stored record still lacks it: once Track verifies and saves it, the warning goes.
  const [hashNotSaved, setHashNotSaved] = useState<{ planId: string; userOpHash: Hex; txHash: Hex } | null>(null);
  const hashStillUnsaved = !!hashNotSaved && !loadTracks().some((x) => x.record.userOpHash === hashNotSaved.userOpHash && x.record.txHash === hashNotSaved.txHash);
  const [sendNote, setSendNote] = useState<null | 'rejected' | 'refused' | 'handed-off' | 'fee-raised'>(null);
  const [handoff, setHandoff] = useState<{ code: string; expiresAt: number } | null>(null);
  const now = useNow(!!plan);
  // Earlier records of this account, other than `except` (a plan's own record): open only when none is
  // `unknown`; the signature changes whenever any of them changes gate.
  const earlier = (except?: string) => gates.own.filter((h) => h !== except).map((h) => [h, gates.byOp[h] ?? 'unknown'] as const).sort();
  const openFor = (except?: string) => earlier(except).every(([, g]) => g !== 'unknown');
  const sigFor = (except?: string) => JSON.stringify(earlier(except));
  // A plan agrees with the earlier records only if its nonce is the one each gate implies (same-nonce:
  // equal; executed / nonce-used: past it). The plan's own hash is left out, as in `sigFor`.
  const agreesFor = (p: TransferPlan) => nonceAgrees(p.op.nonce, earlier(p.userOpHash).map(([h, g]) => [g, gates.nonceOf[h] ?? '0'] as const));
  const gatesOpen = openFor();
  const liveSig = useRef<(except?: string) => string>(sigFor);
  liveSig.current = sigFor;
  const liveOpen = useRef<(except?: string) => boolean>(openFor);
  liveOpen.current = openFor;
  const liveAgrees = useRef(agreesFor);
  liveAgrees.current = agreesFor;

  // The plan whose hand-off, made as a hold began, the runner has not confirmed discarded (its code is never
  // shown): Send and a new hand-off wait for Discard or Clear to be confirmed. Any other plan on screen ends it.
  const [cancelPending, setCancelPending] = useState<string | null>(null);
  const setPlan = (p: TransferPlan | null) => {
    setPlanState(p);
    setCancelPending((c) => (c !== null && c !== p?.id ? null : c));
    onPlan(p);
  };
  // The plan on screen as of the last render, for an answer that must not land on a later one.
  const planNow = useRef<TransferPlan | null>(null);
  planNow.current = plan;
  // The parent remounts this step when the RPC endpoint changes; the sidecar has voided the plan too.
  useEffect(() => () => onPlan(null), [onPlan]);
  // Once anything went to the wallet the typing is spent: a remount must not offer it again as a fresh form.
  // `handedFor`: the plan whose transaction is with the payer (wallet, File key or native signer) with no
  // answer in yet — the local plan still reads "signed" then, but the payer may already have broadcast it.
  // Bound to that plan: a new transfer (no plan) is typing of its own again.
  const [handedFor, setHandedFor] = useState<string | null>(null);
  const spent = !!plan && (plan.id === handedFor || plan.state === 'sending' || plan.state === 'sent' || plan.state === 'unknown');
  useEffect(() => onDraft?.(spent ? null : { ownerIndex, assetId, amount, to, again, pasted }), [spent, ownerIndex, assetId, amount, to, again, pasted, onDraft]);

  const asset = dep.assets.find((a) => a.id === assetId) ?? null;
  const balance = !asset ? null : asset.native ? diag.balances.native : diag.balances.tokens[asset.id as string] ?? null;
  const same = to.trim() !== '' && to.trim().toLowerCase() === again.trim().toLowerCase();
  // A paste into EITHER recipient field asks for an independent cross-check; the tick is for one exact
  // address, so any edit to either field clears it. Emptying both fields starts over.
  const onPasteAddress = () => {
    setPasted(true);
    setCrossChecked(false);
  };
  const editAddress = (which: 'to' | 'again', v: string) => {
    setCrossChecked(false);
    if (which === 'to') setTo(v);
    else setAgain(v);
    if (v.trim() === '' && (which === 'to' ? again : to).trim() === '') setPasted(false);
  };
  const browserPayer = gasWallet && walletReady ? gasWallet : null;
  const payer: Address | null = browserPayer ?? (ADDR.test(termPayer.trim()) ? getAddress(termPayer.trim()) : null);
  const over = !!asset && overBalance(amount, asset.decimals, balance === null ? null : BigInt(balance));
  // The chosen asset's balance did not come back in the latest read (a failed token read): no figure to check against.
  const unread = !!asset && balance === null && balanceRead.state === 'fresh';
  // Review (in the form, or again after expiry) only on the latest balances, with a figure, and within it (PM-06).
  const balanceOk = balanceRead.state === 'fresh' && !over && !unread;
  const formOk = !!asset && ADDR.test(to.trim()) && same && amount.trim() !== '' && (!pasted || crossChecked) && !!payer && gatesOpen && balanceOk;
  const expired = plan ? now > plan.validUntil : false;
  const challenge = useMemo(() => (plan ? hexToBytes(plan.userOpHash) : null), [plan?.userOpHash]);
  const helper = useMemo(() => (challenge ? buildHelper(challenge, 'userop') : null), [challenge]);

  const fail = (e: unknown, fallback: string) => {
    const m = e instanceof ApiError ? e.message : e instanceof WalletError ? e.message : fallback;
    onError(m);
    return m;
  };

  // The draft as the user sees it now. A preview answers for the draft it was asked about: if any part of
  // the intent changed while it was in flight, that answer is not this draft's review (it is discarded).
  const draftKey = JSON.stringify([ownerIndex, assetId, amount.trim(), to.trim(), again.trim(), pasted, crossChecked, payer]);
  const liveDraft = useRef(draftKey);
  liveDraft.current = draftKey;

  // The earlier records as they stood when the plan on screen was accepted. Any change in them while the
  // plan is unsent (one ran, its nonce moved, its fate became unknown) voids that plan: the user reviews
  // again against what is now known, never signs or sends a plan built on an older picture.
  const planGate = useRef<string | null>(null);
  // Plans voided by that check. A request already in flight for one (signature, simulation, send, hand-off)
  // must not bring it back when its answer arrives, and above all must not go on to ask the wallet.
  const voided = useRef(new Set<string>());
  // The send in flight, and whether the wallet has been asked yet: once it has, the plan is not voided
  // from here (what the wallet does is tracked instead).
  const sendFlight = useRef<{ id: string; walletAsked: boolean; heldOff?: boolean; endSending?: () => void } | null>(null);
  // While the gates are held (an earlier record unreadable, see `gateHeld` below) nothing is handed to the wallet
  // or the signer: read at the last moment before the hand-over, so a send already under way gives up too.
  const heldRef = useRef(false);
  // A send given up under a hold whose "nothing was sent" the runner has not heard yet (it was not answering).
  const unreported = useRef<string | null>(null);
  // Unmounted (RPC switch, a new transfer, leaving the step): every plan of this instance is void for the
  // answers still on their way — none of them may ask the wallet.
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
    };
  }, []);
  const isVoid = (id: string) => gone.current || voided.current.has(id);
  /** The runner no longer knows the plan (expired, restarted): nothing is left there to discard. */
  const isGone = (e: unknown) => e instanceof ApiError && e.kind === 'http' && e.status === 404;
  const reasonOf = (e: unknown) => (e instanceof ApiError ? (e.kind === 'no-sidecar' ? t('error.noSidecar') : e.kind === 'offline' ? t('error.offline') : e.message) : String(e));

  const review = async () => {
    // Every entry (the draft form, "Review again" after expiry) passes the same reconciliation gate.
    // Review is asked only on the latest balances and an amount within them (PM-06), from the form or after expiry.
    if (!openFor() || !balanceOk) return;
    const asked = draftKey;
    const askedGate = sigFor();
    setBusy('review');
    setSendNote(null);
    setSigError(null);
    setAssertion('');
    try {
      if (plan && (plan.state === 'previewed' || plan.state === 'signed' || plan.state === 'sim-failed')) await api('/api/transfer/discard', { planId: plan.id }).catch(() => undefined);
      const p = await api<TransferPlan>('/api/transfer/preview', { source: diag.account, recipient: to.trim(), asset: asset!.id, amount: amount.trim(), gasWallet: payer, ownerIndex });
      const stale = liveDraft.current !== asked || !liveOpen.current() || liveSig.current() !== askedGate;
      // The preview read the account's nonce itself: if it is not the one the gates imply, an earlier op
      // moved it and the tracker has not seen that yet — this plan is not accepted.
      const disagrees = !stale && !liveAgrees.current(p);
      if (stale || disagrees) {
        await api('/api/transfer/discard', { planId: p.id }).catch(() => undefined);
        setPlan(null);
        if (disagrees) onError(t('move.earlierChanged'));
        return;
      }
      // Kept in the same form the on-screen check below compares against (the plan's own hash left out).
      planGate.current = liveSig.current(p.userOpHash);
      setPlan(p);
    } catch (e) {
      if (liveDraft.current === asked) fail(e, 'preview failed');
      setPlan(null);
    } finally {
      setBusy(null);
    }
  };

  const assertionBox = useRef<HTMLTextAreaElement>(null);
  /** `text`: a proof just pasted or handed over by the extension, checked at once (no extra press). */
  const submitSignature = async (text = assertion) => {
    if (!plan || busy !== null || !text.trim()) return;
    setBusy('sign');
    setSigError(null);
    try {
      const next = await api<TransferPlan>('/api/transfer/signature', { planId: plan.id, intentHash: plan.intentHash, assertion: text });
      if (isVoid(plan.id)) return;
      setPlan(next);
      setAssertion('');
    } catch (e) {
      if (isVoid(plan.id)) return;
      setSigError(e instanceof ApiError && e.status === 422 ? e.message : fail(e, 'signature check failed'));
      if (e instanceof ApiError && e.status === 409) setPlan(null);
      // Retry is one paste: the wrong proof stays visible and selected, so the next paste replaces it.
      requestAnimationFrame(() => assertionBox.current?.select());
    } finally {
      setBusy(null);
    }
  };

  const resimulate = async () => {
    if (!plan) return;
    setBusy('sign');
    try {
      const next = await api<TransferPlan>('/api/transfer/resimulate', { planId: plan.id });
      if (!isVoid(plan.id)) setPlan(next);
    } catch (e) {
      if (!isVoid(plan.id)) fail(e, 'simulation failed');
    } finally {
      setBusy(null);
    }
  };

  /** Keeps the plan's tracking record; true only when it reads back from storage. */
  /** Why a record was not kept: the list is full of other transfers, or the browser refused the write. */
  const notStored = (p: TransferPlan) => t(p.tracking && trackListFull(p.tracking.userOpHash) ? 'storage.full' : 'storage.unavailable');
  /** The same two reasons for a transfer the runner says may already have left: nothing here says "not sent". */
  const notStoredUnknown = (p: TransferPlan) => t(p.tracking && trackListFull(p.tracking.userOpHash) ? 'storage.unknownFull' : 'storage.unknownUnavailable');
  /** Writes the plan's tracking record; returns what was written when it reads back, else null. */
  const storeOwn = (p: TransferPlan): StoredTrack | null => {
    if (!p.tracking) return null;
    const t: StoredTrack = { record: p.tracking, symbol: p.asset.symbol, decimals: p.asset.decimals, savedAt: Date.now(), abandoned: false, scanCursor: null };
    const list = putTrack(t);
    onTracked(list);
    return isStored(t, list) ? t : null;
  };
  const store = (p: TransferPlan): boolean => storeOwn(p) !== null;
  /** True when a record for this UserOperation is already kept (an earlier attempt, say one whose outcome is unknown). */
  const heldBefore = (p: TransferPlan): boolean => {
    const h = p.tracking?.userOpHash.toLowerCase();
    return h !== undefined && loadTracks().some((x) => x.record.userOpHash === h);
  };
  // Nothing was sent for this plan and no earlier attempt holds a record for it: not "this transfer" any more.
  const noneSent = (p: TransferPlan) => {
    if (!heldBefore(p)) onSendNone?.(p.userOpHash);
  };
  // The record a hand-off wrote, and whether an earlier attempt already held one: cancelling an unclaimed
  // hand-off takes back only a record that hand-off created.
  const handoffOwn = useRef<{ planId: string; own: StoredTrack; earlier: boolean } | null>(null);

  const send = async () => {
    if (!plan || heldRef.current || cancelPending === plan.id || !walletReady || (gas.via === 'browser-wallet' && !provider)) return;
    onSendStart?.(plan.userOpHash);
    setBusy('send');
    setSendNote(null);
    sendFlight.current = { id: plan.id, walletAsked: false };
    try {
      await sendOnce(plan, gas.via === 'browser-wallet' ? provider : null);
    } finally {
      sendFlight.current?.endSending?.();
      sendFlight.current = null;
      setBusy(null);
    }
  };

  const stillWantedFor = (id: string) => () => {
    if (isVoid(id)) return false;
    const flight = sendFlight.current?.id === id ? sendFlight.current : null;
    if (heldRef.current) {
      // Held since the send began: given up before the wallet or signer is asked; the plan stays.
      if (flight) flight.heldOff = true;
      return false;
    }
    if (flight) flight.walletAsked = true;
    return true;
  };

  // "Nothing was sent" for an issued send: the browser wallet's answer, or the File / native-signer abort
  // (the sidecar accepts each only for its own payer, so the wrong one would leave the plan stuck in sending).
  const nothingSent = (planId: string) =>
    gas.via === 'browser-wallet'
      ? api<TransferPlan>('/api/transfer/wallet-result', { planId, outcome: 'rejected' })
      : api<TransferPlan>('/api/transfer/signer-aborted', { planId });
  // A send given up under a hold whose "nothing was sent" the runner has not heard yet (it was not answering):
  // reported before this plan is asked anything else — a second send request would be refused, and a discard
  // would read as "maybe sent" — and again when the hold lifts. One report at a time: whoever asks while it is
  // out waits for that same answer (a second would be refused as already signed, and the first's late answer
  // must not land after a Discard that followed it). The answer is the plan as it is now — applied only while
  // this plan is still the one on screen.
  const settling = useRef<{ id: string; done: Promise<void> } | null>(null);
  const settleHeld = (planId: string): Promise<void> => {
    if (settling.current?.id === planId) return settling.current.done;
    if (unreported.current !== planId) return Promise.resolve();
    const done = nothingSent(planId)
      .then((p) => {
        unreported.current = null;
        if (!isVoid(planId) && planNow.current?.id === planId) setPlan(p);
      })
      .finally(() => {
        if (settling.current?.done === done) settling.current = null;
      });
    settling.current = { id: planId, done };
    return done;
  };

  const sendOnce = async (plan: TransferPlan, provider: Eip1193 | null) => {
    let req: SendRequest;
    try {
      await settleHeld(plan.id);
      req = await api<SendRequest>('/api/transfer/send-request', { planId: plan.id, intentHash: plan.intentHash, shownMaxFeePerGas: String(plan.fees.maxFeePerGas), shownNetworkMaxWei: String(plan.feeSummary.networkMaxWei), via: gas.via });
    } catch (e) {
      noneSent(plan);
      if (!isVoid(plan.id)) fail(e, 'send request failed');
      return;
    }
    if (isVoid(plan.id)) {
      // Voided while the request was out: the wallet is never asked. Tell the sidecar nothing was sent,
      // then let the discard the check asked for take effect.
      noneSent(plan);
      if (req.tx) await nothingSent(plan.id).catch(() => undefined);
      await api('/api/transfer/discard', { planId: plan.id }).catch(() => undefined);
      return;
    }
    if (!req.tx) {
      // The network fee cap rose since it was shown: nothing was issued. Show the new figure; the user sends again.
      noneSent(plan);
      setPlan(req.plan);
      setSendNote('fee-raised');
      setBusy(null);
      return;
    }
    const tx = req.tx;
    // An earlier attempt for this UserOperation (say one whose outcome is unknown) keeps its record whatever
    // happens now; only a record this attempt created is taken back when nothing was sent.
    const earlier = heldBefore(req.plan);
    const own = storeOwn(req.plan);
    // Nothing was sent after all: the record this attempt made is taken back and the typing is the user's again.
    const forget = () => {
      setHandedFor(null);
      if (own && !earlier) onTracked(removeTrackIf(own));
      if (!earlier) onSendNone?.(plan.userOpHash);
    };
    if (!own) {
      // Without a record a refresh during the wallet request could not find this send again: do not ask
      // the wallet. Tell the sidecar nothing was sent, so the signed plan can be sent once storage works.
      onError(notStored(req.plan));
      noneSent(plan);
      await nothingSent(plan.id).then(setPlan, (e) => fail(e, 'could not record the wallet result'));
      setBusy(null);
      return;
    }
    // Until the wallet or signer answers, Track reads this record's "unknown, no hash" as the send under way.
    if (sendFlight.current?.id === plan.id) sendFlight.current.endSending = beginSending(own.record.userOpHash);
    if (gas.via !== 'browser-wallet') {
      setHandedFor(plan.id);
      // File key in this page or the runner's native signer: the runner checks the signed bytes against what
      // it issued and relays them (server/relay.ts). The plan it answers with is the new truth.
      const r = await relayTransfer<TransferPlan>(gas, plan.id, tx, stillWantedFor(plan.id));
      if (r.outcome.outcome === 'rejected') forget();
      if (sendFlight.current?.id === plan.id && sendFlight.current.heldOff) {
        // Given up under the hold before the signer was asked: the relay told the runner so when it answered
        // (the plan it answers with is signed again); a runner that did not answer hears it when the hold lifts.
        // Voided meanwhile (an earlier transfer verified changed): the answer is not a plan to show again.
        if (isVoid(plan.id)) {
          if (!r.plan) await nothingSent(plan.id).catch(() => undefined);
          await api('/api/transfer/discard', { planId: plan.id }).catch(() => undefined);
          setBusy(null);
          return;
        }
        if (r.plan) setPlan(r.plan);
        else unreported.current = plan.id;
        setBusy(null);
        return;
      }
      if (r.plan) setPlan(r.plan);
      if (r.outcome.outcome === 'rejected') {
        // Not the user's cancel: the File key or the runner refused before anything left.
        setSendNote('refused');
        if (r.reason) onError(refusalText(t, r));
      } else if (r.plan) store(r.plan);
      else {
        // No answer about whether it left: it may be on chain. Never offer Send again; Track keeps the record.
        setPlan({ ...req.plan, state: 'unknown' });
        onError(t('move.relayUnknown'));
      }
      setBusy(null);
      return;
    }
    if (!provider) return;
    setHandedFor(plan.id);
    let outcome;
    // Checked by the adapter at the last moment before it hands the transaction over (after its account and chain
    // checks): a plan voided or a step left by then is never presented to the wallet. From the moment it
    // answers true the wallet may send it: nothing voids this plan any more, its record is tracked.
    const stillWanted = stillWantedFor(plan.id);
    try {
      outcome = await sendExact(provider, tx, dep.chainId, stillWanted);
    } catch (e) {
      if (e instanceof WalletError && e.code === 'cancelled') {
        if (isVoid(plan.id)) {
          // Given up before the wallet was asked: nothing sent. Tell the sidecar so, then discard.
          await api('/api/transfer/wallet-result', { planId: plan.id, outcome: 'rejected' }).catch(() => undefined);
          await api('/api/transfer/discard', { planId: plan.id }).catch(() => undefined);
          forget();
          return;
        }
        // Given up under the hold (an earlier record unreadable): nothing sent, and the plan stays for when the
        // records read again. The runner hears "nothing was sent" now, or when the hold lifts if it is not answering.
        forget();
        unreported.current = plan.id;
        await settleHeld(plan.id).catch(() => undefined);
        return;
      }
      // Account or chain changed before asking: nothing was asked, nothing sent.
      fail(e, 'the wallet is not ready');
      outcome = { outcome: 'rejected' as const };
    }
    // The wallet refused (4001) or was never asked: nothing was sent, whatever the sidecar answers next — an
    // RPC switch meanwhile turns its plan unknown and refuses the report, which must not keep the record.
    if (outcome.outcome === 'rejected') forget();
    // The hash the wallet returned is the tracker's direct lead, kept now whatever the runner answers to the
    // report below. Only this UserOperation's record, and only while it has no hash yet (Track may have found
    // one meanwhile); a lead, never proof — Track still verifies it on chain.
    if (outcome.outcome === 'hash') {
      const txHash = outcome.txHash;
      const cur = loadTracks().find((x) => x.record.userOpHash === own.record.userOpHash);
      if (cur && cur.record.txHash === null) {
        const withHash: StoredTrack = { ...cur, record: { ...cur.record, txHash } };
        const list = putTrack(withHash);
        onTracked(list);
        if (!isStored(withHash, list)) {
          // Refused by the browser: Track still gets the hash for this visit, and the page says it was not saved.
          onHashNotSaved?.(cur.record.userOpHash, txHash);
          setHashNotSaved({ planId: plan.id, userOpHash: cur.record.userOpHash, txHash });
        }
      }
    }
    try {
      const after = await api<TransferPlan>('/api/transfer/wallet-result', { planId: plan.id, outcome: outcome.outcome, ...(outcome.outcome === 'hash' ? { txHash: outcome.txHash } : {}) });
      setPlan(after);
      if (outcome.outcome === 'rejected') setSendNote('rejected');
      else store(after);
    } catch (e) {
      fail(e, 'could not record the wallet result');
      // The wallet may have broadcast it and only the report was lost: show the outcome as unknown (Track keeps
      // the record) instead of a signed transfer that could be sent again.
      // What the wallet said is kept in the local plan too (the report shows it): its hash, or that it had none.
      if (outcome.outcome !== 'rejected') {
        const known = outcome.outcome === 'hash' ? { outcome: 'hash' as const, txHash: outcome.txHash } : { outcome: 'no-hash' as const, txHash: null };
        setPlan({ ...req.plan, state: 'unknown', send: req.plan.send && { ...req.plan.send, ...known } });
      }
    } finally {
      setBusy(null);
    }
  };

  const createHandoff = async () => {
    if (!plan || cancelPending === plan.id) return;
    onSendStart?.(plan.userOpHash);
    setBusy('handoff');
    try {
      await settleHeld(plan.id);
      const r = await api<{ plan: TransferPlan; code: string }>('/api/transfer/handoff', { planId: plan.id, intentHash: plan.intentHash });
      if (isVoid(plan.id)) {
        // Voided while the request was out: the code is never shown and never claimable (an unclaimed
        // hand-off discards to nothing sent).
        noneSent(plan);
        await api('/api/transfer/discard', { planId: plan.id }).catch(() => undefined);
        return;
      }
      if (heldRef.current) {
        // Held since the request went out (an earlier record became unreadable): the code is never shown, so
        // nothing can claim it. The runner cannot take a hand-off back to signed, so the plan is discarded there
        // (unclaimed → nothing sent) and said so here; the user signs again once the records read. Only the
        // runner's answer ends the plan: until it confirms (or no longer knows the plan), the plan stays, Send and
        // a new hand-off wait, and Discard or Clear asks again.
        noneSent(plan);
        try {
          const after = await api<TransferPlan>('/api/transfer/discard', { planId: plan.id });
          if (isVoid(plan.id)) return;
          setPlan(after);
          onError(t('move.handoffHeld'));
        } catch (e) {
          if (isVoid(plan.id)) return;
          if (isGone(e)) {
            setPlan(null);
            onError(t('move.handoffHeld'));
            return;
          }
          setCancelPending(plan.id);
          onError(t('move.handoffCancelFailed', { reason: reasonOf(e) }));
        }
        return;
      }
      const earlier = heldBefore(r.plan);
      const own = storeOwn(r.plan);
      handoffOwn.current = own ? { planId: plan.id, own, earlier } : null;
      if (!own) {
        // The code is never shown without a kept record: void it on the sidecar (unclaimed → nothing sent).
        onError(notStored(r.plan));
        noneSent(plan);
        setPlan(await api<TransferPlan>('/api/transfer/discard', { planId: plan.id }).catch(() => null));
        return;
      }
      setHandoff({ code: r.code, expiresAt: r.plan.handoff!.expiresAt });
      setPlan(r.plan);
      setSendNote('handed-off');
    } catch (e) {
      noneSent(plan);
      if (!isVoid(plan.id)) fail(e, 'hand-off failed');
    } finally {
      setBusy(null);
    }
  };

  // The runner says a send was already requested (a claimed hand-off; a send whose answer this page lost
  // before it could keep a record): the op may be on chain, so it is this transfer in Track. A record an
  // earlier attempt or the hand-off wrote stays as it is; without one, the record the runner answers with is
  // kept now, and the refusal said when the browser will not store it (Move still shows the transfer as unknown;
  // the refusal's words say the transfer may still complete — never the pre-send "nothing was sent").
  // Both Discard and Clear land here on that answer: neither opens a new form over a transfer that may have left.
  const keepUnknown = (after: TransferPlan) => {
    onSendStart?.(after.userOpHash);
    if (!heldBefore(after) && !store(after)) onError(notStoredUnknown(after));
    setPlan(after);
    setHandoff(null);
  };

  // The runner's answer decides what Discard leaves: discarded (or a plan it no longer knows: 404) → gone here;
  // unknown (a claimed hand-off, a send already requested) → shown as sent and tracked; any other failure →
  // said, and the plan stays so Discard can be pressed again. While asked, nothing else acts on the plan.
  const discard = async () => {
    const p = plan;
    if (!p || busy !== null) return;
    const handedOff = p.send?.via === 'terminal-signer';
    setBusy('discard');
    let after: TransferPlan | null = null;
    let failed: unknown = null;
    // A give-up the runner has not heard of yet: a discard of a plan it still holds as sending would read "maybe sent".
    await settleHeld(p.id).catch(() => undefined);
    try {
      after = await api<TransferPlan>('/api/transfer/discard', { planId: p.id });
    } catch (e) {
      failed = e;
    }
    // Voided meanwhile (released where it was voided) or this form is gone: the answer belongs to nothing on screen.
    if (isVoid(p.id)) return;
    setBusy(null);
    if (failed !== null && !isGone(failed)) {
      onError(t('move.discardNotDone', { reason: reasonOf(failed) }));
      return;
    }
    // 404: whether a hand-off was claimed is not known here, so its tracking record is kept.
    if (after?.state === 'unknown') {
      keepUnknown(after);
      return;
    }
    if (handedOff && after?.state === 'discarded') {
      // Unclaimed: only the record this hand-off wrote goes; an earlier attempt's record for the same
      // UserOperation (one that may still run) stays, and so does any record this page cannot vouch for.
      const mine = handoffOwn.current;
      if (mine && mine.planId === p.id && !mine.earlier) onTracked(removeTrackIf(mine.own));
      // Unclaimed: nothing was sent; without an earlier record it is not "this transfer" in Track any more.
      noneSent(p);
    }
    handoffOwn.current = null;
    setPlan(null);
    setHandoff(null);
    setSendNote(null);
  };

  // "Clear and start over" before anything left (PM-07): the unsent plan is discarded on the runner, then the
  // parent gives a fresh form. A signed plan is only forgotten here — its signature is not revoked on chain.
  // A runner that no longer knows the plan (404: expired, restarted) holds nothing to discard; any other
  // failure is said and the form stays, so Clear can be pressed again. A runner answering unknown (a send
  // was already requested; this page lost the answer) is read like Discard's: the transfer stays, tracked,
  // and no new form opens over it.
  // While the runner is asked to discard, the plan is busy: no second Clear, no Send, Discard or Review on it,
  // and a late answer to an earlier press never lands on the form a later one opened.
  const clearUnsent = async () => {
    const p = plan;
    if (busy !== null) return;
    if (p && (p.state === 'previewed' || p.state === 'signed' || p.state === 'sim-failed')) {
      setBusy('clear');
      let after: TransferPlan | null = null;
      let failed: unknown = null;
      await settleHeld(p.id).catch(() => undefined);
      try {
        after = await api<TransferPlan>('/api/transfer/discard', { planId: p.id });
      } catch (e) {
        failed = e;
      }
      // This form is gone (gas payer change, RPC switch, leaving the step) or the plan was voided meanwhile:
      // the answer, whatever it is, belongs to nothing on screen any more (a voided plan's Clear was already
      // released where it was voided).
      if (isVoid(p.id)) return;
      if (failed !== null && !isGone(failed)) {
        setBusy(null);
        onError(t('move.clearNotDiscarded', { reason: reasonOf(failed) }));
        return;
      }
      if (after?.state === 'unknown') {
        setBusy(null);
        keepUnknown(after);
        return;
      }
    }
    onNewTransfer?.();
  };

  const typed = amount !== '' || to !== '' || again !== '' || assetId !== '';

  const unsent = !!plan && (plan.state === 'previewed' || plan.state === 'signed' || plan.state === 'sim-failed');
  const gateNow = plan ? sigFor(plan.userOpHash) : '';
  const agreesNow = plan ? agreesFor(plan) : true;
  // An earlier record whose Track answer was dropped because the runner or the chain stopped answering reads
  // `unknown` until it is read again. That is not a change in what is known about it: the plan is held — not
  // sent, not handed off, not voided — and goes on as before once the gates read as they did when it was built
  // (a Discard waiting on the runner keeps waiting; the runner's answer still decides). A gate that moved to
  // another verified state, or a record gone or added, voids the plan below as before.
  const gateHeld =
    unsent && !!plan && planGate.current !== null && !(gateNow === planGate.current && agreesNow) && gatesOnlyUnreadable(JSON.parse(planGate.current) as [string, IntentGate][], earlier(plan.userOpHash));
  heldRef.current = gateHeld;
  // The hold lifted (the records read again, so the runner answers): a give-up it has not heard of is reported now.
  useEffect(() => {
    const id = unreported.current;
    if (gateHeld || !id) return;
    void settleHeld(id).catch(() => undefined);
  }, [gateHeld]);
  useEffect(() => {
    if (!unsent || !plan || planGate.current === null || (gateNow === planGate.current && agreesNow) || gateHeld) return;
    const id = plan.id;
    const flight = sendFlight.current?.id === id ? sendFlight.current : null;
    // The wallet has been asked: the plan is not voided from here; Track follows what it does.
    if (flight?.walletAsked) return;
    planGate.current = null;
    voided.current.add(id);
    // A Clear or Discard waiting on this plan's discard has nothing left to wait for: the form is usable again.
    setBusy((b) => (b === 'clear' || b === 'discard' ? null : b));
    setPlan(null);
    setSendNote(null);
    setAssertion('');
    onError(t('move.earlierChanged'));
    // A send request still out tells the sidecar "not sent" and discards when it returns (a discard
    // landing first would read as "maybe sent"); otherwise discard now — after a held give-up the runner has not
    // heard of, for the same reason.
    const notSent = settleHeld(id).catch(() => undefined);
    unreported.current = null;
    if (!flight) void notSent.then(() => api('/api/transfer/discard', { planId: id })).catch(() => undefined);
  }, [unsent, gateNow, agreesNow, gateHeld]);

  const drafting = !plan || plan.state === 'discarded';
  const sent = plan && (plan.state === 'sent' || plan.state === 'unknown' || (plan.state === 'sending' && plan.send?.via === 'terminal-signer'));
  const amountText = plan ? exact(plan.intent.amount, plan.asset.decimals) : '';
  // PM-07: "Next transfer" only once this transfer is in a block and did what it was asked; any other state
  // offers "Clear and start over", which never resends and leaves Track following the transfer.
  const succeeded = !!result && (result.state === 'confirmed' || result.state === 'final');
  const failedOnChain = !!result && (result.state === 'inner-failed' || result.state === 'reverted');

  // The balance line and its read-again button (PM-06): in the form, and beside "Review again" once a plan expired.
  const balanceLine = (
    <>
    <div className="lb-balance" data-testid="move-balance" data-state={balanceRead.state} data-block={diag.block}>
      <p className={`lb-help${balanceRead.state === 'failed' ? ' lb-tone-bad' : ''}`} id={`${ids.amount}-help`} role="status">
        {balanceRead.state === 'reading'
          ? t('move.balanceReading', { block: diag.block })
          : balanceRead.state === 'failed'
            ? t('move.balanceStale', { reason: balanceRead.error ?? '', block: diag.block })
            : balance !== null && asset
              ? t('move.balanceAt', { amount: exact(balance, asset.decimals), symbol: asset.symbol, block: diag.block })
              : t('move.balanceAtNone', { block: diag.block })}
      </p>
      {onRefreshBalance && (
        <button type="button" className="lb-btn lb-btn-link" onClick={onRefreshBalance} data-testid="move-balance-refresh">
          {t(balanceRead.state === 'failed' ? 'move.balanceRetry' : 'move.balanceRefresh')}
        </button>
      )}
    </div>
    {unread && asset && (
      <Notice tone="bad" testId="move-unread">
        {t('move.unread', { symbol: asset.symbol, block: diag.block })}
      </Notice>
    )}
    {over && asset && balance !== null && (
      <Notice tone="bad" testId="move-over">
        {t('move.over', { amount: exact(balance, asset.decimals), symbol: asset.symbol })}
      </Notice>
    )}
    </>
  );

  return (
    <div className="lb-move" data-testid="move" data-plan-state={plan?.state ?? 'draft'}>
      <div className="lb-move-main">
        {drafting && (
          <form
            className="lb-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (formOk) void review();
            }}
          >
            <p className="lb-lead">{t('move.lead')}</p>
            {!browserPayer && (
              <>
                <Notice tone="warn" testId="move-need-wallet">
                  {t('move.needWallet')}
                </Notice>
                <Field id={ids.payer} label={t('move.terminalPayer')} help={t('move.terminalPayerHelp')}>
                  <input id={ids.payer} className="lb-input lb-mono" autoComplete="off" spellCheck={false} placeholder="0x…" value={termPayer} onChange={(e) => setTermPayer(e.target.value)} aria-describedby={`${ids.payer}-help`} data-testid="move-terminal-payer" />
                </Field>
              </>
            )}
            {!gatesOpen && <Notice tone="warn" testId="move-wait-earlier">{t('move.waitEarlier')}</Notice>}
            <div className="lb-row2">
              <Field id={ids.owner} label={t('move.passkey')}>
                <select id={ids.owner} className="lb-input" value={ownerIndex} onChange={(e) => setOwnerIndex(Number(e.target.value))} data-testid="move-owner">
                  {diag.passkeyOwners.map((o) => (
                    <option key={o.index} value={o.index}>
                      {t('check.ownerIndex', { index: o.index })}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={ids.asset} label={t('move.asset')}>
                <select id={ids.asset} className="lb-input" value={assetId} onChange={(e) => setAssetId(e.target.value)} data-testid="move-asset">
                  <option value="" disabled>
                    {t('move.assetChoose')}
                  </option>
                  {dep.assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.symbol}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field id={ids.amount} label={t('move.amount')}>
              <input id={ids.amount} className="lb-input lb-mono" inputMode="decimal" autoComplete="off" spellCheck={false} value={amount} onChange={(e) => setAmount(e.target.value)} aria-describedby={`${ids.amount}-help`} aria-invalid={over || undefined} data-testid="move-amount" />
            </Field>
            {balanceLine}
            <Field id={ids.to} label={t('move.to')}>
              <input id={ids.to} className="lb-input lb-mono" autoComplete="off" spellCheck={false} placeholder="0x…" value={to} onPaste={onPasteAddress} onChange={(e) => editAddress('to', e.target.value)} data-testid="move-to" />
            </Field>
            <Field id={ids.again} label={t('move.toAgain')} help={t('move.toAgainHelp')}>
              <input
                id={ids.again}
                className="lb-input lb-mono"
                autoComplete="off"
                spellCheck={false}
                placeholder="0x…"
                value={again}
                onPaste={onPasteAddress}
                onChange={(e) => editAddress('again', e.target.value)}
                aria-describedby={`${ids.again}-help`}
                data-testid="move-to-again"
              />
            </Field>
            {again.trim() !== '' && <Notice tone={same ? 'ok' : 'bad'} testId="move-match">{same ? t('move.match') : t('move.mismatch')}</Notice>}
            {pasted && same && (
              <div className="lb-paper lb-paper-warn" data-testid="move-pasted">
                <p>{t('move.pasted')}</p>
                {ADDR.test(to.trim()) && <AddressDisplay value={to.trim()} />}
                <p className="lb-check">
                  <input id={ids.cross} type="checkbox" checked={crossChecked} onChange={(e) => setCrossChecked(e.target.checked)} data-testid="move-cross-check" />
                  <label htmlFor={ids.cross}>{t('move.crossCheck')}</label>
                </p>
              </div>
            )}
            {busy === 'review' && <BusyLine testId="move-busy" slow="sim">{t('move.reviewing')}</BusyLine>}
            <div className="lb-actionbar">
              <button type="submit" className="lb-btn lb-btn-primary" disabled={!formOk || busy !== null} data-testid="move-review">
                {busy === 'review' ? t('move.reviewing') : t('cta.review')}
              </button>
              {typed && onNewTransfer && (
                <button type="button" className="lb-btn lb-btn-quiet" onClick={() => void clearUnsent()} disabled={busy !== null} data-testid="move-clear">
                  {t('move.clear')}
                </button>
              )}
            </div>
          </form>
        )}

        {plan && !drafting && !sent && (
          <section className="lb-form" data-testid="review">
            {expired ? (
              <>
                <Notice tone="warn" testId="review-expired">{t('review.expired')}</Notice>
                {balanceLine}
              </>
            ) : (
              <p className="lb-window" data-testid="review-window">
                <span className="lb-mono">{t('review.window', { time: mmss(plan.validUntil - now) })}</span>
                <span className="lb-help">{t('review.windowHelp')}</span>
              </p>
            )}
            {plan.recipientInfo.hasCode && <Notice tone="warn">{t('review.recipientContract', { symbol: plan.asset.symbol })}</Notice>}
            {!plan.signable && <Notice tone="bad" testId="review-not-signable">{t('review.notSignable', { reason: plan.notSignableReason ?? '' })}</Notice>}

            {(plan.state === 'previewed' || plan.state === 'sim-failed') && plan.signable && !expired && (
              <div className="lb-sign" data-testid="sign" data-userop-hash={plan.userOpHash}>
                <h3>{t('sign.title')}</h3>
                <p className="lb-kind" data-testid="sign-kind">{t('sign.kind')}</p>
                <p className="lb-help">{t('sign.signs', { hash: shortAddress(plan.userOpHash) })}</p>
                {challenge && <BookmarkletSigner kind="userop" challenge={challenge} entryUrl={dep.rp.entryUrl} testId="sign-bookmarklet" />}
                {challenge && (
                  <ExtensionBridge
                    kind="userop"
                    challenge={challenge}
                    onAssertion={(a) => {
                      setAssertion(a);
                      void submitSignature(a);
                    }}
                  />
                )}
                <details className="lb-details" data-testid="sign-advanced">
                  <summary>{t('sign.advanced')}</summary>
                  <p className="lb-flare" role="note">
                    <b>{t('warn.paste')}</b> {t('warn.pasteMore')}
                  </p>
                  <p>{t('sign.helperSteps', { url: dep.rp.entryUrl })}</p>
                  {helper && (
                    <>
                      <p className="lb-help lb-mono">{t('sign.helperHash', { hash: helper.sha256Hex })}</p>
                      <pre className="lb-code-block" tabIndex={0} data-testid="sign-helper">{helper.source}</pre>
                      <CopyButton text={helper.source} label={t('sign.copyHelper')} done={t('sign.copied')} testId="sign-copy-helper" />
                    </>
                  )}
                </details>
                <Field id={ids.assertion} label={t('sign.paste')} help={t('sign.pasteHelp')}>
                  <textarea
                    ref={assertionBox}
                    id={ids.assertion}
                    className="lb-input lb-mono"
                    rows={4}
                    spellCheck={false}
                    autoComplete="off"
                    value={assertion}
                    onChange={(e) => setAssertion(e.target.value)}
                    onPaste={(e) => {
                      // A paste replaces the whole proof and is checked right away; typing still waits for the button.
                      const text = e.clipboardData.getData('text');
                      if (!text.trim()) return;
                      e.preventDefault();
                      setAssertion(text);
                      void submitSignature(text);
                    }}
                    aria-describedby={`${ids.assertion}-help`}
                    data-testid="sign-assertion"
                  />
                </Field>
                {sigError && (
                  <Notice tone="bad" testId="sign-error">
                    {t('sign.invalid', { reason: sigError })} {t('sign.retry')}
                  </Notice>
                )}
                {plan.state === 'sim-failed' && plan.signedSim && (
                  <div data-testid="sign-sim-failed">
                    <Notice tone="bad">{t('sign.simFailed', { reason: plan.signedSim.problems.join('; ') })}</Notice>
                    <button type="button" className="lb-btn" onClick={() => void resimulate()} disabled={busy !== null} data-testid="sign-resim">
                      {t('sign.resim')}
                    </button>
                  </div>
                )}
                {busy === 'sign' && <BusyLine testId="sign-busy" slow="sim">{t('sign.checking')}</BusyLine>}
              </div>
            )}

            {plan.state === 'signed' && plan.signedSim?.success && (
              <div data-testid="signed">
                <p className="lb-sealed" role="status">
                  <span className="lb-seal" aria-hidden="true">✓</span> {t('sign.ok', { block: plan.signedSim.forkBlock })}
                </p>
                <p className="lb-kind" data-testid="send-kind">{t('send.kind')}</p>
                {sendNote === 'rejected' && <Notice tone="warn" testId="send-rejected">{t('send.rejected')}</Notice>}
                {sendNote === 'refused' && <Notice tone="warn" testId="send-refused">{t('send.refused')}</Notice>}
                {sendNote === 'fee-raised' && <Notice tone="warn" testId="send-fee-raised">{t('send.feeRaised')}</Notice>}
                <details className="lb-details" data-testid="send-terminal">
                  <summary>{t('send.terminal')}</summary>
                  <p className="lb-help">{t('send.terminalHelp')}</p>
                  <button type="button" className="lb-btn" disabled={busy !== null || expired || gateHeld || cancelPending === plan.id} onClick={() => void createHandoff()} data-testid="send-handoff">
                    {t('send.terminalCreate')}
                  </button>
                </details>
              </div>
            )}
            {busy === 'send' && <BusyLine testId="send-sending" slow="send">{t('send.sending')}</BusyLine>}
            {gateHeld && (
              <p className="lb-help" role="status" data-testid="move-gate-held">
                {t('move.gateHeld')}
              </p>
            )}
            {cancelPending === plan.id && (
              <p className="lb-help" role="status" data-testid="move-handoff-cancel">
                {t('move.handoffCancelPending')}
              </p>
            )}
            {plan.state === 'signed' && (
              <p className="lb-help" data-testid="move-clear-signed">
                {t('move.clearSigned')}
              </p>
            )}

            <div className="lb-actionbar">
              <button type="button" className="lb-btn lb-btn-quiet" onClick={() => void discard()} disabled={busy !== null} data-testid="review-discard">
                {t('review.discard')}
              </button>
              {onNewTransfer && (
                <button type="button" className="lb-btn lb-btn-quiet" onClick={() => void clearUnsent()} disabled={busy !== null} data-testid="move-clear">
                  {t('move.clear')}
                </button>
              )}
              {expired ? (
                <button type="button" className="lb-btn lb-btn-primary" onClick={() => void review()} disabled={busy !== null || !gatesOpen || !balanceOk} data-testid="review-again">
                  {t('cta.review')}
                </button>
              ) : plan.state === 'signed' && plan.signedSim?.success ? (
                <IrreversibleButton
                  label={t('cta.send', { amount: amountText, asset: plan.asset.symbol })}
                  title={t('send.title', { amount: amountText, asset: plan.asset.symbol })}
                  confirmWord={amountText}
                  confirmLabel={t(gas.via === 'browser-wallet' ? 'send.confirm' : 'send.confirmDirect')}
                  disabled={busy !== null || gateHeld || cancelPending === plan.id || !walletReady || !gasWallet || getAddress(gasWallet) !== getAddress(plan.gasWallet)}
                  onConfirm={() => void send()}
                  testId="send"
                >
                  {/* A browser wallet asks once more; a File key or the runner's signer sends on this confirmation. */}
                  <p>{t(gas.via === 'browser-wallet' ? 'send.body' : 'send.bodyDirect')}</p>
                  <Manifest dep={dep} plan={plan} draft={{ source: '', recipient: '', assetId: '', amount: '' }} />
                </IrreversibleButton>
              ) : (
                <button type="button" className="lb-btn lb-btn-primary" onClick={() => void submitSignature()} disabled={busy !== null || !assertion.trim() || !plan.signable} data-testid="sign-submit">
                  {busy === 'sign' ? t('sign.checking') : t('cta.sign')}
                </button>
              )}
            </div>
          </section>
        )}

        {plan && sent && (
          <section className="lb-form" data-testid="move-sent">
            {sendNote === 'handed-off' && handoff && plan.state === 'sending' ? (
              <div className="lb-paper" data-testid="handoff">
                <p>
                  {t('send.terminalCode', { code: '' })}
                  <b className="lb-code" data-testid="handoff-code">
                    {handoff.code}
                  </b>
                </p>
                <p className="lb-help">{t('send.terminalExpires', { time: mmss(handoff.expiresAt - now) })}</p>
                <p>{t('send.handedOff')}</p>
              </div>
            ) : (
              <>
              {hashNotSaved?.planId === plan.id && hashStillUnsaved && (
                <Notice tone="bad" testId="move-hash-not-saved">
                  {t('move.hashNotSaved', { hash: hashNotSaved.txHash })}
                </Notice>
              )}
              <Notice tone={plan.state === 'unknown' ? 'warn' : 'idle'} testId="move-sent-note">
                {plan.state === 'unknown' ? t(plan.send?.outcome === 'hash' && plan.send.txHash ? 'unknown.walletHash' : 'unknown.body') : t('pending.body')}
              </Notice>
              </>
            )}
            {plan.state !== 'sent' && (
              <p className="lb-help" data-testid="move-gate" data-gate={gates.byOp[plan.userOpHash] ?? 'unknown'}>
                {t(GATE_NOTE[gates.byOp[plan.userOpHash] ?? 'unknown'])}
              </p>
            )}
            <div className="lb-actionbar">
              {plan.state === 'sending' && plan.send?.via === 'terminal-signer' && (
                <button type="button" className="lb-btn lb-btn-quiet" onClick={() => void discard()} disabled={busy !== null} data-testid="handoff-discard">
                  {t('review.discard')}
                </button>
              )}
              <button type="button" className="lb-btn lb-btn-primary" onClick={() => onNewTransfer?.()} data-testid="move-new" data-kind={succeeded ? 'next' : 'clear'}>
                {t(succeeded ? 'move.next' : 'move.clear')}
              </button>
            </div>
            {!succeeded && (
              <p className="lb-help" data-testid="move-clear-note" data-why={failedOnChain ? 'failed' : 'pending'}>
                {t(failedOnChain ? 'move.clearFailed' : 'move.clearSending')}
              </p>
            )}
          </section>
        )}
      </div>
      <Manifest dep={dep} plan={plan && plan.state !== 'discarded' ? plan : null} draft={{ source: diag.account, recipient: to.trim(), assetId, amount: amount.trim() }} />
    </div>
  );
}
