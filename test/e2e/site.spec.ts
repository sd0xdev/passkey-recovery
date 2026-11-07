// The website pages (Home, Guide, How it works, Security, Download) and the tool on real paths (design guidelines
// §13.3): `/` is the site and `/recover` the tool on every origin; old `#/…` links land on their path; the nav,
// focus on page change, titles, axe in EN and 繁中, no sideways scroll at 390/768/1440, the release identity on
// Download, no request leaving 127.0.0.1, and the tool keeping its state while the guide is read.
// The route matrix (direct open, refresh, back/forward, 404, query, anchors, and the fallback never shadowing the
// API, files or assets) runs against the hosted build (4179), the runner (4177), the sidecar (4175) and the
// static preview (4174). Screenshots go to E2E_SHOT_DIR when it is set.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_HOSTED, E2E_HOSTED_HTTP, E2E_RUNNER } from '../support/e2e-constants';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string };
const TARBALL = `${pkg.name}-${pkg.version}.tgz`;
const SIDECAR = 'http://127.0.0.1:4175';
const PREVIEW = 'http://127.0.0.1:4174';
const SITE_PAGES = [
  ['home', '/'],
  ['guide', '/guide'],
  ['how', '/how-it-works'],
  ['security', '/security'],
  ['download', '/download'],
] as const;
const ALL_PAGES = [...SITE_PAGES, ['recover', '/recover'] as const];
const SHOTS = process.env.E2E_SHOT_DIR;
/** Every origin that serves the UI. `real404`: a miss is an HTTP 404 (the static preview answers 200 with the app).
 * `E2E_WORKERD=<url>` adds the same dist-hosted/ served by the real Workers runtime (`wrangler dev --local`, started
 * by hand, assets only, no login) — the 4179 server emulates its routing; this checks the emulation. Off by default. */
type Origin = { name: 'hosted' | 'workerd' | 'runner' | 'sidecar' | 'preview'; base: string; real404: boolean };
const ORIGINS: readonly Origin[] = [
  { name: 'hosted', base: E2E_HOSTED, real404: true },
  ...(process.env.E2E_WORKERD ? [{ name: 'workerd', base: process.env.E2E_WORKERD, real404: true } as const] : []),
  { name: 'runner', base: E2E_RUNNER, real404: true },
  { name: 'sidecar', base: SIDECAR, real404: true },
  { name: 'preview', base: PREVIEW, real404: false },
];
const isHosted = (o: Origin) => o.name === 'hosted' || o.name === 'workerd';

async function axeClean(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const onlyLoopback = (page: Page) => {
  const outside: string[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['127.0.0.1', 'localhost'].includes(u.hostname) && u.protocol !== 'data:') outside.push(u.origin);
  });
  return outside;
};
const onPage = async (page: Page, p: string) => {
  await expect(page.getByTestId(`nav-${p}`)).toHaveAttribute('aria-current', 'page');
  if (p === 'recover') await expect(page.getByTestId('page-recover')).toBeVisible();
  else await expect(page.getByTestId('page-recover')).toBeHidden();
};

test('`/` is the website on every origin, `/recover` is the tool; each page has its own title', async ({ page }) => {
  for (const o of ORIGINS) {
    await page.goto(`${o.base}/`);
    await onPage(page, 'home');
    await expect(page).toHaveTitle('Passkey Recovery by sd0x');
    await page.goto(`${o.base}/recover`);
    await onPage(page, 'recover');
    await expect(page).toHaveTitle('Recovery tool — Passkey Recovery by sd0x');
  }
  const titles = new Set<string>();
  for (const [p, path] of ALL_PAGES) {
    await page.goto(`${E2E_HOSTED}${path}`);
    await onPage(page, p);
    titles.add(await page.title());
  }
  expect(titles.size).toBe(ALL_PAGES.length);
});

