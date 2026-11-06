// The default Passkey path (no extension, no DevTools): save the bookmarklet once, open keys.coinbase.com,
// click it, paste the request code. The link's href is set through the DOM because React refuses
// javascript: URLs; clicking it here does nothing (this page's CSP blocks inline script) — it is meant to
// be dragged to the bookmarks bar. Its SHA-256 is shown so a saved copy can be checked against this build.
import { useEffect, useRef } from 'react';
import { BOOKMARKLET_SHA256, BOOKMARKLET_URL, requestCode } from '../webauthn/bookmarklet';
import type { AssertionKind } from '../webauthn/assertion';
import { useT } from './i18n';
import { ManualCopy, useCopy } from './ux';

export function BookmarkletSigner({ kind, challenge, entryUrl, testId }: { kind: AssertionKind; challenge: Uint8Array; entryUrl: string; testId: string }) {
  const { t } = useT();
  const link = useRef<HTMLAnchorElement>(null);
  const code = requestCode(challenge, kind);
  useEffect(() => {
    link.current?.setAttribute('href', BOOKMARKLET_URL);
  }, []);
  // A new request (the next transfer, a review again) is a new code: an earlier "copied" is not this one's.
  const c = useCopy<'code' | 'bookmark'>(code);
  return (
    <section className="lb-bridge" data-testid={testId}>
      <h4>{t('bm.title')}</h4>
      <ol className="lb-howto">
        <li>
          {t('bm.step1')}{' '}
          <a ref={link} className="lb-btn lb-btn-quiet" draggable onClick={(e) => e.preventDefault()} data-testid={`${testId}-link`}>
            {t('bm.linkLabel')}
          </a>{' '}
          <button type="button" className="lb-btn lb-btn-link" onClick={() => c.copy(BOOKMARKLET_URL, 'bookmark')} data-testid={`${testId}-copy-bookmark`}>
            {t('bm.copyBookmark')}
          </button>
        </li>
        <li>{t('bm.step2', { url: entryUrl })}</li>
        <li>
          {t('bm.step3')}{' '}
          <code className="lb-code lb-break" data-testid={`${testId}-code`}>
            {code}
          </code>{' '}
          <button type="button" className="lb-btn lb-btn-quiet" onClick={() => c.copy(code, 'code')} data-testid={`${testId}-copy-code`}>
            {t('bm.copyCode')}
          </button>
        </li>
        <li>{t('bm.step4')}</li>
      </ol>
      {c.status !== 'idle' && (
        <p className={`lb-help${c.status === 'failed' ? ' lb-tone-bad' : ''}`} role="status" data-testid={`${testId}-copy-status`} data-copy={c.status} data-what={c.what ?? ''}>
          {t(c.status === 'failed' ? 'bm.copyFailed' : c.what === 'code' ? 'bm.copiedCode' : 'bm.copiedBookmark')}
        </p>
      )}
      {c.status === 'failed' && c.text && <ManualCopy text={c.text} testId={`${testId}-manual`} />}
      <p className="lb-help lb-mono lb-break" data-testid={`${testId}-sha256`}>
        {t('bm.hash', { hash: BOOKMARKLET_SHA256 })}
      </p>
      <p className="lb-help">{t('bm.note')}</p>
    </section>
  );
}
