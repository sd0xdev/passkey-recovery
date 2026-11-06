// The gas payer sheet (GAS-01..05). One mode at a time; every mode shows the full gas wallet address and
// nothing signs until the user confirmed that exact derived address. Secrets typed here (keystore
// passwords) go only to the File key in this page or to the runner's native signer — never the sidecar —
// and the inputs are cleared after use. A 1Password link names an item; the runner's op CLI reads it.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { SupportedDeployment } from '../../config/registry';
import { confirmFileAddress, createKeystore, fileWalletState, lockFileWallet, onFileWallet, openKeystore } from '../../wallet/fileWallet';
import { SIGNER_API } from '../../config/signerApi';
import { ApiError, isHosted, pageKind, signerApi, signerOrigin } from '../api';
import { downloadText } from '../common';
import { hasMessage, useT, type MsgKey } from '../i18n';
import { AddressDisplay, Field, Notice } from '../primitives';
import type { PayerMode } from './payer';
import { STAGE_MARK, stageState, type StageActivity } from './stages';
import type { GasPayerState, KeystoreFrom, KeystoreSourceStatus, NativeStatus } from './useGasPayer';

const MODES: PayerMode[] = ['wallet', 'browser-file', 'native-op', 'native-keystore', 'native-file'];
/** Why a native mode is off when no signer answers, said for where this page is (PM-04, the pageKind contract). */
const NEEDS_RUNNER = {
  runner: 'gas.opt.needsRunner.runner',
  website: 'gas.opt.needsRunner.website',
  'static-preview': 'gas.opt.needsRunner.preview',
} as const satisfies Record<ReturnType<typeof pageKind>, MsgKey>;

/** A precise, translated reason for a failure; the raw message only when no class is known. */
export function gasErrorKey(e: unknown): { key: MsgKey } | { raw: string } {
  if (e instanceof ApiError) {
    // A code without copy (a newer runner) falls back to the runner's own message, never a missing key.
    const key = `gas.err.${e.code}`;
    if (e.code && /^(op|file|store|manifest|keystore|sign|runner)-[a-z-]+$/.test(e.code) && hasMessage(key)) return { key };
    if (e.kind === 'no-sidecar') return { key: 'gas.err.no-runner' };
    if (e.kind === 'offline') return { key: 'error.offline' };
    return { raw: e.message };
  }
  const code = (e as { code?: unknown } | null)?.code;
  const fileKey = `gas.err.file-${String(code)}`;
  if (typeof code === 'string' && /^[a-z-]+$/.test(code) && hasMessage(fileKey)) return { key: fileKey };
  return { raw: e instanceof Error ? e.message : String(e) };
}

/**
 * One option of a choice: the whole row is the label (radio, short title, one-line purpose). Chosen, available and
 * unavailable rows differ by a word and the row's frame, not only by colour; the radio keeps native keyboard use.
 */
function OptionRow({ name, value, checked, disabled, onChange, testId, title, line, tag, offNote }: { name: string; value: string; checked: boolean; disabled?: boolean; onChange: () => void; testId: string; title: string; line?: string | undefined; tag?: string | undefined; offNote?: string | undefined }) {
  const { t } = useT();
  const state = disabled ? 'off' : checked ? 'chosen' : 'idle';
  return (
    <label className="lb-option" data-state={state}>
      <input type="radio" className="lb-option-radio" name={name} value={value} checked={checked} disabled={disabled} onChange={onChange} data-testid={testId} />
      <span className="lb-option-text">
        <span className="lb-option-title">
          {title}
          {tag && <span className="lb-option-tag">{tag}</span>}
          {state === 'chosen' && <span className="lb-option-mark">{t('gas.opt.chosen')}</span>}
        </span>
        {(disabled && offNote) || line ? <span className="lb-option-line">{disabled && offNote ? offNote : line}</span> : null}
      </span>
    </label>
  );
}

/**
 * An incompatible native signer (older or newer contract), or one whose version is not known yet (no status answer):
 * what to do, before any unlock is offered, and a way to ask again.
 */
function CompatNotice({ g }: { g: GasPayerState }) {
  const { t } = useT();
  const state = g.compat ?? (g.nativeAvailable ? 'unknown' : null);
  if (!state || state === 'ok') return null;
  return (
    <div className="lb-gas-compat" role="status" data-testid="gas-compat" data-compat={state}>
      <p className="lb-gas-compat-text">{t(`gas.compat.${state}.${isHosted() ? 'hosted' : 'local'}` as MsgKey)}</p>
      {state !== 'unknown' && <p className="lb-help">{t('gas.compat.versions', { runner: String(typeof g.native?.api === 'number' ? g.native.api : 1), page: String(SIGNER_API) })}</p>}
      <button type="button" className="lb-btn lb-btn-quiet" onClick={() => void g.refreshNative()} data-testid="gas-compat-recheck">
        {t('gas.compat.recheck')}
      </button>
    </div>
  );
}