test('route matrix: direct open and refresh of every page, query kept, trailing slash, on every origin', async ({ page }) => {
  test.setTimeout(120_000);
  for (const o of ORIGINS) {
    for (const [p, path] of ALL_PAGES) {
      const res = await page.goto(`${o.base}${path}`);
      expect(res?.status(), `${o.name} ${path}`).toBe(200);
      await onPage(page, p);
    }
    await page.goto(`${o.base}/security?ref=matrix`);
    await page.reload();
    await onPage(page, 'security');
    expect(new URL(page.url()).search).toBe('?ref=matrix');
    // `/guide/` is the same page: the hosted build redirects to the bare path, the local servers answer it as is.
    await page.goto(`${o.base}/guide/`);
    await onPage(page, 'guide');
    if (isHosted(o)) expect(new URL(page.url()).pathname).toBe('/guide');
  }
});

test('route matrix: an unknown path is the 404 page (HTTP 404 where the server can say so), with a way home', async ({ page }) => {
  for (const o of ORIGINS) {
    for (const path of ['/nope', '/GUIDE', '/guide/x']) {
      const res = await page.goto(`${o.base}${path}`);
      expect(res?.status(), `${o.name} ${path}`).toBe(o.real404 ? 404 : 200);
      await expect(page.locator('h1:visible')).toContainText(/does not exist|不存在/);
      await expect(page.getByRole('link', { name: /Passkey Recovery|home|首頁/i }).first()).toBeVisible();
    }
  }
});

test('route matrix: the page fallback never answers the API, files, assets or a prefetch', async ({ request }) => {
  for (const o of ORIGINS.filter((x) => x.name !== 'preview')) {
    const api = await request.get(`${o.base}/api/nope`, { headers: { accept: 'text/html' } });
    expect(api.status(), `${o.name} /api/nope`).toBeGreaterThanOrEqual(400);
    expect(await api.text()).not.toContain('<div id="root">');
    const asset = await request.get(`${o.base}/assets/missing-0000.js`, { headers: { accept: 'text/html' } });
    expect(asset.status(), `${o.name} asset`).toBe(404);
    expect(await asset.text()).not.toContain('<div id="root">');
    const tgz = await request.get(`${o.base}/${TARBALL}`, { headers: { accept: 'text/html' } });
    expect(tgz.status(), `${o.name} tgz`).toBe(404);
    expect(await tgz.text()).not.toContain('<div id="root">');
    const lic = await request.get(`${o.base}/licenses/GPL-3.0.txt`);
    expect(lic.status(), `${o.name} license file`).toBe(200);
    expect(await lic.text()).toContain('GNU GENERAL PUBLIC LICENSE');
  }
  // Only the runner and the sidecar mint a session into the page, so only they refuse a speculative load.
  for (const base of [E2E_RUNNER, SIDECAR]) {
    const pre = await request.get(`${base}/recover`, { headers: { 'sec-purpose': 'prefetch' } });
    expect(pre.status()).toBe(503);
    expect(await pre.text()).toBe('');
  }
});

test('route matrix: back/forward and anchors follow the history on every origin', async ({ page }) => {
  for (const o of ORIGINS) {
    await page.goto(`${o.base}/`);
    await page.getByTestId('nav-guide').click();
    await onPage(page, 'guide');
    await page.evaluate(() => window.scrollTo(0, 600));
    await page.getByTestId('nav-recover').click();
    await onPage(page, 'recover');
    await page.goBack();
    await onPage(page, 'guide');
    expect(new URL(page.url()).pathname).toBe('/guide');
    // Back is a page change like a click: the top of the page, focus on its title (not the old scroll or the nav).
    await expect(page.locator('#page-title')).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: `${o.name} back scroll` }).toBe(0);
    await page.goBack();
    await onPage(page, 'home');
    await page.goForward();
    await onPage(page, 'guide');
    // A direct link to a section of another page lands on the section.
    await page.goto(`${o.base}/#faq`);
    await expect(page.locator('#faq')).toBeInViewport();
    // Within one page, Back/Forward between the section and the page's top go to each.
    await page.goto(`${o.base}/`);
    await page.goto(`${o.base}/#faq`);
    await expect(page.locator('#faq')).toBeInViewport();
    await page.goBack();
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: `${o.name} fragment back` }).toBe(0);
    await page.goForward();
    await expect(page.locator('#faq')).toBeInViewport();
  }
});

