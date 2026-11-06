// Financial confirmation components (design guidelines §8) and the sheet they confirm in. A sheet is a
// native <dialog> opened with showModal(): focus moves in, Esc closes, the page behind is inert.
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { addressGroups, addressLabel, fixed, shortAddress } from './format';
import { useT } from './i18n';

/** Full checksummed address in 4-character groups; read aloud group by group. */
export function AddressDisplay({ value, testId }: { value: string; testId?: string }) {
  return (
    <span className="lb-addr" data-testid={testId} data-value={value}>
      {/* Screen readers get the address group by group; the visual groups are hidden from them. */}
      <span className="lb-sr">{addressLabel(value)}</span>
      <span aria-hidden="true">
        <span className="lb-addr-0x">0x</span>
        {addressGroups(value).map((g, i) => (
          <span key={i} className="lb-addr-g">
            {g}
          </span>
        ))}
      </span>
    </span>
  );
}

/** Short form outside confirmations; the full value is one click away (title + copy). */
export function AddressShort({ value }: { value: string }) {
  return (
    <code className="lb-mono" title={value}>
      <span className="lb-sr">{addressLabel(value)}</span>
      <span aria-hidden="true">{shortAddress(value)}</span>
    </code>
  );
}

/** Exact amount, every decimal of the asset, unit right after the number. */
export function AmountDisplay({ units, decimals, symbol, big, testId }: { units: string | bigint; decimals: number; symbol: string; big?: boolean; testId?: string }) {
  return (
    <span className={big ? 'lb-amount lb-amount-big' : 'lb-amount'} data-testid={testId}>
      <span className="lb-mono">{fixed(units, decimals)}</span> <span className="lb-unit">{symbol}</span>
    </span>
  );
}

/** ✓ / ✗ / ○ plus a word: state is never colour alone. */
export function Mark({ ok, pending }: { ok: boolean; pending?: boolean }) {
  return (
    <span className={`lb-mark ${pending ? 'lb-tone-idle' : ok ? 'lb-tone-ok' : 'lb-tone-bad'}`} aria-hidden="true">
      {pending ? '○' : ok ? '✓' : '✗'}
    </span>
  );
}

export function Sheet({ open, onClose, title, children, testId, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; testId?: string; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const { t } = useT();
  // Closes this component asked for itself: each d.close() queues one native close event for later.
  const ownCloses = useRef(0);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) {
      ownCloses.current += 1;
      d.close();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={wide ? 'lb-sheet lb-sheet-wide' : 'lb-sheet'}
      aria-labelledby={id}
      // Escape: close through state, synchronously. The native close event is queued for later, so a
      // press on the opener before it arrived would see the sheet still "open" and do nothing.
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      // The native close event of our own d.close() arrives one task later — by then this sheet or
      // another may already be open again, and reporting it would shut that one. Only a close this
      // component did not ask for is reported.
      onClose={() => {
        if (ownCloses.current > 0) ownCloses.current -= 1;
        else onClose();
      }}
      data-testid={testId}
    >
      {open && (
        <>
          <div className="lb-sheet-head">
            <h2 id={id}>{title}</h2>
            <button type="button" className="lb-btn lb-btn-quiet" onClick={onClose} data-testid={testId ? `${testId}-close` : undefined}>
              {t('sheet.close')}
            </button>
          </div>
          <div className="lb-sheet-body">{children}</div>
        </>
      )}
    </dialog>
  );
}

/** False while the tool stays mounted behind another page (/recover not showing): a sheet a step opened
 * for itself closes then, as the toolbar's do; what the step holds stays. */
export const ToolShowing = createContext(true);

/**
 * The one buoy button on a screen: its label is the action itself. Pressing it opens a sheet that
 * restates what will happen; the final button there needs the typed amount (or, for a deploy step,
 * nothing more than the press — the wallet shows the transaction too).
 */
export function IrreversibleButton({
  label,
  title,
  disabled,
  confirmWord,
  confirmLabel,
  onConfirm,
  children,
  testId,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  /** When set, the user must type exactly this before the sheet's button works. */
  confirmWord?: string;
  confirmLabel: string;
  onConfirm: () => void;
  children: ReactNode;
  testId: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const showing = useContext(ToolShowing);
  useEffect(() => {
    if (!showing) setOpen(false);
  }, [showing]);
  const inputId = useId();
  const ok = !confirmWord || typed.trim() === confirmWord;
  return (
    <>
      <button type="button" className="lb-btn lb-btn-buoy" disabled={disabled} onClick={() => (setTyped(''), setOpen(true))} data-testid={testId}>
        {label}
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={title} testId={`${testId}-sheet`}>
        {children}
        {confirmWord && (
          <p className="lb-field">
            <label htmlFor={inputId}>{t('send.typeAmount', { amount: confirmWord })}</label>
            <input id={inputId} className="lb-input lb-mono" autoComplete="off" spellCheck={false} inputMode="decimal" value={typed} onChange={(e) => setTyped(e.target.value)} data-testid={`${testId}-typed`} />
          </p>
        )}
        <div className="lb-actions">
          <button type="button" className="lb-btn lb-btn-quiet" onClick={() => setOpen(false)}>
            {t('send.cancel')}
          </button>
          <button
            type="button"
            className="lb-btn lb-btn-buoy"
            disabled={!ok || disabled}
            data-testid={`${testId}-confirm`}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </Sheet>
    </>
  );
}

/** Polite status line; failures are assertive (guidelines §9). */
export function Notice({ tone, children, testId }: { tone: 'ok' | 'bad' | 'warn' | 'idle'; children: ReactNode; testId?: string }) {
  return (
    <p className={`lb-notice lb-tone-${tone}`} role={tone === 'bad' ? 'alert' : 'status'} data-testid={testId}>
      {children}
    </p>
  );
}

export function Field({ label, help, children, id }: { label: string; help?: string | undefined; children: ReactNode; id: string }) {
  return (
    <div className="lb-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {help && (
        <p className="lb-help" id={`${id}-help`}>
          {help}
        </p>
      )}
    </div>
  );
}
