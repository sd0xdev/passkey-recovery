// The page's one gas payer (GAS-01..05). Four modes, one shape (./payer.ts GasPayer):
//  - wallet: an EIP-6963 provider the user picked (OKX first); with no announcement, the injected one;
//  - browser-file: an encrypted keystore opened or created in this page, key in memory only;
//  - native-op / native-keystore / native-file: the local runner's native signer (1Password item; the existing
//    gas wallet's keystore with its password in 1Password; or an app-data keystore).
// Any change of mode, provider, account, item, field or key bumps `epoch`: the steps remount and the runner
// voids every plan built for the previous payer (GAS-04). Records of sent / unknown transfers stay tracked.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getAddress, type Address } from 'viem';
import type { SupportedDeployment } from '../../config/registry';
import { injectedProvider, type Eip1193 } from '../../wallet/eip1193';
import { discoverWallets, type Announced } from '../../wallet/eip6963';
import { fileWalletState, lockFileWallet, onFileWallet } from '../../wallet/fileWallet';
import { SIGNER_API } from '../../config/signerApi';
import { ApiError, hasNativeSigner, onConnectionChange, pairedRunner, signerApi, signerOrigin } from '../api';
import { useWallet, type WalletState } from '../useWallet';
import { announcePayerChange, viaOf, type GasPayer, type PayerMode } from './payer';

/** The three ways to say which keystore the existing gas wallet is: the manifest's, a path in an item field, a picked file. */
export type KeystoreFrom = 'manifest' | 'field' | 'file';

/** An existing keystore the user chose: the path a field of their item holds, or a file they picked (name only). */
export type KeystoreSourceStatus = { kind: 'keystore'; origin: 'field'; field: string; passwordField: string; path: string; sha256: string; manifest: boolean } | { kind: 'keystore'; origin: 'file'; name: string; passwordField: string; sha256: string; manifest: boolean };

export interface NativeStatus {
  /** The signer's contract version (src/config/signerApi.ts); absent from a signer older than version 2. */
  api?: number;
  unlocked: boolean;
  address: Address | null;
  /** Which unlock this is: a confirm or recheck names it, so one meant for an earlier key changes nothing. */
  keyId?: string | null;
  confirmed: boolean;
  source: { kind: 'op'; field: string } | { kind: 'file'; file: string } | { kind: 'manifest'; address: Address } | KeystoreSourceStatus | null;
  opAvailable: boolean;
  fileAvailable: boolean;
  manifestAvailable?: boolean;
}

/** A wallet the user can pick: announced (EIP-6963) or, with none announced, the page's injected one. */
export interface WalletOption {
  id: string;
  name: string;
  rdns: string | null;
  provider: Eip1193;
}

/**
 * Whether this page and the runner's signer speak the same contract: 'runner-older' (started before an update, or an
 * older install), 'runner-newer' (this page is the older one), or null until the signer answered.
 */
export type SignerCompat = 'ok' | 'runner-older' | 'runner-newer' | null;
export function signerCompat(n: Pick<NativeStatus, 'api'> | null): SignerCompat {
  if (!n) return null;
  const v = typeof n.api === 'number' && Number.isInteger(n.api) ? n.api : 1;
  return v === SIGNER_API ? 'ok' : v < SIGNER_API ? 'runner-older' : 'runner-newer';
}