test('old `#/…` links land on their path (query kept); unknown fragments are left alone', async ({ page }) => {
  for (const o of ORIGINS) {
    for (const [p, path] of ALL_PAGES) {
      await page.goto(`${o.base}/?from=old#/${p === 'home' ? 'home' : p === 'how' ? 'how-it-works' : p}`);
      await onPage(page, p);
      const u = new URL(page.url());
      expect([u.pathname, u.search, u.hash], `${o.name} ${p}`).toEqual([path, '?from=old', '']);
    }
  }
  await page.goto(`${E2E_HOSTED}/#/nope`);
  await onPage(page, 'home');
  expect(new URL(page.url()).hash).toBe('#/nope');
  // The legacy link still opens the tool after the redirect, and back leaves it rather than bouncing.
  await page.goto(`${E2E_HOSTED}/guide`);
  await page.goto(`${E2E_HOSTED}/#/recover`);
  await onPage(page, 'recover');
  await page.goBack();
  await onPage(page, 'guide');
});

test('nav: every page by keyboard; the heading takes focus and the page starts at the top', async ({ page }) => {
  const outside = onlyLoopback(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${E2E_HOSTED}/`);
  for (const [p, path] of [...SITE_PAGES.slice(1), ['recover', '/recover'] as const, SITE_PAGES[0]]) {
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.getByTestId(`nav-${p}`).focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${E2E_HOSTED}${path}`);
    await expect(page.getByTestId(`nav-${p}`)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#page-title')).toBeFocused();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  }
  expect(outside).toEqual([]);
});

test('Home: the hero leads to the tool and to the plates; the status ledger states the scoped mainnet fact and no endorsement', async ({ page }) => {
  await page.goto(`${E2E_HOSTED}/`);
  await expect(page.getByTestId('atlas-plates').locator('li')).toHaveCount(3);
  await expect(page.getByTestId('atlas-demo').locator('.lb-at-demo-stills > li')).toHaveCount(4);
  await expect(page.getByTestId('home-mainnet')).toContainText('keystore + 1Password');
  await expect(page.getByTestId('home-mainnet')).not.toContainText(/0x[0-9a-f]{8,}/i);
  await expect(page.getByTestId('home-status')).toContainText('Not audited');
  await expect(page.getByTestId('home-status')).toContainText('not affiliated with, endorsed by, or supported by');
  // Three separate facts: the source is public, the runner Release is not published, the website is not deployed.
  await expect(page.getByTestId('home-source')).toContainText('Public on GitHub');
  await expect(page.getByTestId('home-source').locator('a')).toHaveAttribute('href', 'https://github.com/sd0xdev/passkey-recovery');
  await expect(page.getByTestId('home-release')).toContainText('Not published');
  await expect(page.getByTestId('home-website')).toContainText('Not deployed yet');
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('home-source')).toContainText('已公開在 GitHub');
  await expect(page.getByTestId('home-release')).toContainText('尚未發布');
  await expect(page.getByTestId('home-website')).toContainText('尚未部署');
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('home-faq').locator('details')).toHaveCount(6);
  await page.getByTestId('home-cta-tool').click();
  await onPage(page, 'recover');
  await page.goBack();
  await page.getByTestId('home-cta-how').click();
  await expect(page).toHaveURL(`${E2E_HOSTED}/#how-plates`);
  await expect(page.locator('#how-plates')).toBeInViewport();
  await page.getByTestId('home-cta-again').click();
  await onPage(page, 'recover');
});

test('tool help keeps the three publication facts apart and leads to the source steps, in EN and 繁中', async ({ page }) => {
  await page.goto(`${E2E_HOSTED}/recover`);
  await page.getByTestId('top-help').click();
  const help = page.getByTestId('help');
  for (const text of ['public on GitHub', 'No runner Release or tarball is published yet', 'the website is not deployed']) await expect(help).toContainText(text);
  await expect(help.locator('a[href="/download"]')).toHaveCount(1);
  await expect(help.locator('a[href="https://github.com/sd0xdev/passkey-recovery"]')).toHaveCount(1);
  await expect(help.locator('a[href*="/releases"]')).toHaveCount(0);
  await page.getByTestId('sheet-help-close').click();
  await page.getByTestId('lang-toggle').click();
  await page.getByTestId('top-help').click();
  for (const text of ['已公開在 GitHub', 'Runner Release 與 tarball 尚未發布', '網站也尚未部署']) await expect(help).toContainText(text);
});