/** `onReady`: the user just confirmed a gas wallet in this sheet (the sheet may close: the chip shows it). */
export function GasPanel({ dep, g, onReady }: { dep: SupportedDeployment; g: GasPayerState; onReady?: () => void }) {
  const { t } = useT();
  const native = dep.assets.find((a) => a.native)!.symbol;
  const name = useId();
  const incompatible = !!g.compat && g.compat !== 'ok';
  const nativeMode = g.mode.startsWith('native');
  const formRef = useRef<HTMLDivElement>(null);
  // The sheet's width class, kept live: crossing the breakpoint with the sheet open (a resize, a zoom, a rotated
  // phone) folds or opens the mode's explanation the way a sheet opened at that width would (PM-02b). React sets
  // `open` only when this value changes, so between crossings the reader's own toggle stands.
  const [narrow, setNarrow] = useState(narrowSheet);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(NARROW_SHEET);
    const follow = () => setNarrow(mq.matches);
    follow();
    mq.addEventListener('change', follow);
    return () => mq.removeEventListener('change', follow);
  }, []);
  const modesRef = useRef<HTMLFieldSetElement>(null);
  // PM-02: on a narrow sheet the form sits under the mode list. Choosing a mode brings the chosen mode's form (its
  // name and first field) into view; "Change" goes back to the list with focus on the chosen mode.
  const choose = (m: PayerMode) => {
    g.setMode(m);
    if (!narrowSheet()) return;
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }));
  };
  // The chosen mode's radio, or — when it is unavailable now (its runner gone or outdated: a disabled input takes no
  // focus) — the first one that can be chosen, with the list brought into view.
  const change = () => {
    const list = modesRef.current;
    const to = list?.querySelector<HTMLInputElement>('input:checked:not(:disabled)') ?? list?.querySelector<HTMLInputElement>('input:not(:disabled)');
    list?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
    to?.focus();
  };
  return (
    <div className="lb-gas" data-testid="gas-panel">
      <p className="lb-lead">{t('gas.lead', { native })}</p>
      <CompatNotice g={g} />
      <div className="lb-gas-grid">
        <fieldset className="lb-choice lb-gas-modes" ref={modesRef}>
          <legend>{t('gas.mode')}</legend>
          {MODES.map((m) => {
            const needsRunner = m.startsWith('native');
            const missing = needsRunner && !g.nativeAvailable;
            // Until the signer's status (and so its version) is known, its modes are not offered either.
            const unknown = needsRunner && !missing && !g.compat;
            const off = missing || unknown || (needsRunner && incompatible);
            return (
              <OptionRow
                key={m}
                name={name}
                value={m}
                checked={g.mode === m}
                disabled={off}
                onChange={() => choose(m)}
                testId={`gas-mode-${m}`}
                title={t(`gas.opt.${m}` as MsgKey)}
                line={t(`gas.opt.${m}.line` as MsgKey)}
                tag={needsRunner ? t('gas.opt.runner') : undefined}
                offNote={missing ? t(NEEDS_RUNNER[pageKind()]) : unknown ? t('gas.opt.waitRunner') : t('gas.opt.updateRunner')}
              />
            );
          })}
        </fieldset>
        <div className="lb-gas-form" data-testid="gas-form" data-mode={g.mode} ref={formRef}>
          <div className="lb-gas-form-head">
            <h3 className="lb-gas-form-title">{t(`gas.opt.${g.mode}` as MsgKey)}</h3>
            <button type="button" className="lb-btn lb-btn-link lb-gas-change" onClick={change} data-testid="gas-change">
              {t('gas.change')}
            </button>
          </div>
          {/* PM-02: on a narrow sheet the mode's explanation folds away so the next field shares the screen with the
              mode's name; it starts open on a wide sheet, and is one tap away on a narrow one. */}
          <details className="lb-tech lb-gas-about" open={!narrow} data-testid="gas-about">
            <summary>{t('gas.about')}</summary>
            <p className="lb-help">{t(`gas.mode.${g.mode}.help` as MsgKey)}</p>
          </details>
          {/* The runner locked a picked keystore while the sheet may have been closed: say why, until a key unlocks again. */}
          <ErrorLine err={g.nativeLost ? gasErrorKey(g.nativeLost) : null} testId="gas-lost" />
          {/* A request waits, unsent, for the signer to answer the lock of the way left (or an earlier unlock). */}
          {g.signerQueued && (
            <p role="status" className="lb-help" data-testid="gas-queued">
              {t('gas.queued')}
            </p>
          )}
          {/* The lock sent for the key of a way left was not answered: that key may still be unlocked in the signer. */}
          {g.leaveFailed && (
            <Notice tone="bad" testId="gas-lock-failed">
              {t('gas.leave.failed')}{' '}
              <button type="button" className="lb-btn lb-btn-link" onClick={g.relockLeft} data-testid="gas-lock-retry">
                {t('gas.leave.retry')}
              </button>
            </Notice>
          )}
          {/* A native form is shown only for a signer known to speak this page's contract (not before its status is read). */}
          {nativeMode && g.compat !== 'ok' ? null : (
            <>
              {g.mode === 'wallet' && <WalletMode dep={dep} g={g} />}
              {g.mode === 'browser-file' && <BrowserFileMode native={native} onReady={onReady} />}
              {g.mode === 'native-op' && <NativeOpMode g={g} onReady={onReady} />}
              {g.mode === 'native-keystore' && <NativeKeystoreMode g={g} onReady={onReady} />}
              {g.mode === 'native-file' && <NativeFileMode g={g} native={native} onReady={onReady} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const NARROW_SHEET = '(max-width: 899px)';
const narrowSheet = () => typeof window.matchMedia === 'function' && window.matchMedia(NARROW_SHEET).matches;
const reducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function ErrorLine({ err, testId = 'gas-error' }: { err: ReturnType<typeof gasErrorKey> | null; testId?: string }) {
  const { t } = useT();
  if (!err) return null;
  return (
    <Notice tone="bad" testId={testId}>
      {'key' in err ? t(err.key) : err.raw}
    </Notice>
  );
}

/** The derived address in full and the one confirmation that lets it sign (GAS-05). */
function ConfirmAddress({ address, confirmed, onConfirm, onLock, busy, children }: { address: string; confirmed: boolean; onConfirm: () => void; onLock: () => void; busy: boolean; children?: ReactNode }) {
  const { t } = useT();
  return (
    <div className="lb-confirm" data-testid="gas-derived" data-confirmed={confirmed}>
      <p>{t(confirmed ? 'gas.confirmed' : 'gas.derived')}</p>
      <AddressDisplay value={address} testId="gas-address" />
      {children}
      <div className="lb-actions">
        {!confirmed && (
          <button type="button" className="lb-btn" onClick={onConfirm} disabled={busy} data-testid="gas-confirm">
            {t('gas.confirm')}
          </button>
        )}
        <button type="button" className="lb-btn lb-btn-quiet" onClick={onLock} disabled={busy} data-testid="gas-lock">
          {t('gas.lock')}
        </button>
      </div>
    </div>
  );
}

function WalletMode({ dep, g }: { dep: SupportedDeployment; g: GasPayerState }) {
  const { t } = useT();
  const name = useId();
  const w = g.wallet;
  return (
    <section data-testid="gas-wallet">
      {g.wallets.length === 0 && <Notice tone="warn" testId="gas-no-wallet">{t('gas.wallet.none')}</Notice>}
      {g.wallets.length > 1 && (
        <fieldset className="lb-choice">
          <legend>{t('gas.wallet.pick')}</legend>
          {g.wallets.map((o) => (
            <OptionRow key={o.id} name={name} value={o.id} checked={g.walletId === o.id} onChange={() => g.pickWallet(o.id)} testId={`gas-wallet-${o.rdns ?? o.id}`} title={o.name} line={o.rdns ?? undefined} />
          ))}
        </fieldset>
      )}
      {g.walletId && !w.account && (
        <button type="button" className="lb-btn" onClick={() => void w.connect()} disabled={w.busy} data-testid="gas-wallet-connect">
          {w.busy ? t('wallet.connecting') : t('wallet.connect')}
        </button>
      )}
      {w.account && w.chainId !== dep.chainId && (
        <button type="button" className="lb-btn" onClick={() => void w.switchChain()} disabled={w.busy} data-testid="gas-wallet-switch">
          {t('wallet.switch', { name: dep.chainName })}
        </button>
      )}
      {w.account && (
        <div className="lb-confirm">
          <p>{t('gas.wallet.account', { id: w.chainId ?? '?' })}</p>
          <AddressDisplay value={w.account} testId="gas-address" />
        </div>
      )}
      {w.error && <Notice tone="bad">{t('wallet.error', { reason: w.error })}</Notice>}
    </section>
  );
}

function BrowserFileMode({ native, onReady }: { native: string; onReady?: (() => void) | undefined }) {
  const { t } = useT();
  const ids = { file: useId(), pw: useId(), npw: useId(), rep: useId() };
  const [text, setText] = useState<string | null>(null);
  const [pw, setPw] = useState('');
  const [npw, setNpw] = useState('');
  const [rep, setRep] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ReturnType<typeof gasErrorKey> | null>(null);
  // The File key lives in the wallet module, not in this sheet: reopening the sheet shows it as it is.
  const [fw, setFw] = useState(fileWalletState);
  // The encrypted file just created in this sheet, so it can be downloaded again if the first one was missed.
  // Bound to the address it encrypts: offered only while that same key is the one shown, dropped on lock.
  const [made, setMade] = useState<{ address: string; fileName: string; json: string } | null>(null);
  useEffect(() => onFileWallet(() => setFw(fileWalletState())), []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(gasErrorKey(e));
    } finally {
      setBusy(false);
    }
  };
  if (fw.address) {
    const address = fw.address;
    return (
      <ConfirmAddress
        address={address}
        confirmed={fw.confirmed}
        busy={busy}
        onConfirm={() => {
          confirmFileAddress(address);
          onReady?.();
        }}
        onLock={() => {
          setMade(null);
          lockFileWallet();
        }}
      >
        {made && made.address === address && !fw.confirmed && (
          <>
            <p className="lb-help" data-testid="gas-file-why">{t('gas.file.why')}</p>
            <button type="button" className="lb-btn lb-btn-quiet" onClick={() => downloadText(made.fileName, made.json)} data-testid="gas-file-again">
              {t('gas.file.again')}
            </button>
          </>
        )}
      </ConfirmAddress>
    );
  }
  return (
    <section data-testid="gas-browser-file">
      <p className="lb-help">{t('gas.file.memoryOnly')}</p>
      <h3>{t('gas.file.open')}</h3>
      <Field id={ids.file} label={t('gas.file.choose')}>
        <input id={ids.file} type="file" accept="application/json,.json" onChange={(e) => void e.target.files?.[0]?.text().then(setText)} data-testid="gas-file-input" />
      </Field>
      <Field id={ids.pw} label={t('gas.file.password')}>
        <input id={ids.pw} type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} data-testid="gas-file-password" />
      </Field>
      <button
        type="button"
        className="lb-btn"
        disabled={busy || !text || !pw}
        onClick={() =>
          void run(async () => {
            await openKeystore(text!, pw);
            setPw('');
          })
        }
        data-testid="gas-file-open"
      >
        {busy ? t('gas.unlocking') : t('gas.file.openButton')}
      </button>
      <h3>{t('gas.file.create')}</h3>
      <p className="lb-help">{t('gas.file.createHelp')}</p>
      <Notice tone="warn" testId="gas-file-risk">{t('gas.file.risk', { native })}</Notice>
      <Field id={ids.npw} label={t('gas.file.newPassword')}>
        <input id={ids.npw} type="password" autoComplete="new-password" value={npw} onChange={(e) => setNpw(e.target.value)} data-testid="gas-file-new-password" />
      </Field>
      <Field id={ids.rep} label={t('gas.file.repeat')}>
        <input id={ids.rep} type="password" autoComplete="new-password" value={rep} onChange={(e) => setRep(e.target.value)} data-testid="gas-file-repeat" />
      </Field>
      <button
        type="button"
        className="lb-btn lb-btn-quiet"
        disabled={busy || !npw || npw !== rep}
        onClick={() =>
          void run(async () => {
            const r = await createKeystore(npw);
            setNpw('');
            setRep('');
            setMade({ address: r.address, fileName: r.fileName, json: r.json });
            // The encrypted file is the only copy of this key: it is offered at once, before any use.
            downloadText(r.fileName, r.json);
          })
        }
        data-testid="gas-file-create"
      >
        {t('gas.file.createButton')}
      </button>
      <ErrorLine err={err} />
    </section>
  );
}

/** `shared`: keep the error in the payer state instead of this form, so it outlives the sheet being closed. */
function useNativeAction(g: GasPayerState, shared?: { err: unknown; setErr(e: unknown): void }) {
  const [busy, setBusy] = useState(false);
  // The signer request itself is running (busy also covers the status read-back after it answered).
  const [requesting, setRequesting] = useState(false);
  const [localErr, setLocalErr] = useState<unknown>(null);
  const raw = shared ? shared.err : localErr;
  const setErr = shared ? shared.setErr : setLocalErr;
  const err = raw === null ? null : gasErrorKey(raw);
  // An action started on an earlier signer connection (hosted: disconnected or paired again meanwhile) leaves
  // nothing behind: no result, no error.
  // `installs`: the request can put a key in the signer (an unlock or a create). If it succeeds after the payer way
  // was changed — the request reached the signer after the lock that change sent — the key it installed (the keyId
  // in its answer) is locked; the signer ignores that lock if a newer key replaced it. The answer is not this form's.
  const run = async <T,>(fn: () => Promise<T>, installs = false): Promise<T | null> => {
    const at = g.connection();
    // A failure that lands after the payer way was changed (even away and back) is that earlier attempt's: not shown.
    const gen = g.modeEpoch();
    setBusy(true);
    setErr(null);
    try {
      // Sent only after the signer answered the lock a way change sent and every earlier request that can install a
      // key (with its relock): neither can then lock, or replace, what this request does. Left meanwhile: not sent.
      // Until then the form is locked and says it waits for the signer — not that this request is with it.
      if (g.mustWait()) {
        const endQueued = g.beginQueued();
        try {
          await g.signerSettled();
        } finally {
          endQueued();
        }
      }
      if (at !== g.connection() || gen !== g.modeEpoch()) return null;
      setRequesting(true);
      const answer = async () => {
        const r = await fn();
        const keyId = installs && at === g.connection() && gen !== g.modeEpoch() ? (r as { keyId?: unknown } | null)?.keyId : null;
        if (typeof keyId === 'string') await g.lockLeftKey(keyId);
        // Part of the tracked request: anything waiting on it (a retried leave lock) sees the newer key at once.
        else if (installs && at === g.connection() && gen === g.modeEpoch()) g.keyInstalled();
        return r;
      };
      const r = await (installs ? g.trackInstall(answer()) : answer());
      if (at !== g.connection() || gen !== g.modeEpoch()) return null;
      return r;
    } catch (e) {
      if (at === g.connection() && gen === g.modeEpoch()) setErr(e);
      return null;
    } finally {
      setRequesting(false);
      // Busy until the signer's status is read back: the form stays locked until the outcome is shown, so
      // nothing can be edited between the answer and the sheet acting on it. The read-back is marked in the payer
      // state too, so a sheet reopened in that moment is still locked and "working".
      // A request made stale meanwhile (another connection or way) still reads the status, but marks no form busy.
      const end = g.beginReadback(at, gen);
      try {
        await g.refreshNative();
      } finally {
        setBusy(false);
        end();
      }
    }
  };
  const clear = useCallback(() => setErr(null), [setErr]);
  return { busy, requesting, err, run, clear };
}

function NativeConfirm({ g, kind, children, onReady }: { g: GasPayerState; kind: ReadonlyArray<'op' | 'file' | 'manifest' | 'keystore'>; children: ReactNode; onReady?: (() => void) | undefined }) {
  const a = useNativeAction(g, { err: g.confirmErr, setErr: g.setConfirmErr });
  // A running confirmation lives in the payer state: the keystore's stage ledger shows it as "working" (PM-01a), and a
  // sheet closed and opened again meanwhile keeps the button locked instead of offering a second request.
  // The flag names the key it confirms: its end clears only its own flag, never a newer key's, and an answer that lands
  // after another key was unlocked (a mode change locked this one) — a refusal or a success — is not that key's.
  const confirmNow = (keyId: string, addr: string) => {
    g.setConfirming(keyId);
    // Still this key, and no way change since (away and back included): a way switch locks the key at once,
    // before any status says so.
    const at = g.modeNow();
    const gen = g.modeEpoch();
    const sameKey = () => g.modeEpoch() === gen && g.currentKey() === keyId;
    void a
      .run(async () => {
        try {
          return await confirm(addr);
        } catch (e) {
          if (sameKey()) throw e;
          return null;
        }
      })
      .then((r) => {
        g.setConfirming((cur) => (cur === keyId ? null : cur));
        // A success that lands after another key was unlocked finishes nothing: the newer key still needs its own
        // confirmation, so the sheet stays open on it.
        if (r && sameKey() && g.nativeReadyAs(at)) onReady?.();
      });
  };
  const n = g.native;
  // An error from confirming (e.g. keystore-changed: the signer dropped the key) stays shown, also on a sheet opened
  // again; it is cleared by a retry or when a key is unlocked again (useGasPayer), never by this form mounting.
  // A picked keystore file is confirmed against a re-read of it now (its sha256), not the one opened earlier.
  // It names the unlock it confirms (keyId): one that is no longer unlocked (locked, another source) changes nothing.
  // A picked file opened in another tab is not this page's to confirm: it says so and sends nothing.
  const confirm = async (addr: string) => {
    if (!(n?.source?.kind === 'keystore' && n.source.origin === 'file')) return signerApi('/gas/confirm', { keyId: n?.keyId, address: addr });
    const sha256 = await g.pickedKeystoreSha256(n.keyId);
    if (sha256 === null) throw new ApiError(409, 'the picked keystore file was opened in another tab', 'http', 'keystore-other-tab');
    return signerApi('/gas/confirm', { keyId: n.keyId, address: addr, sha256 });
  };
  const confirmingThis = !!n?.unlocked && g.confirming !== null && g.confirming === (n.keyId ?? n.address);
  if (n?.unlocked && n.address && n.source && kind.includes(n.source.kind))
    return (
      <>
        <ConfirmAddress address={n.address} confirmed={n.confirmed} busy={a.busy || confirmingThis || g.readingBack} onConfirm={() => confirmNow(n.keyId ?? n.address!, n.address!)} onLock={() => void a.run(() => signerApi('/gas/lock'))}>
          {n.source.kind === 'keystore' && <KeystoreSourceLine s={n.source} />}
        </ConfirmAddress>
        <ErrorLine err={a.err} />
      </>
    );
  return (
    <>
      {children}
      <ErrorLine err={a.err} />
    </>
  );
}

function NativeOpMode({ g, onReady }: { g: GasPayerState; onReady?: (() => void) | undefined }) {
  const { t } = useT();
  const ids = { link: useId(), field: useId(), pwf: useId() };
  const a = useNativeAction(g, { err: g.opErr, setErr: g.setOpErr });
  // The request lives in the payer state too: a sheet closed and opened again while 1Password is asked still shows
  // the wait and its Stop, and keeps the form locked until the signer answers.
  const locked = a.busy || g.opAsking || g.readingBack;
  // Only until the signer answers: its status read-back afterwards waits on nothing in 1Password (PM-01b).
  const ask = <T,>(fn: () => Promise<T>, installs = false) => {
    const at = g.connection();
    const ep = g.modeEpoch();
    // Marked once the request is sent (it may first wait for the signer to answer an earlier lock).
    return a.run(() => {
      g.setOpAsking(true);
      return fn().finally(() => at === g.connection() && ep === g.modeEpoch() && g.setOpAsking(false));
    }, installs);
  };
  const [link, setLink] = useState('');
  const [fields, setFields] = useState<Array<{ id: string; label: string; section: string | null; shape: string; address?: string | null }> | null>(null);
  const [field, setField] = useState('');
  const [pwField, setPwField] = useState('');
  const picked = fields?.find((f) => f.id === field);
  return (
    <NativeConfirm g={g} kind={["op"]} onReady={onReady}>
      <section data-testid="gas-native-op">
        <p className="lb-help">{t('gas.op.help')}</p>
        <Field id={ids.link} label={t('gas.op.link')} help={t('gas.op.linkHelp')}>
          <input
            id={ids.link}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={link}
            // While the signer reads or unlocks, the item and field it was asked for stay the ones on screen.
            disabled={locked}
            onChange={(e) => {
              setLink(e.target.value);
              setFields(null);
              setField('');
            }}
            data-testid="gas-op-link"
          />
        </Field>
        <button type="button" className="lb-btn lb-btn-quiet" disabled={locked || !link.trim()} onClick={() => void ask(async () => setFields((await signerApi<{ fields: typeof fields }>('/gas/op/inspect', { link: link.trim() })).fields))} data-testid="gas-op-inspect">
          {locked && !fields ? t('gas.op.reading') : t('gas.op.inspect')}
        </button>
        {fields && (
          <>
            {/* Every field can be picked: the shape is only a hint from the read (a "password" field can hold a raw
                key). The signer reads the value again on unlock and accepts only a valid key or keystore. */}
            <Field id={ids.field} label={t('gas.op.field')} help={t('gas.op.fieldHelp')}>
              <select id={ids.field} value={field} disabled={locked} onChange={(e) => setField(e.target.value)} data-testid="gas-op-field">
                <option value="">{t('gas.op.fieldChoose')}</option>
                {fields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.section ? `${f.section} / ` : ''}
                    {f.label} — {hasMessage(`gas.op.shape.${f.shape}`) ? t(`gas.op.shape.${f.shape}` as MsgKey) : f.shape}
                    {f.address ? ` · ${t('gas.op.keyFor', { address: f.address })}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            {picked?.address && (
              <div className="lb-confirm" data-testid="gas-op-picked">
                <p>{t('gas.op.picked')}</p>
                <AddressDisplay value={picked.address} testId="gas-op-picked-address" />
                <p className="lb-help">{t('gas.op.useHelp')}</p>
              </div>
            )}
            {picked?.shape === 'keystore-v3' && (
              <Field id={ids.pwf} label={t('gas.op.passwordField')}>
                <select id={ids.pwf} value={pwField} disabled={locked} onChange={(e) => setPwField(e.target.value)} data-testid="gas-op-password-field">
                  <option value="">{t('gas.op.fieldChoose')}</option>
                  {fields
                    .filter((f) => f.id !== field)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.section ? `${f.section} / ` : ''}
                        {f.label}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <button
              type="button"
              className="lb-btn"
              disabled={locked || !picked || (picked.shape === 'keystore-v3' && !pwField)}
              onClick={() =>
                void ((gen) =>
                  ask(() => signerApi('/gas/op/unlock', { link: link.trim(), field, ...(picked?.shape === 'keystore-v3' ? { passwordField: pwField } : {}), ...(picked?.address ? { confirmAddress: picked.address } : {}) }), true)
                    .then((r) => r && picked?.address && g.modeEpoch() === gen && g.nativeReadyAs('native-op') && onReady?.()))(g.modeEpoch())
              }
              data-testid="gas-op-unlock"
            >
              {g.signerQueued ? t('gas.queued.button') : locked ? t('gas.unlocking') : picked?.address ? t('gas.op.useThis') : t('gas.op.unlock')}
            </button>
          </>
        )}
        {/* Only while the request is with the signer: its status read-back afterwards waits on nothing in 1Password. */}
        {(a.requesting || g.opAsking) && (
          // The op CLI asks the 1Password app to approve. Stopping ends that op in the signer, so approving
          // afterwards reads nothing; the link and field stay for a retry.
          <div role="status" className="lb-help" data-testid="gas-op-waiting">
            <p>{t('gas.op.waiting')}</p>
            <button type="button" className="lb-btn lb-btn-quiet" onClick={() => void signerApi('/gas/lock').catch(() => undefined)} data-testid="gas-op-stop">
              {t('gas.op.stop')}
            </button>
          </div>
        )}
        <ErrorLine err={a.err} />
      </section>
    </NativeConfirm>
  );
}

/** Where the opened keystore came from, as the signer recorded it (the page never claims a path it does not know). */
function KeystoreSourceLine({ s }: { s: KeystoreSourceStatus }) {
  const { t } = useT();
  return (
    <div className="lb-help" data-testid="gas-ks-source">
      <p className="lb-break">{s.origin === 'field' ? t('gas.ks.src.field', { path: s.path }) : t('gas.ks.src.file', { name: s.name })}</p>
      {s.manifest && <p data-testid="gas-ks-src-manifest">{t('gas.ks.src.manifest')}</p>}
      <details className="lb-tech">
        <summary>{t('gas.ks.tech')}</summary>
        <p>
          {t('gas.ks.src.sha')} <code className="lb-mono lb-break" data-testid="gas-ks-sha256">{s.sha256}</code>
        </p>
      </details>
    </div>
  );
}

type KsFrom = KeystoreFrom;
const STAGES = ['source', 'item', 'fields', 'open', 'confirm'] as const;
type Stage = Exclude<(typeof STAGES)[number], 'source'> | 'complete';

/**
 * Where the user is in opening an existing keystore: a real sequence, so a numbered ledger. Each stage says its state
 * in words, never by colour alone; the current stage reads "working" or "waiting for 1Password" only while a request
 * really runs, otherwise it is the user's turn (stageState).
 */
function KeystoreStages({ from, stage, activity }: { from: KsFrom; stage: Stage; activity: StageActivity }) {
  const { t } = useT();
  const at = stage === 'complete' ? STAGES.length : STAGES.indexOf(stage);
  return (
    <ol className="lb-stages" aria-label={t('gas.stage.label')} data-testid="gas-ks-stages" data-stage={stage}>
      {STAGES.map((s, i) => {
        const state = stageState(i, at, activity);
        const name = s === 'item' && from !== 'field' ? t(`gas.stage.item.${from}` as MsgKey) : t(`gas.stage.${s}` as MsgKey);
        return (
          <li key={s} data-state={state} aria-current={i === at ? 'step' : undefined} data-testid={`gas-ks-stage-${s}`}>
            <span className="lb-stage-mark" aria-hidden="true">
              {STAGE_MARK[state]}
            </span>
            <span className="lb-stage-name">{name}</span>
            <span className="lb-stage-word">{t(`gas.stage.${state}` as MsgKey)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The existing gas wallet: an encrypted keystore on this computer whose password is in 1Password. Three ways to say
 * which keystore — the one the runner's manifest names; the path a field of the user's item holds (the runner reads
 * that field itself: the page never sends a path); or a keystore file the user picks here (only its encrypted text
 * goes, to the runner's signer). No secret passes through the page: the password is read from the field the user
 * picks, in the signer, after the user approves in the 1Password app.
 */
function NativeKeystoreMode({ g, onReady }: { g: GasPayerState; onReady?: (() => void) | undefined }) {
  const { t } = useT();
  const ids = { link: useId(), item: useId(), path: useId(), pwf: useId(), pick: useId(), from: useId() };
  const a = useNativeAction(g, { err: g.keystoreErr, setErr: g.setKeystoreErr });
  // Busy also while an unlock or a read started by an earlier opening of this sheet is still with the signer (the
  // form stays locked).
  const busy = a.busy || g.keystoreOpening || g.keystoreReading !== null || g.readingBack;
  const hasManifest = g.native?.manifestAvailable !== false;
  // The source chosen is kept in the payer state: a sheet opened again shows the same form (and its stage ledger).
  const [chosen, setChosen] = useState<KsFrom>(g.keystoreFrom ?? (hasManifest ? 'manifest' : 'field'));
  const setFromState = (f: KsFrom) => {
    setChosen(f);
    g.setKeystoreFrom(f);
  };
  // A runner without a manifest has no manifest choice, even if the status arrived after the first render.
  const from: KsFrom = chosen === 'manifest' && !hasManifest ? 'field' : chosen;
  const [wallet, setWallet] = useState<{ address: string; keystore: string } | null>(null);
  const [link, setLink] = useState('');
  const [fields, setFields] = useState<Array<{ id: string; label: string; section: string | null; shape: string }> | null>(null);
  const [pathField, setPathField] = useState('');
  const [pwField, setPwField] = useState('');
  const [file, setFile] = useState<{ name: string; size: number; text: string; file: File } | null>(null);
  // Every pick, clear or source change bumps this: a slower read of an earlier file never replaces a newer choice.
  const pickGen = useRef(0);
  const [fileErr, setFileErr] = useState<MsgKey | null>(null);
  const opening = g.keystoreOpening;
  const setOpening = g.setKeystoreOpening;
  /** Marks the unlock request as with the signer (waiting on 1Password) until it answers; a reply from an earlier signer connection leaves the flag to that reset. */
  const asking = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const at = g.connection();
    const ep = g.modeEpoch();
    g.setKeystoreAsking(true);
    try {
      return await fn();
    } finally {
      if (at === g.connection() && ep === g.modeEpoch()) g.setKeystoreAsking(false);
    }
  };
  /** Runs a request of one stage; if it fails, that stage (and only it) is the failed one in the ledger. */
  // The stage whose request runs, until its status read-back is done too: an answered item read whose read-back still
  // runs is still the item stage at work, not the next stage (its fields are already shown).
  const [runningAt, setRunningAt] = useState<'item' | 'open' | null>(null);
  const runAt = <T,>(at: 'item' | 'open', fn: () => Promise<T>) => {
    // Only the open (keystore or manifest unlock) installs a key; the item read and the manifest lookup do not.
    // Bound to the attempt like its error: a failure from an earlier signer connection or payer way marks nothing.
    const conn = g.connection();
    const gen = g.modeEpoch();
    setRunningAt(at);
    return a.run(async () => {
      try {
        return await fn();
      } catch (e) {
        if (conn === g.connection() && gen === g.modeEpoch()) g.setKeystoreFailedAt(at);
        throw e;
      }
    }, at === 'open').finally(() => setRunningAt((r) => (r === at ? null : r)));
  };
  /** A changed input starts that part over: the failure of an earlier attempt is not this one's. */
  const clearFailure = () => {
    a.clear();
    g.setKeystoreFailedAt(null);
    g.setConfirmErr(null);
  };
  /** Marks a read (the item, or the manifest wallet) as with the signer until it answers, in the payer state. */
  const readingAs = <T,>(kind: 'item' | 'find', fn: () => Promise<T>) => {
    const at = g.connection();
    const ep = g.modeEpoch();
    g.setKeystoreReading(kind);
    return fn().finally(() => at === g.connection() && ep === g.modeEpoch() && g.setKeystoreReading(null));
  };
  // A new source, item or file starts over: nothing chosen for another one carries into it.
  const setFrom = (f: KsFrom) => {
    pickGen.current++;
    clearFailure();
    setFromState(f);
    setFields(null);
    setPathField('');
    setPwField('');
    setFile(null);
    setFileErr(null);
  };
  const label = (f: { label: string; section: string | null }) => `${f.section ? `${f.section} / ` : ''}${f.label}`;
  // The path field's hint speaks of paths only: a field not holding a path is still choosable, never "not a key".
  const pathShape = (s: string) => t(s === 'file-path' || s === 'empty' ? (`gas.ks.pathShape.${s}` as MsgKey) : 'gas.ks.pathShape.other');
  const ready = !!fields && !!pwField && (from === 'field' ? !!pathField && pathField !== pwField : from === 'file' ? !!file : true);
  // Reading the item waits on 1Password like an open does, but at the item stage: tracked apart from the open.
  const inspect = () => void runAt('item', async () => setFields((await readingAs('item', () => signerApi<{ fields: typeof fields }>('/gas/op/inspect', { link: link.trim() }))).fields));
  const editLink = (v: string) => {
    setLink(v);
    clearFailure();
    setFields(null);
    setPathField('');
    setPwField('');
  };
  const pick = async (f: File | undefined) => {
    const gen = ++pickGen.current;
    setFile(null);
    setFileErr(null);
    if (!f) return;
    if (f.size > 16 * 1024) return setFileErr('gas.err.keystore-size');
    let text: string;
    try {
      text = await f.text();
    } catch {
      if (gen === pickGen.current) setFileErr('gas.err.keystore-format');
      return;
    }
    if (gen === pickGen.current) setFile({ name: f.name, size: f.size, text, file: f });
  };
  const open = () => {
    setOpening(true);
    // A new open starts over: a refused confirmation of the earlier key is not this attempt's.
    g.setConfirmErr(null);
    const source = from === 'field' ? { kind: 'field', field: pathField } : { kind: 'file', name: file!.name, keystore: file!.text };
    const picked = from === 'file' ? file!.file : null;
    const attempt = g.startPickedOpen();
    const at = g.connection();
    const ep = g.modeEpoch();
    // The picked file is bound to the unlock this request made (its keyId), so only this page re-checks it — unless
    // a newer attempt or a mode change came first (a late reply then binds nothing).
    void runAt('open', async () => {
        const r = await asking(() => signerApi<NativeStatus>('/gas/keystore/unlock', { link: link.trim(), passwordField: pwField, source }));
        g.keepPickedKeystore(attempt, picked, r.keyId);
        return r;
      })
      // Another signer meanwhile: the opening flag is already its own (cleared, or a newer opening) — left as is.
      .finally(() => at === g.connection() && ep === g.modeEpoch() && setOpening(false));
  };
  const n = g.native;
  const opened = !!n?.unlocked && (n.source?.kind === 'manifest' || n.source?.kind === 'keystore');
  const read = from === 'manifest' ? !!wallet && !!fields : !!fields;
  const reading = g.keystoreReading === 'item';
  // Only the item read and the unlock request wait on the 1Password app, and only until the signer answers; finding
  // the manifest wallet, the status read-back after an answer and a confirmation are "working", never "approve in
  // 1Password" (PM-01b). The unlock flag lives in the payer state, so a reopened sheet still knows.
  const waitsOn1P = g.keystoreAsking || reading;
  // A failed item read (or manifest lookup) puts the ledger back on that stage, even when fields from an earlier read remain.
  const itemFailed = !busy && !!a.err && g.keystoreFailedAt === 'item';
  // A refused confirmation after which the signer dropped the key (say the keystore changed) is the confirm stage
  // failing, not the user's turn at an earlier one.
  const confirmDropped = !opened && !busy && !!g.confirmErr;
  const stage: Stage = opened ? (n.confirmed ? 'complete' : 'confirm') : busy && opening ? 'open' : busy && runningAt === 'item' ? 'item' : confirmDropped ? 'confirm' : reading ? 'item' : itemFailed ? 'item' : read ? (ready ? 'open' : 'fields') : 'item';
  return (
    <>
      {/* A failed address confirmation (held by NativeConfirm) fails the confirm stage too. */}
      <KeystoreStages from={from} stage={stage} activity={{ waiting: waitsOn1P, working: (busy || (opened && g.confirming !== null && g.confirming === (n.keyId ?? n.address))) && !waitsOn1P && !g.signerQueued, queued: g.signerQueued, failed: (!!a.err && g.keystoreFailedAt === stage) || ((opened || confirmDropped) && !!g.confirmErr) }} />
      <NativeConfirm g={g} kind={['manifest', 'keystore']} onReady={onReady}>
      <section data-testid="gas-native-keystore">
        <details className="lb-tech">
          <summary>{t('gas.ks.tech')}</summary>
          <p className="lb-help">{t('gas.ks.help')}</p>
        </details>
        <fieldset className="lb-choice lb-choice-compact" disabled={busy}>
          <legend>{t('gas.ks.from')}</legend>
          {(['manifest', 'field', 'file'] as const).map((f) => (
            <OptionRow
              key={f}
              name={ids.from}
              value={f}
              checked={from === f}
              disabled={f === 'manifest' && !hasManifest}
              onChange={() => setFrom(f)}
              testId={`gas-ks-from-${f}`}
              title={t(`gas.ks.from.${f}` as MsgKey)}
              line={t(`gas.ks.from.${f}.help` as MsgKey)}
            />
          ))}
        </fieldset>
        {from === 'manifest' && (
          <>
            <button type="button" className="lb-btn lb-btn-quiet" disabled={busy} onClick={() => void runAt('item', async () => setWallet(await readingAs('find', () => signerApi<{ address: string; keystore: string }>('/gas/manifest/status'))))} data-testid="gas-ks-find">
              {t('gas.ks.find')}
            </button>
            {wallet && (
              <>
                <div className="lb-confirm" data-testid="gas-ks-wallet">
                  <p>{t('gas.ks.wallet')}</p>
                  <AddressDisplay value={wallet.address} testId="gas-ks-address" />
                  <p className="lb-help" data-testid="gas-ks-file">
                    {t('gas.ks.file', { file: wallet.keystore })}
                  </p>
                </div>
                <Field id={ids.link} label={t('gas.ks.link')} help={t('gas.ks.linkHelp')}>
                  <input id={ids.link} type="text" spellCheck={false} autoComplete="off" value={link} disabled={busy} onChange={(e) => editLink(e.target.value)} data-testid="gas-ks-link" />
                </Field>
                <button type="button" className="lb-btn lb-btn-quiet" disabled={busy || !link.trim()} onClick={inspect} data-testid="gas-ks-inspect">
                  {busy && !fields ? t('gas.op.reading') : t('gas.op.inspect')}
                </button>
                {fields && (
                  // The password field is chosen by the user here too, as for the other sources: none is picked for them.
                  <Field id={ids.pwf} label={t('gas.ks.passwordField')} help={t('gas.ks.passwordFieldHelp')}>
                    <select id={ids.pwf} value={pwField} disabled={busy} onChange={(e) => setPwField(e.target.value)} data-testid="gas-ks-password-field">
                      <option value="">{t('gas.op.fieldChoose')}</option>
                      {fields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {label(f)}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <button
                  type="button"
                  className="lb-btn"
                  disabled={busy || !link.trim() || !ready}
                  onClick={() => {
                    setOpening(true);
                    const at = g.connection();
                    const ep = g.modeEpoch();
                    const gen = g.modeEpoch();
                    void runAt('open', () => asking(() => signerApi('/gas/manifest/unlock', { link: link.trim(), passwordField: pwField, confirmAddress: wallet.address })))
                      .then((r) => r && g.modeEpoch() === gen && g.nativeReadyAs('native-keystore') && onReady?.())
                      .finally(() => at === g.connection() && ep === g.modeEpoch() && setOpening(false));
                  }}
                  data-testid="gas-ks-unlock"
                >
                  {busy && opening ? t(g.signerQueued ? 'gas.queued.button' : 'gas.unlocking') : t('gas.ks.useThis')}
                </button>
              </>
            )}
          </>
        )}
        {from !== 'manifest' && (
          <>
            <Field id={ids.item} label={t('gas.ks.itemLink')} help={t('gas.ks.linkHelp')}>
              <input
                id={ids.item}
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={link}
                disabled={busy}
                onChange={(e) => editLink(e.target.value)}
                data-testid="gas-ks-item-link"
              />
            </Field>
            {from === 'file' && (
              <Field id={ids.pick} label={t('gas.ks.pick')} help={t('gas.ks.pickHelp', { signer: signerOrigin() ?? '127.0.0.1' })}>
                <input id={ids.pick} type="file" disabled={busy} onChange={(e) => void pick(e.target.files?.[0])} data-testid="gas-ks-pick" />
              </Field>
            )}
            {file && (
              <p className="lb-help" data-testid="gas-ks-picked">
                {t('gas.ks.picked', { name: file.name, size: String(file.size) })}
              </p>
            )}
            {fileErr && <Notice tone="bad" testId="gas-ks-pick-error">{t(fileErr)}</Notice>}
            <button type="button" className="lb-btn lb-btn-quiet" disabled={busy || !link.trim()} onClick={inspect} data-testid="gas-ks-inspect">
              {busy && !fields ? t('gas.op.reading') : t('gas.op.inspect')}
            </button>
            {fields && (
              <>
                {from === 'field' && (
                  // Every field can be picked; the name and shape are hints. The runner reads the value on unlock.
                  <Field id={ids.path} label={t('gas.ks.pathField')} help={t('gas.ks.pathFieldHelp')}>
                    <select id={ids.path} value={pathField} disabled={busy} onChange={(e) => setPathField(e.target.value)} data-testid="gas-ks-path-field">
                      <option value="">{t('gas.op.fieldChoose')}</option>
                      {fields.map((f) => (
                        <option key={f.id} value={f.id}>
                          {label(f)} ({pathShape(f.shape)})
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field id={ids.pwf} label={t('gas.ks.passwordField')} help={t('gas.ks.passwordFieldHelp')}>
                  <select id={ids.pwf} value={pwField} disabled={busy} onChange={(e) => setPwField(e.target.value)} data-testid="gas-ks-password-field">
                    <option value="">{t('gas.op.fieldChoose')}</option>
                    {fields
                      .filter((f) => from !== 'field' || f.id !== pathField)
                      .map((f) => (
                        <option key={f.id} value={f.id}>
                          {label(f)}
                        </option>
                      ))}
                  </select>
                </Field>
                <button type="button" className="lb-btn" disabled={busy || !ready} onClick={open} data-testid="gas-ks-open">
                  {busy && opening ? t(g.signerQueued ? 'gas.queued.button' : 'gas.unlocking') : t('gas.ks.open')}
                </button>
              </>
            )}
          </>
        )}
        {busy && !waitsOn1P && !g.signerQueued && (
          <p role="status" className="lb-help" data-testid="gas-ks-working">
            {t(g.keystoreReading === 'find' ? 'gas.ks.finding' : 'gas.ks.readback')}
          </p>
        )}
        {waitsOn1P && (
          // Same as the 1Password mode: stopping ends the waiting op in the signer; what was chosen stays for a retry.
          <div role="status" className="lb-help" data-testid="gas-ks-waiting">
            <p>{t('gas.op.waiting')}</p>
            <button type="button" className="lb-btn lb-btn-quiet" onClick={() => void signerApi('/gas/lock').catch(() => undefined)} data-testid="gas-ks-stop">
              {t('gas.op.stop')}
            </button>
          </div>
        )}
        <ErrorLine err={a.err} />
      </section>
      </NativeConfirm>
    </>
  );
}

function NativeFileMode({ g, native, onReady }: { g: GasPayerState; native: string; onReady?: (() => void) | undefined }) {
  const { t } = useT();
  const ids = { file: useId(), pw: useId(), npw: useId(), rep: useId() };
  const a = useNativeAction(g);
  // Locked while this form's action runs, and while a read-back is still running for one started before the sheet was reopened.
  const busy = a.busy || g.readingBack;
  const [list, setList] = useState<{ dir: string; files: Array<{ file: string; address: string }> } | null>(null);
  const [file, setFile] = useState('');
  const [pw, setPw] = useState('');
  const [npw, setNpw] = useState('');
  const [rep, setRep] = useState('');
  return (
    <NativeConfirm g={g} kind={["file"]} onReady={onReady}>
      <section data-testid="gas-native-file">
        <p className="lb-help">{t('gas.nfile.help')}</p>
        <button type="button" className="lb-btn lb-btn-quiet" disabled={busy} onClick={() => void a.run(async () => setList(await signerApi('/gas/file/list')))} data-testid="gas-nfile-list">
          {t('gas.nfile.list')}
        </button>
        {list && (
          <>
            <p className="lb-help" data-testid="gas-nfile-dir">
              {t('gas.nfile.dir', { dir: list.dir })}
            </p>
            {list.files.length === 0 ? (
              <p>{t('gas.nfile.empty')}</p>
            ) : (
              <>
                <Field id={ids.file} label={t('gas.nfile.pick')}>
                  <select id={ids.file} value={file} onChange={(e) => setFile(e.target.value)} data-testid="gas-nfile-pick">
                    <option value="">{t('gas.op.fieldChoose')}</option>
                    {list.files.map((f) => (
                      <option key={f.file} value={f.file}>
                        {f.address}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field id={ids.pw} label={t('gas.file.password')}>
                  <input id={ids.pw} type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} data-testid="gas-nfile-password" />
                </Field>
                <button
                  type="button"
                  className="lb-btn"
                  disabled={busy || !file || !pw}
                  onClick={() =>
                    void a.run(async () => {
                      const p = pw;
                      setPw('');
                      return signerApi('/gas/file/unlock', { file, password: p });
                    }, true)
                  }
                  data-testid="gas-nfile-unlock"
                >
                  {busy ? t(g.signerQueued ? 'gas.queued.button' : 'gas.unlocking') : t('gas.file.openButton')}
                </button>
              </>
            )}
            <h3>{t('gas.file.create')}</h3>
            <Notice tone="warn" testId="gas-nfile-risk">{t('gas.file.risk', { native })}</Notice>
            <Field id={ids.npw} label={t('gas.file.newPassword')}>
              <input id={ids.npw} type="password" autoComplete="new-password" value={npw} onChange={(e) => setNpw(e.target.value)} data-testid="gas-nfile-new-password" />
            </Field>
            <Field id={ids.rep} label={t('gas.file.repeat')}>
              <input id={ids.rep} type="password" autoComplete="new-password" value={rep} onChange={(e) => setRep(e.target.value)} data-testid="gas-nfile-repeat" />
            </Field>
            <button
              type="button"
              className="lb-btn lb-btn-quiet"
              disabled={busy || !npw || npw !== rep}
              onClick={() =>
                void a.run(async () => {
                  const [p, r] = [npw, rep];
                  setNpw('');
                  setRep('');
                  return signerApi('/gas/file/create', { password: p, repeat: r });
                }, true)
              }
              data-testid="gas-nfile-create"
            >
              {t('gas.nfile.createButton')}
            </button>
          </>
        )}
        <ErrorLine err={a.err} />
      </section>
    </NativeConfirm>
  );
}
