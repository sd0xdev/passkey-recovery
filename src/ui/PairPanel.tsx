// Hosted website ↔ local runner pairing (HOST-05/06). The user starts the runner (npm run runner in a built
// clone of the source); it prints a short pairing code. One press of Connect first asks the runner who it is
// (protocol, version) and then exchanges the code for a short session held in memory only. Nothing is
// paired automatically, nothing is scanned: only the one http://127.0.0.1:<port> address is asked, and
// only when the user presses Connect.
import { useId, useState } from 'react';
import { pairableOrigin, sourceRunnerCommand } from '../config/release';
import { PATH } from './site/routes';
import { ApiError, hello, pair, pairedRunner, runnerBase, RUNNER_PROTOCOL, unpair } from './api';
import { useT } from './i18n';
import { Field, Notice } from './primitives';
import { BusyLine, CopyButton } from './ux';

export const DEFAULT_RUNNER = 'http://127.0.0.1:4171/';
/** The full local preview: the runner's own page on its default port. */
export const LOCAL_PREVIEW = `${DEFAULT_RUNNER}recover`;
const CODE = /^[A-Za-z0-9]{4}-?[A-Za-z0-9]{4}$/;

/** The code the user typed, normalised to ABCD-EFGH; null when it is not one. */
export function pairingCode(raw: string): string | null {
  const c = raw.trim().toUpperCase();
  if (!CODE.test(c)) return null;
  return c.includes('-') ? c : `${c.slice(0, 4)}-${c.slice(4)}`;
}

export function PairPanel({ onPaired }: { onPaired?: () => void }) {
  const { t } = useT();
  const ids = { url: useId(), code: useId() };
  const [url, setUrl] = useState(DEFAULT_RUNNER);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [, force] = useState(0);
  const paired = pairedRunner();
  // Only an https page is a pairable origin; on http (a local preview) the command leaves --allow-origin out
  // instead of offering one the runner would refuse.
  const origin = pairableOrigin(location.origin);
  const command = sourceRunnerCommand(origin);
  const normal = pairingCode(code);
  let base: string | null = null;
  try {
    base = runnerBase(url);
  } catch {
    base = null;
  }

  const why = (e: unknown, at: string) => {
    if (e instanceof ApiError) {
      if (e.kind === 'offline') return t('pair.err.offlineAt', { base: at });
      if (e.status === 403) return t('pair.err.wrongCode');
      if (e.status === 410) return t('pair.err.used');
      return e.message;
    }
    return e instanceof Error ? e.message : String(e);
  };

  // One press: who is there (protocol), then the code. A runner of another protocol is never paired.
  const connect = async () => {
    if (!normal) return setErr(t('pair.badCode'));
    if (!base) return setErr(t('pair.badUrl'));
    setBusy(true);
    setErr(null);
    try {
      const h = await hello(base);
      if (h.protocol !== RUNNER_PROTOCOL) throw new Error(t('pair.err.protocol', { theirs: h.protocol, ours: RUNNER_PROTOCOL }));
      await pair(base, normal);
      setCode('');
      force((x) => x + 1);
      onPaired?.();
    } catch (e) {
      setErr(why(e, base));
    } finally {
      setBusy(false);
    }
  };

  if (paired)
    return (
      <div data-testid="pair-panel">
        <Notice tone="ok" testId="pair-ok">
          {t('pair.paired', { base: paired.base, version: paired.version, mode: paired.mode })}
        </Notice>
        <p className="lb-help">{t('pair.pairedHelp')}</p>
        <button
          type="button"
          className="lb-btn lb-btn-quiet"
          onClick={() => {
            unpair();
            force((x) => x + 1);
          }}
          data-testid="pair-disconnect"
        >
          {t('pair.disconnect')}
        </button>
      </div>
    );
  return (
    <form
      data-testid="pair-panel"
      className="lb-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void connect();
      }}
    >
      <p className="lb-lead">{t('pair.lead')}</p>
      <ol className="lb-howto lb-pair-steps">
        <li>
          {t('pair.step1')} <a href={PATH.download} data-testid="pair-steps-link">{t('pair.step1.link')}</a>
          <pre className="lb-code-block" tabIndex={0} data-testid="pair-command">
            {command}
          </pre>
          <CopyButton text={command} label={t('pair.copy')} done={t('pair.copied')} testId="pair-copy" />
          {!origin && (
            <p className="lb-help" data-testid="pair-http">
              {t('pair.httpOrigin', { url: LOCAL_PREVIEW })}
            </p>
          )}
        </li>
        <li>{t('pair.step2')}</li>
        <li>{t('pair.step3')}</li>
      </ol>
      <p className="lb-help" data-testid="pair-prereq">{t('pair.prereq')}</p>
      <p className="lb-help">{t('pair.lna')}</p>
      <Field id={ids.code} label={t('pair.codeLine')} help={t('pair.codeLineHelp')}>
        <input id={ids.code} className="lb-input lb-mono lb-input-short" type="text" autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="ABCD-1234" value={code} onChange={(e) => setCode(e.target.value)} aria-describedby={`${ids.code}-help`} data-testid="pair-code" />
      </Field>
      <details className="lb-details" data-testid="pair-advanced">
        <summary>{t('pair.otherPort')}</summary>
        <Field id={ids.url} label={t('pair.url')}>
          <input id={ids.url} type="url" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} data-testid="pair-url" />
        </Field>
      </details>
      {busy && base && <BusyLine testId="pair-busy">{t('pair.connecting', { base })}</BusyLine>}
      {err && <Notice tone="bad" testId="pair-error">{err}</Notice>}
      <div className="lb-actions">
        <button type="submit" className="lb-btn" disabled={busy || !code.trim()} data-testid="pair-submit">
          {t('pair.connect')}
        </button>
      </div>
    </form>
  );
}