test('Home rhythm (PM-03): hero → plates → is this for you → demo → who holds what, said once; the source link opens the public repository', async ({ page }) => {
  await page.goto(`${E2E_HOSTED}/`);
  const order = ['.lb-chart-hero', '#how-plates', '[data-testid="home-fit"]', '[data-testid="atlas-demo"]', '[data-testid="atlas-boundary"]', '[data-testid="home-status"]', '[data-testid="home-faq"]', '[data-testid="home-cta-again"]'];
  const tops = await page.evaluate((sel) => sel.map((q) => document.querySelector(q)!.getBoundingClientRect().top + scrollY), order);
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
  // The boundary is explained once: no second holders list, and the channels open on request.
  await expect(page.getByTestId('home-holders')).toHaveCount(0);
  await expect(page.getByTestId('atlas-boundary')).toHaveCount(1);
  const channels = page.getByTestId('bound-channels');
  await expect(channels).not.toHaveAttribute('open', '');
  await expect(channels.locator('li').first()).toBeHidden();
  await channels.locator('summary').click();
  await expect(channels.locator('li')).toHaveCount(4);
  await expect(channels.locator('li').first()).toBeVisible();
  await expect(page.getByTestId('home-hold-more')).toHaveAttribute('href', '/how-it-works');
  await expect(page.locator('footer.lb-footer a', { hasText: 'Source code' })).toHaveAttribute('href', 'https://github.com/sd0xdev/passkey-recovery');
  // The sponsor link stays a plain new-tab anchor to the one Stripe page, labelled in each language.
  const sponsor = page.getByTestId('footer-sponsor');
  await expect(sponsor).toHaveAttribute('href', 'https://buy.stripe.com/8x2eVdfSh6KZ4mf6wm0sU06');
  await expect(sponsor).toHaveAttribute('target', '_blank');
  await expect(sponsor).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(sponsor).toHaveText('Sponsor this project');
  await page.getByTestId('lang-toggle').click();
  await expect(sponsor).toHaveText('贊助這個專案');
});

test('Demo (PM-03): one labelled still at a time, stepped by the named buttons or Previous / Next, and unseen stills are not fetched', async ({ page }) => {
  const webp: string[] = [];
  page.on('request', (r) => r.url().endsWith('.webp') && webp.push(new URL(r.url()).pathname));
  await page.goto(`${E2E_HOSTED}/`);
  const demo = page.getByTestId('atlas-demo');
  await demo.scrollIntoViewIfNeeded();
  const visible = demo.locator('.lb-at-demo-stills > li:visible');
  await expect(visible).toHaveCount(1);
  await expect(visible.locator('figcaption')).toContainText('Demo, synthetic data');
  await expect(visible.locator('figcaption')).toContainText('Add it and the check continues');
  await expect(page.getByTestId('demo-step-check')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('demo-prev')).toBeDisabled();
  await expect(page.getByTestId('demo-count')).toHaveText('1 of 4');
  await expect.poll(() => webp.length).toBe(1);
  await page.getByTestId('demo-next').click();
  await expect(page.getByTestId('demo-step-deploy')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('demo-step-check')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('demo-count')).toHaveText('2 of 4');
  // The shown still loads once it is on screen; a still the reader skips (approve) is never fetched.
  await expect.poll(() => demo.locator('#demo-deploy img').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(960);
  await page.getByTestId('demo-step-track').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('demo-count')).toHaveText('4 of 4');
  await expect(page.getByTestId('demo-next')).toBeDisabled();
  await expect(visible).toHaveCount(1);
  await expect(visible.locator('figcaption')).toContainText('Demo, synthetic data');
  await expect.poll(() => demo.locator('#demo-track img').evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(960);
  expect([...webp].sort()).toEqual(expect.arrayContaining([expect.stringContaining('demo-check'), expect.stringContaining('demo-deploy'), expect.stringContaining('demo-track')]));
  expect(webp.some((u) => u.includes('demo-approve'))).toBe(false);
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('demo-count')).toHaveText('第 4 個，共 4 個');
  await expect(visible.locator('figcaption')).toContainText('示範（合成資料）');
  await expect(demo.locator('.lb-at-demo-step')).toHaveText(['1 檢查', '2 部署（只在需要時）', '3 核准', '4 追蹤']);
  // Previous steps back one still, and the pager re-enables Next.
  await page.getByTestId('demo-prev').click();
  await expect(page.getByTestId('demo-count')).toHaveText('第 3 個，共 4 個');
  await expect(page.getByTestId('demo-step-approve')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('demo-next')).toBeEnabled();
  await expect(page.getByTestId('demo-prev')).toHaveText('上一個');
});

