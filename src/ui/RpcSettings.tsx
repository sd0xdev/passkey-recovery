// RPC settings (open-source spec §3.3, M1; design guidelines §5, §7, §9, §10). The custom URL is held in
// this component's state only until the sidecar accepts it, then dropped: the browser never stores,
// logs or puts it in the address bar. Every value shown back comes from the sidecar's masked form.
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, api, hasConnection, onConnectionChange } from './api';
import { MESSAGES, useT, type MsgKey } from './i18n';

const CAP_DETAIL_KEYS = new Set(Object.keys(MESSAGES.en).filter((k) => k.startsWith('capd.')));

/** The capability's detail in the page language; an unknown code (a newer runner) falls back to its English text. */
export function capDetail(t: (k: MsgKey, v?: Record<string, string | number>) => string, cap: Cap): string {
  const key = `capd.${cap.code ?? ''}` as MsgKey;
  return cap.code && CAP_DETAIL_KEYS.has(key) ? t(key, cap.vars ?? {}) : cap.detail;
}

type CapStatus = 'ok' | 'unsupported' | 'error' | 'skipped' | 'not-probed';
interface Cap {
  status: CapStatus;
  detail: string;
  code?: string;
  vars?: Record<string, string | number>;
}
interface Report {
  at: string;
  masked: string;
  head: { block: string; ageSec: number } | null;
  chain: Cap;
  read: Cap;
  consistency: Cap;
  estimate: Cap;
  stateOverride: Cap;
  fork: Cap;
  archive: Cap;
  broadcast: Cap;
  rateLimited: number;
  simulationReady: boolean;
}
export interface RpcState {
  epoch: number;
  active: 'base' | 'custom';
  upstream: { provider: string; source: 'default' | 'file' | 'testchain' | 'custom'; masked: string; localException: boolean };
  capabilities: Report | null;
  rateLimited: number;
  localExceptionPhrase: string;
}

const CAPS = ['chain', 'read', 'consistency', 'estimate', 'stateOverride', 'fork', 'archive', 'broadcast'] as const;
/** Shape + word, never colour alone (guidelines §9). */
const GLYPH: Record<CapStatus, string> = { ok: '✓', unsupported: '✗', error: '✗', skipped: '○', 'not-probed': '○' };

function overall(r: Report | null): { key: MsgKey; tone: 'ok' | 'warn' | 'bad' | 'idle' } {
  if (!r) return { key: 'rpc.status.unchecked', tone: 'idle' };
  if (r.simulationReady) return { key: 'rpc.status.ready', tone: 'ok' };
  if (r.chain.status === 'ok' && r.read.status === 'ok') return { key: 'rpc.status.limited', tone: 'warn' };
  return { key: 'rpc.status.failed', tone: 'bad' };
}