export interface GasPayerState {
  payer: GasPayer;
  /** The native modes are offered only when this is 'ok': an incompatible signer gets update guidance, not an unlock. */
  compat: SignerCompat;
  mode: PayerMode;
  setMode(m: PayerMode): void;
  wallets: WalletOption[];
  walletId: string | null;
  pickWallet(id: string): void;
  wallet: WalletState;
  native: NativeStatus | null;
  refreshNative(): Promise<void>;
  nativeAvailable: boolean;
  /**
   * Starts an unlock from a picked file in this page: forgets the file kept so far and returns the attempt, which
   * any later attempt or mode change makes stale.
   */
  startPickedOpen(): number;
  /**
   * The keystore file the user picked in this page, bound to the unlock this page made from it (`keyId`) — only
   * while `attempt` is still the latest. Kept here, not in the sheet, so it is re-checked while the sheet is closed.
   */
  keepPickedKeystore(attempt: number, f: File | null, keyId?: string | null): void;
  /**
   * sha256 of the picked file read again now ('' when it cannot be read any more), or null when this page does not
   * hold the file of that unlock (another tab opened it): such a page reports nothing about it.
   */
  pickedKeystoreSha256(keyId: string | null | undefined): Promise<string | null>;
  /** Why the runner locked a picked keystore while the page was re-checking it (shown until a key unlocks again). */
  nativeLost: unknown;
  /** An unlock of an existing keystore is waiting (1Password approval, decrypting): kept here so a reopened sheet still shows it and keeps its form locked. */
  keystoreOpening: boolean;
  setKeystoreOpening(v: boolean): void;
  /** The unlock request itself is still with the signer (waiting on 1Password); false once it answered, while its status is read back. */
  keystoreAsking: boolean;
  setKeystoreAsking(v: boolean): void;
  /** The key (keyId) whose address confirmation is running (request and its status read-back), null for none: kept here, so a reopened sheet still shows it and cannot send a second one. Tied to that key: another key unlocked meanwhile (after a mode change locked this one) is not "confirming". */
  confirming: string | null;
  /** A status read-back after a native action's answer is running (count of them): kept here, so a sheet reopened in that moment still shows "working" and keeps its form locked until the outcome is shown. */
  readingBack: boolean;
  /** Marks one read-back as running; the returned function ends it (a read-back from an earlier signer connection ends nothing: that reset already did). */
  /** Marks a status read-back of a request made on signer connection `conn` in payer way `ep` (stale: no mark). */
  beginReadback(conn: number, ep: number): () => void;
  /** The key the signer's last status read showed (keyId, else its address), read at call time: a late answer checks it is still the same key. */
  currentKey(): string | null;
  /** True when the payer chosen now is this native way with an unlocked, confirmed key of its kind, read at call time from the last status: a late success only closes the sheet when the key it would close on is ready. */
  nativeReadyAs(mode: PayerMode): boolean;
  /** The payer way chosen now, read at call time (a late answer checks the user has not left its way). */
  modeNow(): PayerMode;
  /** Advances on every way change (away and back included): an action's answer finishes nothing once it moved. */
  modeEpoch(): number;
  /** Locks the key a request installed only after the payer way was changed — that key only, never a newer one. */
  lockLeftKey(keyId: string): Promise<void>;
  /** Resolves once the signer answered the lock a way change sent and every earlier request that can install a key: a request sent after it is never the one such a lock (or a late install) undoes. */
  signerSettled(): Promise<void>;
  /** Tracks a request that can install a key until it (and the relock a changed way sends after it) is answered. */
  trackInstall<T>(p: Promise<T>): Promise<T>;
  /** A request of the current way installed a key: the signer holds that key alone, so the key a way change left is gone. */
  keyInstalled(): void;
  /** The lock sent for the key a way change left failed: that key may still be unlocked in the runner's signer. */
  leaveFailed: boolean;
  /** A request is waiting, before it is sent, for the signer to answer an earlier lock or install (count > 0). */
  signerQueued: boolean;
  /** True when a request sent now would first have to wait for such an answer. */
  mustWait(): boolean;
  /** Marks one request as waiting so; the returned function ends it (one from an earlier signer connection or payer way ends nothing: that change cleared it). */
  beginQueued(): () => void;
  /** Sends that lock again, after every earlier install is answered (none if one of them installed a newer key). */
  relockLeft(): Promise<void>;
  setConfirming(v: string | null | ((cur: string | null) => string | null)): void;
  /** A 1Password item read or unlock of the "1Password app" way is with the signer: kept here, so a reopened sheet still shows the wait (and its Stop) and keeps the form locked. */
  opAsking: boolean;
  setOpAsking(v: boolean): void;
  /** Why the last request of that way failed (null: none): kept here, so a refusal or a stop that lands while the sheet is closed is still said when it opens again. */
  opErr: unknown;
  setOpErr(e: unknown): void;
  /** Which keystore the existing-wallet form was told to use (null: not chosen yet): a reopened sheet keeps it. */
  keystoreFrom: KeystoreFrom | null;
  setKeystoreFrom(f: KeystoreFrom): void;
  /** A read of that form still with the signer — the 1Password item ('item') or the manifest wallet ('find') — until it answers: a reopened sheet still shows it and keeps the form locked. */
  keystoreReading: 'item' | 'find' | null;
  setKeystoreReading(r: 'item' | 'find' | null): void;
  /** Why the last action on the existing-keystore form failed (null: none): kept here, so an unlock that fails after the sheet was closed and opened again still says why. */
  keystoreErr: unknown;
  setKeystoreErr(e: unknown): void;
  /** Which stage's request that failure belongs to (finding the keystore and reading the item: 'item'; opening it: 'open'), so the ledger marks that stage and no other. */
  keystoreFailedAt: 'item' | 'open' | null;
  setKeystoreFailedAt(s: 'item' | 'open' | null): void;
  /** The same for confirming (or locking) an unlocked native key: a 409 that lands while the sheet is closed is shown when it opens again. */
  confirmErr: unknown;
  setConfirmErr(e: unknown): void;
  /** Which signer connection is current: an action started on an earlier one (hosted: before a disconnect or re-pairing) leaves no result. */
  connection(): number;
}