test('site pages: axe clean in EN and 繁中, no sideways scroll at 390/768/1440, screenshots', async ({ page }) => {
  test.setTimeout(180_000);
  const outside = onlyLoopback(page);
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  for (const lang of ['en', 'zh'] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${E2E_HOSTED}/`);
    if (lang === 'zh') await page.getByTestId('lang-toggle').click();
    await expect(page.locator('.lb-app')).toHaveAttribute('lang', lang === 'en' ? 'en' : 'zh-Hant-TW');
    for (const [p] of [...SITE_PAGES, ['notFound', '/nope'] as const]) {
      // Client navigation keeps the chosen language; the 404 is reached the same way a stale in-app link would.
      if (p === 'notFound') await page.evaluate(() => (history.pushState(null, '', '/nope'), dispatchEvent(new PopStateEvent('popstate'))));
      else await page.getByTestId(`nav-${p}`).click();
      if (p !== 'notFound') await expect(page.getByTestId(`nav-${p}`)).toHaveAttribute('aria-current', 'page');
      else await expect(page.getByTestId('page-notFound')).toBeVisible();
      await expect(page.locator('.lb-app')).toHaveAttribute('lang', lang === 'en' ? 'en' : 'zh-Hant-TW');
      await axeClean(page, `${p} ${lang}`);
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await noSidewaysScroll(page), `${p} ${lang} ${width}`).toBe(true);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, `site-${p}-${lang}-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  }
  expect(outside).toEqual([]);
});

test('the static 404 page is plain, bilingual and script-free', async ({ page }) => {
  const scripts: string[] = [];
  page.on('request', (r) => r.resourceType() === 'script' && scripts.push(r.url()));
  const res = await page.goto(`${E2E_HOSTED}/nope`);
  expect(res?.status()).toBe(404);
  await expect(page.locator('body')).toContainText('This page does not exist');
  await expect(page.locator('body')).toContainText('這個頁面不存在');
  expect(scripts).toEqual([]);
  await axeClean(page, '404.html');
});

