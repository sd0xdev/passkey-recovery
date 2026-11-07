// Website pages that share the tool's build (hosted website and the runner's own page alike), on real paths
// (design guidelines §13.3, routes in ./routes.ts). The site header is on every page; the tool's toolbar only
// on /recover (App.tsx). Home is the mechanism atlas (6-recovery-atlas.md §3, PM revision §10): hero plate and its
// three-step key → is this for you → the real tool on synthetic data, one still at a time → who holds what, once →
// status / questions. Pages that say how to start speak to where they are (pageKind: runner / website / preview).
import { useEffect, useState, type ReactNode } from 'react';
import { CLONE_COMMANDS, RELEASE_PAGE_URL, RELEASE_TAG, REPO_URL, TARBALL, VERSION, runnerCommand, sourceRunnerCommand } from '../../config/release';
import type { PageKind } from '../api';
import { useT, type MsgKey } from '../i18n';
import { CopyButton } from '../ux';
import { PATH, type Page, type Route } from './routes';
import { MasterPlate } from './atlas/MasterPlate';
import { Plate } from './atlas/Plate';
import { Demo } from './atlas/Demo';
import { Boundary } from './atlas/Boundary';
import { TALL } from './atlas/geometry';
import './atlas/atlas.css';

export { PAGES, type Page } from './routes';

const NAV: ReadonlyArray<[Exclude<Page, 'home' | 'recover'>, MsgKey]> = [
  ['guide', 'nav.guide'],
  ['how', 'nav.how'],
  ['security', 'nav.security'],
  ['download', 'nav.download'],
];

export function SiteHeader({ route }: { route: Route }) {
  const { t, lang, setLang } = useT();
  const [open, setOpen] = useState(false);
  const here = (p: Page) => (p === route ? 'page' : undefined);
  useEffect(() => setOpen(false), [route]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <header className="lb-top lb-site-top" data-testid="site-header">
      <a className="lb-brand" href={PATH.home} aria-current={here('home')} data-testid="nav-home">
        <b>{t('site.brand')}</b>
      </a>
      <button type="button" className="lb-chip lb-site-menu-btn" aria-expanded={open} aria-controls="site-menu" onClick={() => setOpen((o) => !o)} data-testid="nav-menu">
        {t('nav.menu')}
      </button>
      <div id="site-menu" className="lb-site-menu" data-open={open}>
        <nav className="lb-site-nav" aria-label={t('nav.label')} data-testid="site-nav">
          {NAV.map(([p, k]) => (
            <a key={p} href={PATH[p]} aria-current={here(p)} data-testid={`nav-${p}`}>
              {t(k)}
            </a>
          ))}
        </nav>
      </div>
      {/* The language stays in the header row at every width (6-recovery-atlas.md §2, 390 row); only the pages fold. */}
      <button type="button" className="lb-chip lb-site-lang" lang={lang === 'en' ? 'zh-Hant-TW' : 'en'} aria-label={`${t('lang.toggle')} — ${t('lang.toggleLabel')}`} onClick={() => setLang(lang === 'en' ? 'zh-Hant-TW' : 'en')} data-testid="lang-toggle">
        {t('lang.toggle')}
      </button>
      <a className="lb-site-open" href={PATH.recover} aria-current={here('recover')} data-testid="nav-recover">
        {t('nav.recover')}
      </a>
    </header>
  );
}

function PageHead({ title, lead }: { title: MsgKey; lead?: ReactNode }) {
  const { t } = useT();
  return (
    <header className="lb-page-head">
      <h1 id="page-title" tabIndex={-1} className="lb-page-title">
        {t(title)}
      </h1>
      {lead && <p className="lb-page-lead">{lead}</p>}
    </header>
  );
}

/** A heading in the left margin (wide screens) beside its text, like a logbook column. */
function Entry({ title, children, id }: { title: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="lb-folio" aria-labelledby={id}>
      <h2 className="lb-folio-head" id={id}>
        {title}
      </h2>
      <div className="lb-folio-body">{children}</div>
    </section>
  );
}