/** How often the page re-reads a picked keystore file for the signer; a waiting sign is answered at once. */
export const PICKED_RECHECK_MS = 2_000;

/** sha256 over the file's text as the signer received it (UTF-8 of `File.text()`), hex. */
async function sha256OfText(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** How long EIP-6963 announcements may take before the injected provider is considered. */
const DISCOVERY_MS = 400;

/** The status with its key shown as locked: the key a way change left is never offered as ready again. */
const lockedCopy = (st: NativeStatus): NativeStatus => ({ ...st, unlocked: false, address: null, keyId: null, confirmed: false, source: null });

export function useGasPayer(dep: SupportedDeployment): GasPayerState {
  const [mode, setModeState] = useState<PayerMode>('wallet');
  const [announced, setAnnounced] = useState<Announced[]>([]);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [file, setFile] = useState(fileWalletState);
  const [native, setNative] = useState<NativeStatus | null>(null);
  const nativeRef = useRef(native);
  nativeRef.current = native;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Bound to the signer connection and the payer way of its request, like a queued mark: a way change ends the marks
  // (the form of the way left is gone), and a read-back of a request already stale marks nothing in the newer form.
  const beginReadback = useCallback((conn: number, ep: number) => {
    if (conn !== actionGen.current || ep !== modeGen.current) return () => undefined;
    setReadbacks((n) => n + 1);
    return () => {
      if (conn === actionGen.current && ep === modeGen.current) setReadbacks((n) => Math.max(0, n - 1));
    };
  }, []);
  // Bound to the signer connection and the payer way it was asked in: a way change cancels it (it is never sent),
  // so its mark ends then too.
  const beginQueued = useCallback(() => {
    const at = actionGen.current;
    const ep = modeGen.current;
    setQueued((n) => n + 1);
    return () => {
      if (at === actionGen.current && ep === modeGen.current) setQueued((n) => Math.max(0, n - 1));
    };
  }, []);
  const nativeReadyAs = useCallback((m: PayerMode) => {
    const n = nativeRef.current;
    const kinds = m === 'native-op' ? ['op'] : m === 'native-keystore' ? ['manifest', 'keystore'] : m === 'native-file' ? ['file'] : [];
    return modeRef.current === m && !!n && n.unlocked && n.confirmed && !!n.source && kinds.includes(n.source.kind);
  }, []);
  const modeNow = useCallback(() => modeRef.current, []);
  const modeGen = useRef(0);
  const modeEpoch = useCallback(() => modeGen.current, []);
  const currentKey = useCallback(() => (nativeRef.current?.unlocked ? (nativeRef.current.keyId ?? nativeRef.current.address ?? null) : null), []);
  const [nativeLost, setNativeLost] = useState<unknown>(null);
  const [keystoreOpening, setKeystoreOpening] = useState(false);
  const [keystoreAsking, setKeystoreAsking] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [opAsking, setOpAsking] = useState(false);
  const [opErr, setOpErr] = useState<unknown>(null);
  const [readbacks, setReadbacks] = useState(0);
  const [queued, setQueued] = useState(0);
  const [keystoreFrom, setKeystoreFrom] = useState<KeystoreFrom | null>(null);
  const [keystoreReading, setKeystoreReading] = useState<'item' | 'find' | null>(null);
  const [keystoreErr, setKeystoreErr] = useState<unknown>(null);
  const [keystoreFailedAt, setKeystoreFailedAt] = useState<'item' | 'open' | null>(null);
  const [confirmErr, setConfirmErr] = useState<unknown>(null);
  const [nativeAvailable, setNativeAvailable] = useState(hasNativeSigner);
  const [epoch, setEpoch] = useState(0);

  // The injected window.ethereum is a fallback for wallets that do not announce themselves, so it is not
  // touched until announcements had their chance (they answer the request event at once): reading it
  // first would ask whichever extension won window.ethereum, not the wallet the user is about to pick.
  const [discovered, setDiscovered] = useState(false);
  useEffect(() => {
    const stop = discoverWallets(setAnnounced);
    const t = setTimeout(() => setDiscovered(true), DISCOVERY_MS);
    return () => (clearTimeout(t), stop());
  }, []);
  useEffect(() => onFileWallet(() => setFile(fileWalletState())), []);

  const wallets = useMemo<WalletOption[]>(() => {
    if (announced.length) return announced.map((a) => ({ id: a.uuid, name: a.name, rdns: a.rdns, provider: a.provider }));
    const inj = discovered ? injectedProvider() : null;
    return inj ? [{ id: 'injected', name: 'Injected wallet', rdns: null, provider: inj }] : [];
  }, [announced, discovered]);
  // Exactly one candidate is picked for the user; with several, the user must pick (multi-extension safe).
  const chosen = wallets.find((w) => w.id === walletId) ?? (wallets.length === 1 ? wallets[0]! : null);
  const wallet = useWallet(dep, mode === 'wallet' ? (chosen?.provider ?? null) : null);

  // Bumped when the page starts talking to another signer (pairing ended or changed).
  const actionGen = useRef(0);
  const connection = useCallback(() => actionGen.current, []);
  // Status reads are ordered: an answer is shown only if no later-asked read has been shown already. An earlier read
  // answering late — say "locked" from before an unlock — never replaces a newer status, nor the earlier signer's
  // status the new one (a connection change moves `shownSeq` past every read asked before it). A busy answer (an
  // older signer that holds status behind another request) changes nothing: the status known so far stays.
  const statusSeq = useRef(0);
  const shownSeq = useRef(0);
  // The lock a way change sent for the key it left (keyId null: none was known — an unlock was still with the signer).
  // Until the signer answers it, a status naming that key (any unlocked key, for an unkeyed lock) shows it locked, so it
  // is never offered as ready again; a lock that failed keeps that until a status shows the key gone or a newer key is
  // installed (the signer holds one key), and says so with a way to lock it again.
  const leaving = useRef<{ id: number; keyId: string | null; failed: boolean; done: Promise<void> } | null>(null);
  const leaveSeq = useRef(0);
  const [leaveFailed, setLeaveFailed] = useState(false);
  // Requests that can install a key, and locks sent on leaving a way, still unanswered: a later request waits for them.
  const installing = useRef(new Set<Promise<unknown>>());
  const endLeave = useCallback(() => {
    leaving.current = null;
    setLeaveFailed(false);
  }, []);
  const refreshNative = useCallback(async () => {
    const seq = ++statusSeq.current;
    const show = (read: NativeStatus | null) => {
      if (seq <= shownSeq.current) return;
      shownSeq.current = seq;
      const l = leaving.current;
      const isLeft = !!l && !!read?.unlocked && (l.keyId === null || read.keyId === l.keyId);
      if (l?.failed && read && !isLeft) endLeave();
      const st = isLeft ? lockedCopy(read!) : read;
      // Read at once by an action's answer that awaited this read-back (before the next render).
      nativeRef.current = st;
      setNative(st);
    };
    if (!hasNativeSigner()) return show(null);
    try {
      show(await signerApi<NativeStatus>('/gas/status'));
    } catch (e) {
      // A signer that did not answer at all (the runner page's runner is lost) is the same signer with the same
      // key: what it last said stands until it answers again. Any other failure means the status is not known.
      if (!(e instanceof ApiError && (e.status === 409 || e.kind === 'offline'))) show(null);
    }
  }, [endLeave]);
  // The first read; every later signer appearing or changing is read by the connection handler below.
  useEffect(() => {
    if (hasNativeSigner()) void refreshNative();
  }, [refreshNative]);

  // A picked keystore file: re-read it while its key is unlocked and report its hash. A file that changed or cannot
  // be read any more locks the signer (it answers keystore-changed); a page that stops reporting stops authorizing.
  const picked = useRef<{ file: File; keyId: string } | null>(null);
  // An unlock whose reply arrives after a newer attempt (or a mode change) never rebinds the kept file.
  const pickedAttempt = useRef(0);
  const startPickedOpen = useCallback(() => {
    picked.current = null;
    return ++pickedAttempt.current;
  }, []);
  const keepPickedKeystore = useCallback((attempt: number, f: File | null, keyId?: string | null) => {
    if (attempt === pickedAttempt.current) picked.current = f && keyId ? { file: f, keyId } : null;
  }, []);
  // Another signer (hosted: the pairing ended, or the page paired again): nothing known about the earlier one is
  // kept — its status, address and version are cleared at once and read again from the new one, and a picked
  // file bound to the earlier unlock is let go. A local page's lost/recovered runner is the same signer.
  const signerAt = useRef<{ base: string | null; pairing: unknown }>({ base: signerOrigin(), pairing: pairedRunner() });
  useEffect(
    () =>
      onConnectionChange(() => {
        const now = { base: signerOrigin(), pairing: pairedRunner() };
        if (now.base !== signerAt.current.base || now.pairing !== signerAt.current.pairing) {
          signerAt.current = now;
          actionGen.current++;
          shownSeq.current = ++statusSeq.current;
          picked.current = null;
          pickedAttempt.current++;
          installing.current = new Set();
          endLeave();
          setNative(null);
          setKeystoreErr(null);
          setKeystoreFailedAt(null);
          setConfirmErr(null);
          setOpErr(null);
          // An unlock still waiting on the earlier signer is not this one's: its form is free again (the earlier
          // runner was asked to lock when the page disconnected, which also stops its 1Password wait).
          setKeystoreOpening(false);
          setKeystoreAsking(false);
          setConfirming(null);
          setOpAsking(false);
          setKeystoreReading(null);
          setReadbacks(0);
          setQueued(0);
          if (now.base) void refreshNative();
        }
        setNativeAvailable(hasNativeSigner());
      }),
    [refreshNative, endLeave],
  );
  const pickedKeystoreSha256 = useCallback(async (keyId: string | null | undefined) => {
    const p = picked.current;
    if (!p || !keyId || p.keyId !== keyId) return null;
    try {
      return await sha256OfText(await p.file.text());
    } catch {
      return '';
    }
  }, []);
  // A key unlocking again ends the earlier loss notice and the earlier confirmation error (a sheet opening again does not).
  const unlockedKeyId = native?.unlocked ? (native.keyId ?? null) : null;
  useEffect(() => {
    if (unlockedKeyId) (setNativeLost(null), setConfirmErr(null));
  }, [unlockedKeyId]);
  // Only the page that holds the file of this unlock re-checks it; a page merely seeing the shared status does not.
  const pickedKeyId = !!native?.unlocked && native.source?.kind === 'keystore' && native.source.origin === 'file' ? (native.keyId ?? null) : null;
  useEffect(() => {
    if (!pickedKeyId) return;
    let stopped = false;
    let running = false;
    let challenge = '';
    // Each report carries the signer's latest challenge; while a sign waits (`pending`), the file is read again at once.
    const check = async () => {
      if (running) return;
      running = true;
      try {
        for (let i = 0; i < 3 && !stopped; i++) {
          const sha256 = await pickedKeystoreSha256(pickedKeyId);
          if (stopped || sha256 === null) return;
          const r = await signerApi<{ challenge?: string; pending?: boolean }>('/gas/keystore/recheck', { keyId: pickedKeyId, sha256, challenge });
          challenge = typeof r.challenge === 'string' ? r.challenge : '';
          if (!r.pending) break;
        }
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.code === 'keystore-changed') setNativeLost(e);
        await refreshNative();
      } finally {
        running = false;
      }
    };
    void check();
    const t = setInterval(() => void check(), PICKED_RECHECK_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [pickedKeyId, pickedKeystoreSha256, refreshNative]);

  const payer = useMemo<GasPayer>(() => {
    const via = viaOf(mode);
    if (mode === 'wallet') {
      const ready = !!wallet.account && wallet.chainId === dep.chainId;
      return { mode, via, address: wallet.account, ready, epoch, provider: chosen?.provider ?? null };
    }
    if (mode === 'browser-file') return { mode, via, address: file.address, ready: !!file.address && file.confirmed, epoch, provider: null };
    const wantKinds = mode === 'native-op' ? ['op'] : mode === 'native-keystore' ? ['manifest', 'keystore'] : ['file'];
    const ok = !!native && native.unlocked && !!native.source && wantKinds.includes(native.source.kind);
    return { mode, via, address: ok ? native!.address : null, ready: ok && native!.confirmed, epoch, provider: null };
  }, [mode, wallet.account, wallet.chainId, dep.chainId, chosen, file, native, epoch]);

  // The identity a plan is built for. When it moves away from a payer that had an address, old plans are
  // void — a browser wallet's chain included: one that left Plasma and came back does not revive a plan.
  const identity = `${mode}|${mode === 'wallet' ? `${chosen?.id ?? ''}@${wallet.chainId ?? ''}` : ''}|${payer.address ? getAddress(payer.address) : ''}|${mode.startsWith('native') && native?.source ? JSON.stringify(native.source) : ''}`;
  const last = useRef<{ identity: string; hadAddress: boolean; mode: PayerMode } | null>(null);
  useEffect(() => {
    const prev = last.current;
    last.current = { identity, hadAddress: !!payer.address, mode };
    if (!prev || prev.identity === identity) return;
    if (prev.mode === mode && !prev.hadAddress) return; // a payer appearing (connect, unlock) voids nothing
    setEpoch((e) => e + 1);
    void announcePayerChange(prev.mode !== mode ? 'mode' : 'payer');
  }, [identity, mode, payer.address]);

  const lockLeftKey = useCallback((keyId: string) => signerApi('/gas/lock', { keyId }).then(() => undefined, () => undefined), []);
  const trackInstall = useCallback(<T,>(p: Promise<T>) => {
    const set = installing.current;
    set.add(p);
    p.then(
      () => set.delete(p),
      () => set.delete(p),
    );
    return p;
  }, []);
  const sendLeave = useCallback(
    (keyId: string | null) => {
      const id = ++leaveSeq.current;
      const mine = () => leaving.current?.id === id;
      const done = signerApi('/gas/lock', keyId ? { keyId } : {}).then(
        () => void (mine() && endLeave()),
        () => {
          if (!mine()) return;
          leaving.current!.failed = true;
          setLeaveFailed(true);
        },
      );
      leaving.current = { id, keyId, failed: false, done };
      // Every such lock is waited for, not only the latest: an earlier unkeyed one still unanswered would lock a newer key.
      trackInstall(done);
      setLeaveFailed(false);
      void done.then(refreshNative);
    },
    [endLeave, refreshNative, trackInstall],
  );
  const mustWait = useCallback(() => installing.current.size > 0, []);
  const signerSettled = useCallback(async () => {
    await Promise.allSettled([leaving.current?.done, ...installing.current]);
  }, []);
  // Ordered like any request: sent only once every earlier install is answered, and not at all if one of them put a
  // newer key in the signer meanwhile (that ended this record) — an unkeyed lock would lock that newer key.
  const relockLeft = useCallback(async () => {
    const l = leaving.current;
    if (!l?.failed) return;
    await signerSettled();
    if (leaving.current === l) sendLeave(l.keyId);
  }, [sendLeave, signerSettled]);

  const setMode = useCallback(
    (m: PayerMode) => {
      if (m === mode) return;
      setNativeLost(null);
      setKeystoreErr(null);
      setKeystoreFailedAt(null);
      setConfirmErr(null);
      setOpErr(null);
      startPickedOpen();
      // Leaving a mode ends its key: the File key is dropped from memory, the runner's signer locks.
      if (mode === 'browser-file') lockFileWallet();
      if (mode.startsWith('native')) {
        // The lock names the key being left, so it never locks a key another way unlocked before it arrived; with
        // no key known (an unlock still with the signer) it locks whatever is there and ends that wait.
        // A key already being left (its lock failed or is unanswered) is named again rather than locking whatever is there.
        const left = nativeRef.current;
        const keyId = (left?.unlocked ? left.keyId : null) ?? leaving.current?.keyId ?? null;
        // Shown as locked at once: a way chosen again before the lock is answered never offers the left key as ready.
        if (left?.unlocked) {
          shownSeq.current = ++statusSeq.current;
          const st = lockedCopy(left);
          nativeRef.current = st;
          setNative(st);
        }
        sendLeave(keyId);
      }
      modeRef.current = m;
      modeGen.current++;
      setQueued(0);
      setReadbacks(0);
      // A request of the way left still with the signer is not this way's: its approval wait (ended by the lock just
      // sent) and its "working" flags end now. A request of the new way still waits for its answer (signerSettled).
      setKeystoreOpening(false);
      setKeystoreAsking(false);
      setKeystoreReading(null);
      setOpAsking(false);
      setModeState(m);
    },
    [mode, sendLeave, startPickedOpen],
  );

  return { payer, compat: signerCompat(native), mode, setMode, wallets, walletId: chosen?.id ?? null, pickWallet: setWalletId, wallet, native, refreshNative, nativeAvailable, startPickedOpen, keepPickedKeystore, pickedKeystoreSha256, nativeLost, keystoreOpening, setKeystoreOpening, keystoreAsking, setKeystoreAsking, confirming, setConfirming, readingBack: readbacks > 0, beginReadback, currentKey, nativeReadyAs, modeNow, modeEpoch, lockLeftKey, signerSettled, trackInstall, signerQueued: queued > 0, mustWait, beginQueued, keyInstalled: endLeave, leaveFailed, relockLeft, opAsking, setOpAsking, opErr, setOpErr, keystoreFrom, setKeystoreFrom, keystoreReading, setKeystoreReading, keystoreErr, setKeystoreErr, keystoreFailedAt, setKeystoreFailedAt, confirmErr, setConfirmErr, connection };
}