test('Download: the source is public, the Release unpublished, the website undeployed; a clone builds and runs, the package file is made locally, and the future Release address is text, not a link', async ({ page }) => {
  await page.goto(`${E2E_HOSTED}/download`);
  await expect(page.getByTestId('dl-version')).toHaveText(pkg.version);
  await expect(page.getByTestId('dl-file')).toHaveText(TARBALL);
  await expect(page.getByTestId('dl-source-status')).toContainText('Public on GitHub');
  await expect(page.getByTestId('dl-release-status')).toContainText('Not published');
  await expect(page.getByTestId('dl-website-status')).toContainText('Not deployed yet');
  // The steps run in this order on a first visit: clone, then Node and npm (.nvmrc is in the clone), build, runner.
  const order = ['dl-clone', 'dl-node', 'dl-source-cmd', 'dl-runner', 'dl-pack-cmd', 'dl-sha', 'dl-run'];
  const tops = await page.evaluate((ids) => ids.map((id) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top), order);
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
  await expect(page.getByTestId('dl-clone')).toContainText('git clone https://github.com/sd0xdev/passkey-recovery.git\ncd passkey-recovery');
  await expect(page.getByTestId('dl-node')).toContainText('nvm install 24.22.1');
  await expect(page.getByTestId('dl-source-cmd')).toContainText('npm ci\nnpm run build');
  await expect(page.getByTestId('dl-runner')).toContainText('npm run runner');
  await expect(page.getByTestId('dl-pack-cmd')).toContainText('npm pack');
  await expect(page.getByTestId('dl-sha')).toContainText(`shasum -a 256 ${TARBALL}`);
  await expect(page.getByTestId('dl-run')).toContainText(`npm exec --yes --package ./${TARBALL} -- passkey-recovery`);
  // The planned Release address is stated, never offered as a link to a page that does not exist yet.
  await expect(page.getByTestId('dl-release-future')).toHaveText(`https://github.com/sd0xdev/passkey-recovery/releases/tag/v${pkg.version}`);
  await expect(page.getByTestId('dl-release')).toHaveCount(0);
  // The only repository link is to the source itself: nothing points at a release or a download that does not exist.
  const repoLinks = await page.locator('main a[href*="github.com/sd0xdev/passkey-recovery"]').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(repoLinks).toEqual(['https://github.com/sd0xdev/passkey-recovery']);
  await expect(page.locator('main a[href*="/releases"]')).toHaveCount(0);
  await expect(page.locator('main a[href$=".tgz"]')).toHaveCount(0);
  // On the https website each command names this exact origin, which is what the runner allowlists.
  await expect(page.getByTestId('dl-runner-origin')).toContainText(`npm run runner -- --allow-origin ${new URL(E2E_HOSTED).origin}`);
  await expect(page.getByTestId('dl-run-origin')).toContainText(`npm exec --yes --package ./${TARBALL} -- passkey-recovery --allow-origin ${new URL(E2E_HOSTED).origin}`);
  // The same build on http (wrangler dev) is refused as a pairing origin by the runner: the command is not offered.
  await page.goto(`${E2E_HOSTED_HTTP}/download`);
  await expect(page.getByTestId('dl-run')).toContainText(`npm exec --yes --package ./${TARBALL} -- passkey-recovery`);
  await expect(page.getByTestId('dl-run-origin')).toHaveCount(0);
  await expect(page.getByTestId('dl-runner-origin')).toHaveCount(0);
});

