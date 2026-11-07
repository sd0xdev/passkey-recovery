// Passkey Recovery by sd0x — the site shell (design guidelines §13.3). Real paths: `/` is the website,
// `/recover` the tool. The site header (brand, pages, language, the tool) is on every page; the tool's own
// toolbar only on /recover. The tool is its own chunk, loaded on the first visit to /recover and then kept
// mounted, hidden, so a step in progress survives reading the guide.
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { pageKind } from './api';
import { LangProvider, useT, type MsgKey } from './i18n';
import { SiteHeader, SitePage, NotFound } from './site/Site';
import { useRoute } from './site/router';
import { REPO_URL } from '../config/release';
import type { Route } from './site/routes';
import '@fontsource/atkinson-hyperlegible-next/400.css';
import '@fontsource/atkinson-hyperlegible-next/700.css';
import '@fontsource/atkinson-hyperlegible-next/800.css';
import '@fontsource/atkinson-hyperlegible-mono/400.css';
import '@fontsource/atkinson-hyperlegible-mono/700.css';
import './logbook.css';
import './site/site.css';

const Tool = lazy(() => import('./Tool'));

/** The tool chunk could not load (offline, or a runner restarted onto a newer build): say so, offer a reload. */
class ToolBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function ToolFailed() {
  const { t } = useT();
  return (
    <div className="lb-notice lb-tone-bad" role="alert" data-testid="tool-failed">
      <p>{t('tool.failed')}</p>
      <button type="button" className="lb-btn" onClick={() => location.reload()}>
        {t('tool.reload')}
      </button>
    </div>
  );
}

export function App() {
  return (
    <LangProvider>
      <Shell />
    </LangProvider>
  );
}

const TITLE: Record<Route, MsgKey> = {
  home: 'title.home',
  recover: 'title.recover',
  guide: 'title.guide',
  how: 'title.how',
  security: 'title.security',
  download: 'title.download',
  notFound: 'title.notFound',
};

function Shell() {
  const { t, lang } = useT();
  const route = useRoute();
  const kind = pageKind();
  // Once the tool has been opened it stays: its state is the user's work in progress.
  const [toolLoaded, setToolLoaded] = useState(route === 'recover');
  useEffect(() => {
    if (route === 'recover') setToolLoaded(true);
  }, [route]);
  useEffect(() => {
    document.title = t(TITLE[route]);
  }, [route, t]);
  const onTool = route === 'recover';
  const skipTo = onTool ? 'current-step' : 'page-title';

  return (
    <div className="lb-app logbook" lang={lang}>
      <a
        className="lb-skip"
        href={`#${skipTo}`}
        onClick={(e) => {
          e.preventDefault();
          (document.getElementById(skipTo) ?? document.getElementById('page-title'))?.focus();
        }}
      >
        {t(onTool ? 'app.skip' : 'site.skip')}
      </a>
      <SiteHeader route={route} />

      {route === 'notFound' ? <NotFound /> : !onTool && <SitePage page={route} kind={kind} />}
      <main className="lb-main lb-tool" hidden={!onTool} data-testid="page-recover">
        <h1 className="lb-title" id={onTool ? 'page-title' : undefined} tabIndex={-1}>
          {t('app.title')}
        </h1>
        <p className="lb-tagline">{t('app.tagline')}</p>
        {toolLoaded && (
          <ToolBoundary fallback={<ToolFailed />}>
          <Suspense
            fallback={
              <p className="lb-help" role="status" data-testid="tool-loading">
                {t('tool.loading')}
              </p>
            }
          >
            <Tool active={onTool} />
          </Suspense>
          </ToolBoundary>
        )}
      </main>

      <footer className="lb-footer">
        <p>{t('footer.unofficial')}</p>
        <p>
          {t('footer.credit')} · <a href="https://github.com/sd0xdev">github.com/sd0xdev</a> · <a href={REPO_URL}>{t('footer.source')}</a> · <a href="https://github.com/sd0xdev/sd0x-harness">{t('footer.harness')}</a> · {t('footer.license')}
        </p>
      </footer>
    </div>
  );
}