function Command({ text, testId }: { text: string; testId: string }) {
  const { t } = useT();
  return (
    <div className="lb-command">
      <pre className="lb-code-block" tabIndex={0} data-testid={testId}>
        {text}
      </pre>
      <CopyButton text={text} label={t('dl.copy')} done={t('dl.copied')} testId={`${testId}-copy`} />
    </div>
  );
}

function List({ keys, ordered, className }: { keys: MsgKey[]; ordered?: boolean; className?: string }) {
  const { t } = useT();
  const items = keys.map((k) => <li key={k}>{t(k)}</li>);
  return ordered ? <ol className={className}>{items}</ol> : <ul className={className}>{items}</ul>;
}

function Home() {
  const { t } = useT();
  const faq = ['lost', 'keys', 'cost', 'coinbase', 'other', 'stuck'] as const;
  return (
    <>
      <section className="lb-hero lb-chart-hero" aria-labelledby="page-title">
        <div className="lb-hero-copy">
          <h1 id="page-title" tabIndex={-1} className="lb-hero-title lb-display">
            {t('home.title')}
          </h1>
          <p className="lb-hero-sub">{t('home.sub')}</p>
          <div className="lb-hero-actions">
            <a className="lb-btn lb-btn-buoy" href={PATH.recover} data-testid="home-cta-tool">
              {t('home.ctaTool')}
            </a>
            <a className="lb-btn lb-btn-quiet" href="#how-plates" data-testid="home-cta-how">
              {t('home.ctaHow')}
            </a>
          </div>
          <p className="lb-hero-limits" data-testid="home-limits">
            {t('home.limits')}
          </p>
        </div>
        <MasterPlate />
      </section>
      {/* The hero plate's key: the same three plates small, so the story reads without motion — not three more
          full-size compositions (PM-03). */}
      <section className="lb-at-key" id="how-plates" aria-labelledby="plates-head">
        <h2 id="plates-head" className="lb-at-keyhead">
          {t('plates.title')}
        </h2>
        <ol className="lb-at-plates" data-testid="atlas-plates">
          {([0, 1, 2] as const).map((s) => (
            <li key={s}>
              <div className="lb-at-paper lb-at-thumb">
                <Plate layout={TALL} shot={s} />
              </div>
              <div>
                <h3>{t(`plate.${s}.t` as MsgKey)}</h3>
                <p>{t(`plate.${s}.d` as MsgKey)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
      <Entry title={t('home.fit')} id="home-fit">
        <div className="lb-ledger" data-testid="home-fit">
          <div className="lb-ledger-col lb-ledger-yes">
            <h3>
              <span aria-hidden="true">✓ </span>
              {t('home.for')}
            </h3>
            <List keys={['home.for.1', 'home.for.2', 'home.for.3']} />
          </div>
          <div className="lb-ledger-col lb-ledger-no">
            <h3>
              <span aria-hidden="true">✕ </span>
              {t('home.notFor')}
            </h3>
            <List keys={['home.notFor.1', 'home.notFor.2', 'home.notFor.3']} />
          </div>
        </div>
      </Entry>
      <section className="lb-at-section" id="demo" aria-labelledby="demo-head">
        <h2 id="demo-head" className="lb-at-head">
          {t('demo.title')}
        </h2>
        <p className="lb-at-lead">{t('demo.lead')}</p>
        <Demo />
      </section>
      <section className="lb-at-section lb-at-nightsec" aria-labelledby="home-hold">
        <h2 id="home-hold" className="lb-at-head">
          {t('home.hold')}
        </h2>
        <p className="lb-at-lead">{t('bound.lead')}</p>
        <Boundary />
        <p>
          <a href={PATH.how} data-testid="home-hold-more">
            {t('home.hold.more')}
          </a>
        </p>
      </section>
      <Entry title={t('home.status')} id="home-status-head">
        <dl className="lb-status-ledger" data-testid="home-status">
          <div>
            <dt>{t('ledger.version')}</dt>
            <dd>
              <span className="lb-mono">{VERSION}</span> {t('ledger.version.d')}
            </dd>
          </div>
          <div>
            <dt>{t('ledger.chain')}</dt>
            <dd>
              Plasma <span className="lb-mono">9745</span>
            </dd>
          </div>
          <div>
            <dt>{t('ledger.wallet')}</dt>
            <dd>
              Coinbase Smart Wallet <span className="lb-mono">v1.1</span>
            </dd>
          </div>
          <div>
            <dt>{t('ledger.mainnet')}</dt>
            <dd data-testid="home-mainnet">{t('ledger.mainnet.d')}</dd>
          </div>
          <div>
            <dt>{t('ledger.method')}</dt>
            <dd>{t('ledger.method.d')}</dd>
          </div>
          <div>
            <dt>{t('ledger.audit')}</dt>
            <dd>{t('ledger.audit.d')}</dd>
          </div>
          <div>
            <dt>{t('status.source')}</dt>
            <dd data-testid="home-source">
              {t('status.source.d')} <a href={REPO_URL}>{t('status.source.link')}</a>
            </dd>
          </div>
          <div>
            <dt>{t('status.release')}</dt>
            <dd data-testid="home-release">{t('status.release.d')}</dd>
          </div>
          <div>
            <dt>{t('status.website')}</dt>
            <dd data-testid="home-website">{t('status.website.d')}</dd>
          </div>
          <div>
            <dt>{t('ledger.affiliation')}</dt>
            <dd>{t('home.unofficial')}</dd>
          </div>
        </dl>
      </Entry>
      <Entry title={t('faq.title')} id="faq">
        <div className="lb-faq" data-testid="home-faq">
          {faq.map((k) => (
            <details key={k}>
              <summary>{t(`faq.${k}` as MsgKey)}</summary>
              <p>{t(`faq.${k}.a` as MsgKey)}</p>
            </details>
          ))}
        </div>
      </Entry>
      <section className="lb-at-start" aria-labelledby="home-start">
        <h2 id="home-start">{t('home.start')}</h2>
        <p>{t('home.start.d')}</p>
        <a className="lb-btn lb-btn-buoy" href={PATH.recover} data-testid="home-cta-again">
          {t('home.ctaTool')}
        </a>
      </section>
    </>
  );
}

/**
 * Where this page is, and so how to use the tool from it (PM-04): the runner's own page needs no pairing; the https
 * website pairs with a runner started for this exact origin; a static preview has no runner and cannot pair.
 */
function ModeNote({ kind }: { kind: PageKind }) {
  const { t } = useT();
  const k = kind === 'static-preview' ? 'preview' : kind;
  return (
    <div className="lb-mode-note" data-testid="mode-note" data-kind={kind}>
      <h3>{t(`mode.${k}.t` as MsgKey)}</h3>
      <p>{t(`mode.${k}.d` as MsgKey, { origin: location.origin })}</p>
      {kind === 'website' && <Command text={sourceRunnerCommand(location.origin)} testId="mode-run-origin" />}
      {kind === 'static-preview' && <Command text={sourceRunnerCommand()} testId="mode-run" />}
    </div>
  );
}

function Guide({ kind }: { kind: PageKind }) {
  const { t } = useT();
  const steps = ['check', 'deploy', 'move', 'track'] as const;
  return (
    <>
      <PageHead title="guide.title" lead={t('guide.lead')} />
      <Entry title={t('guide.need')} id="guide-need">
        <List keys={['guide.need.1', 'guide.need.2', 'guide.need.3']} />
      </Entry>
      <Entry title={t('guide.start')} id="guide-start">
        <ModeNote kind={kind} />
        <p>
          {t('guide.start.body')} <a href={PATH.download}>{t('nav.download')}</a>
        </p>
      </Entry>
      <Entry title={t('guide.steps')} id="guide-steps">
        <ol className="lb-numbered">
          {steps.map((k) => (
            <li key={k}>
              <h3>{t(`guide.${k}` as MsgKey)}</h3>
              <p>{t(`guide.${k}.body` as MsgKey)}</p>
            </li>
          ))}
        </ol>
      </Entry>
      <Entry title={t('guide.sign')} id="guide-sign">
        <h3>{t('guide.sign.bm')}</h3>
        <p>{t('guide.sign.bm.body')}</p>
        <h3>{t('guide.sign.dev')}</h3>
        <p>{t('guide.sign.dev.body')}</p>
      </Entry>
      <Entry title={t('guide.gas')} id="guide-gas">
        <p>{t('guide.gas.lead')}</p>
        <List keys={['guide.gas.wallet', 'guide.gas.browserFile', 'guide.gas.op', 'guide.gas.keystore', 'guide.gas.nativeFile']} />
      </Entry>
      <Entry title={t('guide.help')} id="guide-help">
        <p>{t('guide.help.body')}</p>
      </Entry>
    </>
  );
}

const HOW_PAGE = {
  runner: 'how.page.body.runner',
  website: 'how.page.body.website',
  'static-preview': 'how.page.body.preview',
} as const satisfies Record<PageKind, MsgKey>;

function How({ kind }: { kind: PageKind }) {
  const { t } = useT();
  return (
    <>
      <PageHead title="how.title" lead={t('how.lead')} />
      <Entry title={t('mode.where')} id="how-where">
        <ModeNote kind={kind} />
      </Entry>
      {(['page', 'runner', 'signer', 'passkey'] as const).map((k) => (
        <Entry key={k} title={t(`how.${k}` as MsgKey)} id={`how-${k}`}>
          {/* What the page can reach depends on where it is (PM-04): said for this page kind only. */}
          <p>{t(k === 'page' ? HOW_PAGE[kind] : (`how.${k}.body` as MsgKey))}</p>
        </Entry>
      ))}
      <Entry title={t('how.flow')} id="how-flow">
        <List keys={['how.flow.1', 'how.flow.2', 'how.flow.3', 'how.flow.4', 'how.flow.5']} ordered className="lb-numbered lb-numbered-tight" />
      </Entry>
      <Entry title={t('how.contracts')} id="how-contracts">
        <p>{t('how.contracts.body')}</p>
      </Entry>
    </>
  );
}

function Security() {
  const { t } = useT();
  return (
    <>
      <PageHead title="sec.title" lead={t('sec.lead')} />
      <Entry title={t('sec.never')} id="sec-never">
        <List keys={['sec.never.1', 'sec.never.2', 'sec.never.3', 'sec.never.4', 'sec.never.5']} className="lb-promises" />
      </Entry>
      <Entry title={t('sec.keys')} id="sec-keys">
        <p>{t('sec.keys.body')}</p>
      </Entry>
      <Entry title={t('sec.report')} id="sec-report">
        <p>
          {t('sec.report.body')} <a href={`${REPO_URL}/security`}>{t('sec.report.link')}</a>
        </p>
        <p className="lb-callout">{t('sec.report.never')}</p>
        <p data-testid="sec-policy">{t('sec.policy')}</p>
      </Entry>
      <Entry title={t('sec.unofficial')} id="sec-unofficial">
        <p>{t('sec.unofficial.body')}</p>
      </Entry>
    </>
  );
}

function Download({ kind }: { kind: PageKind }) {
  const { t } = useT();
  return (
    <>
      <PageHead title="dl.title" lead={t('dl.lead')} />
      {/* The source is public and the Release is not published: the way in is a clone. */}
      <Entry title={t('dl.status')} id="dl-status">
        <dl className="lb-defs lb-defs-inline">
          <dt>{t('dl.version')}</dt>
          <dd className="lb-mono" data-testid="dl-version">
            {VERSION}
          </dd>
          <dt>{t('dl.file')}</dt>
          <dd className="lb-mono" data-testid="dl-file">
            {TARBALL}
          </dd>
          <dt>{t('status.source')}</dt>
          <dd data-testid="dl-source-status">
            {t('status.source.d')} <a href={REPO_URL}>{t('status.source.link')}</a>
          </dd>
          <dt>{t('status.release')}</dt>
          <dd data-testid="dl-release-status">{t('status.release.d')}</dd>
          <dt>{t('status.website')}</dt>
          <dd data-testid="dl-website-status">{t('status.website.d')}</dd>
        </dl>
        <p>{t('dl.status.body')}</p>
      </Entry>
      <Entry title={t('dl.local')} id="dl-local">
        <ModeNote kind={kind} />
        <ol className="lb-numbered">
          <li>
            {t('dl.clone')}
            <Command text={CLONE_COMMANDS} testId="dl-clone" />
          </li>
          <li>
            {t('dl.step1')}
            <Command text={['nvm install 24.22.1', 'npm -v'].join('\n')} testId="dl-node" />
            <p>{t('dl.npmOlder')}</p>
          </li>
          <li>
            {t('dl.local.build')}
            <Command text={['npm ci', 'npm run build'].join('\n')} testId="dl-source-cmd" />
          </li>
          <li>
            {t('dl.step4')}
            <Command text={sourceRunnerCommand()} testId="dl-runner" />
            {/* Only an https website can be allowed (the runner refuses other origins), so only the real site shows it. */}
            {kind === 'website' && (
              <>
                <p>{t('dl.allow')}</p>
                <Command text={sourceRunnerCommand(location.origin)} testId="dl-runner-origin" />
              </>
            )}
          </li>
          <li>{t(kind === 'website' ? 'dl.step5.website' : 'dl.step5')}</li>
        </ol>
      </Entry>
      <Entry title={t('dl.pack')} id="dl-pack">
        <p>{t('dl.pack.body')}</p>
        <ol className="lb-numbered">
          <li>
            {t('dl.pack.make')}
            <Command text="npm pack" testId="dl-pack-cmd" />
          </li>
          <li>
            {t('dl.local.sha', { file: TARBALL })}
            <Command text={`shasum -a 256 ${TARBALL}`} testId="dl-sha" />
          </li>
          <li>
            {t('dl.pack.run')}
            <Command text={runnerCommand()} testId="dl-run" />
            {kind === 'website' && (
              <>
                <p>{t('dl.allow')}</p>
                <Command text={runnerCommand(location.origin)} testId="dl-run-origin" />
              </>
            )}
          </li>
        </ol>
      </Entry>
      <Entry title={t('dl.future')} id="dl-future">
        <p>{t('dl.future.body', { tag: RELEASE_TAG, file: TARBALL })}</p>
        <p>
          <code className="lb-mono lb-break" data-testid="dl-release-future">
            {RELEASE_PAGE_URL}
          </code>
        </p>
      </Entry>
      <Entry title={t('dl.contracts')} id="dl-contracts">
        <p>{t('dl.contracts.body')}</p>
        <Command text="node scripts/release/rebuild-contracts.mjs --out rebuild-report.json" testId="dl-rebuild" />
      </Entry>
      <Entry title={t('dl.license')} id="dl-license">
        <p>{t('dl.license.body')}</p>
      </Entry>
    </>
  );
}

/** The page body for every page except the tool (App.tsx renders that). */
export function SitePage({ page, kind }: { page: Exclude<Page, 'recover'>; kind: PageKind }) {
  return (
    <main className="lb-main lb-site" data-testid={`page-${page}`} data-kind={kind}>
      {page === 'home' && <Home />}
      {page === 'guide' && <Guide kind={kind} />}
      {page === 'how' && <How kind={kind} />}
      {page === 'security' && <Security />}
      {page === 'download' && <Download kind={kind} />}
    </main>
  );
}

/** A path that is no page. Plain links out; the tool is not mounted for it. */
export function NotFound() {
  const { t } = useT();
  return (
    <main className="lb-main lb-site" data-testid="page-notFound">
      <PageHead title="notfound.title" lead={t('notfound.lead')} />
      <ul className="lb-notfound-links">
        <li>
          <a href={PATH.home}>{t('nav.home')}</a>
        </li>
        <li>
          <a href={PATH.recover}>{t('nav.recover')}</a>
        </li>
        <li>
          <a href={PATH.guide}>{t('nav.guide')}</a>
        </li>
      </ul>
    </main>
  );
}