test('mode notes follow where the page is (PM-04): runner page uses the tool directly, the https website pairs, an http preview has no runner', async ({ page }) => {
  test.setTimeout(90_000); // three origins × three pages, two Guides and two gas sheets in two languages
  const cases = [
    { base: E2E_RUNNER, kind: 'runner', title: 'This page is served by your runner', origin: false },
    { base: E2E_HOSTED, kind: 'website', title: 'This is the website', origin: true },
    { base: E2E_HOSTED_HTTP, kind: 'static-preview', title: 'This is a static preview', origin: false },
  ] as const;
  for (const c of cases) {
    for (const path of ['/how-it-works', '/guide', '/download']) {
      await page.goto(`${c.base}${path}`);
      const note = page.getByTestId('mode-note');
      await expect(note, `${c.kind} ${path}`).toHaveAttribute('data-kind', c.kind);
      await expect(note.locator('h3'), `${c.kind} ${path}`).toHaveText(c.title);
      await expect(note.getByTestId('mode-run-origin'), `${c.kind} ${path}`).toHaveCount(c.origin ? 1 : 0);
      if (c.origin) await expect(note.getByTestId('mode-run-origin')).toContainText(`npm run runner -- --allow-origin ${new URL(E2E_HOSTED).origin}`);
      if (c.kind === 'runner') await expect(note, path).toContainText('nothing to pair');
      if (c.kind === 'static-preview') await expect(note, path).toContainText(`${new URL(c.base).origin} is a static preview`);
    }
  }
  // How it works: what the page can reach is said for this page kind only, in EN and 繁中.
  const how = [
    { base: E2E_RUNNER, en: 'talks to that runner and its native signer directly', zh: '直接與這個 runner 及其 native signer 溝通' },
    { base: E2E_HOSTED, en: 'only if you started the runner for this site’s exact address', zh: '只有在你以本站的確切網址啟動它時才會回應' },
    { base: E2E_HOSTED_HTTP, en: 'no runner behind it, and it cannot pair with one', zh: '後面沒有 runner，也無法與 runner 配對' },
  ];
  for (const h of how) {
    await page.goto(`${h.base}/how-it-works`);
    const body = page.locator('#how-page').locator('xpath=..');
    await expect(body, h.base).toContainText(h.en);
    if (h.base !== E2E_HOSTED) await expect(body, h.base).not.toContainText('you paired');
    await page.getByTestId('lang-toggle').click();
    await expect(body, `${h.base} zh`).toContainText(h.zh);
    await page.getByTestId('lang-toggle').click();
  }
  // The Guide says nothing beyond the note about pairing: no "press Connect runner" on a page that cannot pair.
  for (const base of [E2E_RUNNER, E2E_HOSTED_HTTP]) {
    await page.goto(`${base}/guide`);
    await expect(page.getByTestId('page-guide'), base).not.toContainText('Connect runner');
  }
  // The gas sheet's reason a runner-only way is off follows the page kind, in EN and 繁中.
  const hints = [
    { base: E2E_HOSTED, en: 'Needs the runner, started for this site and connected', zh: '需要為本站啟動並連接的 runner' },
    { base: E2E_HOSTED_HTTP, en: 'Needs the runner’s own page; this preview has no runner', zh: '需要 runner 自己的頁面；這個預覽沒有 runner' },
  ];
  for (const h of hints) {
    await page.goto(`${h.base}/recover`);
    for (const lang of ['en', 'zh'] as const) {
      if (lang === 'zh') await page.getByTestId('lang-toggle').click();
      await page.getByTestId('wallet-none').click();
      const row = page.locator('.lb-option', { has: page.getByTestId('gas-mode-native-op') });
      await expect(row.locator('.lb-option-line'), `${h.base} ${lang}`).toHaveText(h[lang]);
      await page.getByTestId('sheet-gas-close').click();
    }
    await page.getByTestId('lang-toggle').click();
  }
  // The runner's own page with its native signer off: the reason names that signer, never "pair a runner".
  await page.route('**/api/config', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as { runner?: Record<string, unknown> };
    await route.fulfill({ response, json: { ...config, runner: { ...config.runner, nativeSignerUrl: null } } });
  });
  await page.goto(`${E2E_RUNNER}/recover`);
  for (const [lang, text] of [['en', 'The runner’s native signer is off'], ['zh', 'runner 的 native signer 已關閉']] as const) {
    if (lang === 'zh') await page.getByTestId('lang-toggle').click();
    await page.getByTestId('wallet-none').click();
    await expect(page.getByTestId('gas-mode-native-op'), `runner ${lang}`).toBeDisabled();
    const row = page.locator('.lb-option', { has: page.getByTestId('gas-mode-native-op') });
    await expect(row.locator('.lb-option-line'), `runner ${lang}`).toHaveText(text);
    await page.getByTestId('sheet-gas-close').click();
  }
  await page.getByTestId('lang-toggle').click();
  await page.unroute('**/api/config');
  await page.goto(`${E2E_HOSTED_HTTP}/how-it-works`);
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('mode-note').locator('h3')).toHaveText('這是靜態預覽');
});

test('reading the guide keeps the tool as it was: the typed wallet is still there, and back returns to it', async ({ page }) => {
  await page.goto(`${E2E_HOSTED}/recover`);
  const account = '0x' + '11'.repeat(20);
  await page.getByTestId('check-account').fill(account);
  await page.getByTestId('nav-guide').click();
  await expect(page.getByTestId('page-recover')).toBeHidden();
  await page.getByTestId('nav-recover').click();
  await expect(page.getByTestId('check-account')).toHaveValue(account);
  await page.getByTestId('nav-security').click();
  await page.goBack();
  await expect(page.getByTestId('check-account')).toHaveValue(account);
  // Nothing typed is written to the URL or to storage.
  expect(page.url()).not.toContain('11111111');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('11111111');
});

const TOOL_CHUNK = /\/assets\/Tool-[^/]+\.js$/;