function CapabilityLog({ report, caption }: { report: Report; caption: string }) {
  const { t } = useT();
  return (
    <table className="lb-log" data-testid="cap-log">
      <caption>
        {caption}
        {report.head && <span className="lb-note"> {t('rpc.log.at', { block: Number(report.head.block).toLocaleString('en-US'), age: report.head.ageSec })}</span>}
      </caption>
      <tbody>
        {CAPS.map((c) => {
          const cap = report[c];
          return (
            <tr key={c} data-cap={c} data-status={cap.status} className={`lb-row lb-${cap.status}`}>
              <td className="lb-glyph" aria-hidden="true">{GLYPH[cap.status]}</td>
              <th scope="row">{t(`cap.${c}` as MsgKey)}</th>
              <td className="lb-word">{t(`status.${cap.status}` as MsgKey)}</td>
              <td className="lb-detail">{capDetail(t, cap)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** A request that may change the active endpoint: `/api/rpc/probe` (re-check), `/api/rpc/use`, `/api/rpc/clear`. */
export type RpcChange = (path: '/api/rpc/probe' | '/api/rpc/use' | '/api/rpc/clear', body?: Record<string, unknown>) => Promise<RpcState>;

/**
 * The RPC panel body; `onState` reports every endpoint state it loads (the app voids its local plans on an
 * epoch change). Endpoint changes go through `change` when given: the app owns them, so its plans are
 * voided the moment one starts and its answer is applied even if this panel was closed meanwhile.
 */
export function RpcPanel({ onState, change }: { onState?: (s: RpcState) => void; change?: RpcChange }) {
  const { t } = useT();
  // Local page or a paired hosted page: both have a sidecar to ask (HOST-05).
  const [hasSidecar, setHasSidecar] = useState(hasConnection);
  useEffect(() => onConnectionChange(() => setHasSidecar(hasConnection())), []);
  const [state, setState] = useState<RpcState | null>(null);
  const [url, setUrl] = useState('');
  const [local, setLocal] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState<null | 'check' | 'test' | 'use' | 'clear'>(null);
  const [tested, setTested] = useState<Report | null>(null);
  // Stored as a message key so it follows the language toggle; `reason` is the sidecar's own (English) text.
  const [notice, setNotice] = useState<{ tone: 'ok' | 'bad'; key: MsgKey; vars?: Record<string, string> } | null>(null);
  const ids = { url: useId(), local: useId(), phrase: useId(), help: useId() };

  useEffect(() => {
    if (state) onState?.(state);
  }, [state, onState]);

  const load = useCallback(async () => setState(await api<RpcState>('/api/rpc/state')), []);
  const mutate: RpcChange = change ?? ((path, b) => api<RpcState>(path, b));
  useEffect(() => {
    if (hasSidecar) void load().catch(() => setNotice({ tone: 'bad', key: 'rpc.error', vars: { reason: 'sidecar unreachable' } }));
    // t changes with the language only; the endpoint state does not need a reload for it.
  }, [hasSidecar, load]);

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ tone: 'bad', key: 'rpc.error', vars: { reason: e instanceof ApiError ? e.message : 'unexpected error' } });
    } finally {
      setBusy(null);
    }
  };
  const body = () => ({ url, ...(local ? { allowLocal: true, confirm: phrase } : {}) });

  if (!hasSidecar) {
    return <p className="lb-note" data-testid="rpc-no-sidecar">{t('rpc.noSidecar')}</p>;
  }
  if (!state) return <p className="lb-note" aria-live="polite">{t('rpc.loading')}</p>;

  const st = overall(state.capabilities);
  const custom = state.active === 'custom';
  const rateLimited = Math.max(state.rateLimited, state.capabilities?.rateLimited ?? 0);
  const phraseOk = !local || phrase === state.localExceptionPhrase;

  return (
    <>
      {custom && state.upstream.localException && (
        <p className="lb-banner lb-banner-local" role="status" data-testid="local-banner">
          {t('rpc.localBanner', { host: state.upstream.masked })}
        </p>
      )}

      <div className="lb-entry" data-testid="rpc-active" data-active={state.active}>
        <p className={`lb-endpoint lb-tone-${st.tone}`}>
          <span className="lb-glyph" aria-hidden="true">{st.tone === 'ok' ? '✓' : st.tone === 'idle' ? '○' : st.tone === 'warn' ? '◐' : '✗'}</span>
          <span className="lb-host" data-testid="rpc-masked">{state.upstream.masked}</span>
        </p>
        <p className="lb-meta">
          <span>{t('rpc.active', { source: t(`rpc.source.${state.upstream.source}` as MsgKey) })}</span>
          <span className={`lb-state lb-tone-${st.tone}`} data-testid="rpc-overall">{t(st.key)}</span>
        </p>
        <div className="lb-actions">
          <button type="button" className="lb-btn" disabled={!!busy} onClick={() => void run('check', async () => setState(await mutate('/api/rpc/probe')))} data-testid="rpc-check">
            {busy === 'check' ? t('rpc.checking') : t('rpc.check')}
          </button>
          {custom && (
            <button
              type="button"
              className="lb-btn lb-btn-quiet"
              disabled={!!busy}
              data-testid="rpc-clear"
              onClick={() =>
                void run('clear', async () => {
                  setState(await mutate('/api/rpc/clear'));
                  setTested(null);
                  setNotice({ tone: 'ok', key: 'rpc.cleared' });
                })
              }
            >
              {t('rpc.clear')}
            </button>
          )}
        </div>
        {rateLimited > 0 && (
          <p className="lb-banner lb-banner-warn" role="status" data-testid="rpc-busy">
            {t('rpc.busy', { n: rateLimited })}
          </p>
        )}
        {state.capabilities ? <CapabilityLog report={state.capabilities} caption={t('rpc.log.title')} /> : <p className="lb-note">{t('rpc.log.empty')}</p>}
      </div>

      <form
        className="lb-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <h3>{t('rpc.custom.title')}</h3>
        <p className="lb-note">{t('rpc.custom.lead')}</p>
        <label htmlFor={ids.url}>{t('rpc.custom.label')}</label>
        <input
          id={ids.url}
          data-testid="rpc-url"
          type="password"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-describedby={ids.help}
        />
        <p id={ids.help} className="lb-note">
          {t('rpc.custom.session')} {t('rpc.custom.discard')}
        </p>
        <div className="lb-check">
          <input id={ids.local} type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} data-testid="rpc-local" />
          <label htmlFor={ids.local}>{t('rpc.custom.local')}</label>
        </div>
        {local && (
          <div className="lb-exception">
            <p className="lb-note">{t('rpc.custom.localHelp')}</p>
            <label htmlFor={ids.phrase}>{t('rpc.custom.phrase', { phrase: `“${state.localExceptionPhrase}”` })}</label>
            <input id={ids.phrase} data-testid="rpc-phrase" type="text" autoComplete="off" spellCheck={false} value={phrase} onChange={(e) => setPhrase(e.target.value)} />
          </div>
        )}
        <div className="lb-actions">
          <button
            type="button"
            className="lb-btn lb-btn-quiet"
            data-testid="rpc-test"
            disabled={!!busy || !url.trim() || !phraseOk}
            onClick={() => void run('test', async () => setTested(await api<Report>('/api/rpc/test', body())))}
          >
            {busy === 'test' ? t('rpc.testing') : t('rpc.test')}
          </button>
          <button
            type="button"
            className="lb-btn"
            data-testid="rpc-use"
            disabled={!!busy || !url.trim() || !phraseOk}
            onClick={() =>
              void run('use', async () => {
                const s = await mutate('/api/rpc/use', body());
                // Accepted: the browser lets go of the URL; only the masked form remains.
                setUrl('');
                setPhrase('');
                setTested(null);
                setState(s);
                setNotice({ tone: 'ok', key: 'rpc.used', vars: { host: s.upstream.masked } });
              })
            }
          >
            {busy === 'use' ? t('rpc.using') : t('rpc.use')}
          </button>
        </div>
        {tested && <CapabilityLog report={tested} caption={t('rpc.tested', { host: tested.masked })} />}
      </form>

      <p className={`lb-notice lb-tone-${notice?.tone ?? 'idle'}`} aria-live={notice?.tone === 'bad' ? 'assertive' : 'polite'} data-testid="rpc-notice">
        {notice ? t(notice.key, notice.vars) : ''}
      </p>
    </>
  );
}
