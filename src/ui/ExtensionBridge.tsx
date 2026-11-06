// "Sign through the extension" (ADR-002): no Console, no paste. The received assertion goes straight to
// the caller (React state only) and is checked exactly like a pasted one.
import { useEffect, useRef, useState } from 'react';
import { BRIDGE_APP_ORIGIN, chromeSend, requestAssertion, type Send } from '../bridge/client';
import { SUPPORTED } from '../config/registry';
import type { AssertionKind } from '../webauthn/assertion';
import { useT } from './i18n';

const RP_ENTRY_URL = SUPPORTED[0]!.rp.entryUrl;

type State = { s: 'idle' } | { s: 'waiting'; code: string | null } | { s: 'received' } | { s: 'error'; message: string };

export function ExtensionBridge({ kind, challenge, onAssertion, send }: { kind: AssertionKind; challenge: Uint8Array; onAssertion: (json: string) => void; send?: Send | null }) {
  const { t } = useT();
  const [state, setState] = useState<State>({ s: 'idle' });
  const abort = useRef<AbortController | null>(null);
  const transport = send === undefined ? chromeSend() : send;

  // A new challenge (or leaving the panel) ends any request in flight for the old one.
  useEffect(() => {
    setState({ s: 'idle' });
    return () => abort.current?.abort();
  }, [challenge]);

  const start = async () => {
    if (!transport) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setState({ s: 'waiting', code: null });
    try {
      const json = await requestAssertion({ kind, challenge, send: transport, signal: ac.signal, onCode: (code) => !ac.signal.aborted && setState({ s: 'waiting', code }) });
      if (ac.signal.aborted) return;
      onAssertion(json);
      setState({ s: 'received' });
    } catch (e) {
      if (!ac.signal.aborted) setState({ s: 'error', message: e instanceof Error ? e.message : 'unknown error' });
    }
  };

  return (
    <section className="lb-bridge" data-testid="bridge" data-state={state.s}>
      <h4>{t('bridge.title')}</h4>
      {!transport ? (
        <p className="lb-help" data-testid="bridge-unavailable">
          {t('bridge.unavailable', { origin: BRIDGE_APP_ORIGIN })}
        </p>
      ) : (
        <>
          <ol className="lb-howto">
            <li>{t('bridge.step1')}</li>
            <li>{t('bridge.step2', { url: RP_ENTRY_URL })}</li>
            <li>{t('bridge.step3')}</li>
          </ol>
          <div className="lb-actions">
            <button type="button" className="lb-btn" data-testid="bridge-start" onClick={() => void start()} disabled={state.s === 'waiting'}>
              {state.s === 'waiting' ? t('bridge.waiting') : t('bridge.start')}
            </button>
            {state.s === 'waiting' && (
              <button
                type="button"
                className="lb-btn lb-btn-quiet"
                data-testid="bridge-stop"
                onClick={() => {
                  abort.current?.abort();
                  setState({ s: 'idle' });
                }}
              >
                {t('bridge.stop')}
              </button>
            )}
          </div>
          {state.s === 'waiting' && state.code && (
            <p>
              {t('bridge.codeLabel')} <b className="lb-code" data-testid="bridge-code">{state.code}</b> ({t('bridge.codeNote')})
            </p>
          )}
          {state.s === 'received' && <p data-testid="bridge-received">{t('bridge.received')}</p>}
          {state.s === 'error' && (
            <p className="lb-tone-bad" role="alert" data-testid="bridge-error">
              {t('bridge.error', { reason: state.message })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