test('the tool chunk loads only on the first visit to /recover and stays loaded through help, back and forward', async ({ page }) => {
  const toolRequests: string[] = [];
  page.on('request', (r) => {
    if (TOOL_CHUNK.test(new URL(r.url()).pathname)) toolRequests.push(r.url());
  });
  await page.goto(`${E2E_HOSTED}/`);
  await page.getByTestId('nav-guide').click();
  await expect(page.locator('#page-title')).toBeFocused();
  expect(toolRequests).toHaveLength(0);

  await page.getByTestId('nav-recover').click();
  await expect(page.getByTestId('check-account')).toBeVisible();
  expect(toolRequests).toHaveLength(1);

  await page.getByTestId('top-help').click();
  await expect(page.getByTestId('sheet-help')).toBeVisible();
  await page.goBack();
  await page.goForward();
  await expect(page.getByTestId('check-account')).toBeVisible();
  await expect(page.getByTestId('sheet-help')).toBeHidden();
  expect(toolRequests).toHaveLength(1);
});

test('while the tool chunk is on its way the page says so; when it cannot load, the page says so and offers a reload', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let abort = false;
  await page.context().route(TOOL_CHUNK, async (route) => {
    if (abort) return route.abort('failed');
    await held;
    await route.continue();
  });
  await page.goto(`${E2E_HOSTED}/recover`);
  await expect(page.getByTestId('tool-loading')).toBeVisible();
  release();
  await expect(page.getByTestId('check-account')).toBeVisible();
  await expect(page.getByTestId('tool-loading')).toHaveCount(0);

  // A fresh page whose chunk request fails: the boundary shows the failure and a working reload.
  abort = true;
  const fresh = await page.context().newPage();
  await fresh.goto(`${E2E_HOSTED}/`);
  await fresh.getByTestId('nav-recover').click();
  const failed = fresh.getByTestId('tool-failed');
  await expect(failed).toBeVisible();
  await expect(fresh.getByTestId('check-account')).toHaveCount(0);
  abort = false;
  await failed.getByRole('button', { name: 'Reload' }).click();
  await expect(fresh.getByTestId('check-account')).toBeVisible();
});

test('reflow at 320, the station drawn once and still under reduced motion, and #faq never under the sticky header', async ({ browser }) => {
  // 1.4.10: every page at 320 CSS px without sideways scroll.
  const narrow = await browser.newPage({ viewport: { width: 320, height: 720 } });
  for (const [, path] of ALL_PAGES) {
    await narrow.goto(`${E2E_HOSTED}${path}`);
    await expect(narrow.locator('#page-title')).toBeVisible();
    expect(await noSidewaysScroll(narrow), `320 ${path}`).toBe(true);
  }
  await narrow.close();
  // The hero station is drawn once on load (the page's one automatic motion); under reduce there is none.
  const animated = async (reducedMotion: 'reduce' | 'no-preference') => {
    const ctx = await browser.newContext({ reducedMotion, viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`${E2E_HOSTED}/`);
    const name = await p.locator('.lb-at-wide .lb-at-ring').evaluate((el) => getComputedStyle(el).animationName);
    await ctx.close();
    return name;
  };
  expect(await animated('no-preference')).toBe('lb-at-ring');
  expect(await animated('reduce')).toBe('none');
  // 2.4.11: a direct /#faq lands with the section below the site header, at 1440 and 390.
  for (const width of [1440, 390]) {
    const p = await browser.newPage({ viewport: { width, height: 800 } });
    await p.goto(`${E2E_HOSTED}/#faq`);
    await expect(p.locator('#faq')).toBeInViewport();
    const [faqTop, headBottom] = await p.evaluate(() => {
      const head = document.querySelector('[data-testid="site-header"]')!;
      const sticky = getComputedStyle(head).position === 'sticky';
      return [document.getElementById('faq')!.getBoundingClientRect().top, sticky ? head.getBoundingClientRect().bottom : 0];
    });
    expect(faqTop, `${width} #faq below header`).toBeGreaterThanOrEqual(headBottom - 1);
    await p.close();
  }
});
