// The page knows where it is from what it holds (6-recovery-atlas.md §6.2, RUN-1 / RUN-3): the runner's own page
// connects by itself and stays connected across reload and back/forward; a static preview says it cannot pair and
// where the full local tool is; the website pairs, and a paired runner of another release is named, not refused.
// The Check step never says "In progress" unless it is reading (PM finding 3, COPY-1).
import { expect, test, type Browser } from '@playwright/test';
import { E2E_HOSTED, E2E_HOSTED_HTTP, E2E_PROVIDER, E2E_RUNNER } from '../support/e2e-constants';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const PREVIEW = 'http://127.0.0.1:4174';
const LOCAL_TOOL = 'http://127.0.0.1:4171/recover';

async function open(browser: Browser, url: string) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  // Loopback test servers only; anything else is a leak.
  const external: string[] = [];
  await page.route((u) => !/^https?:\/\/127\.0\.0\.1:41(74|77|78|79|80)\//.test(u.href) && u.href !== 'about:blank', (r) => (external.push(r.request().url()), r.abort('blockedbyclient')));
  await page.goto(url);
  return { page, ctx, external };
}

test('runner page: / and /recover connect with no pairing; reload and back/forward stay connected', async ({ browser }) => {
  const { page, ctx, external } = await open(browser, `${E2E_RUNNER}/`);
  // The home page from the runner carries the session too, so opening the tool from it needs nothing more.
  await expect(page.locator('meta[name="cbpr-session"]')).toHaveCount(1);
  await page.getByTestId('nav-recover').click();
  const runner = page.getByTestId('caps').locator('[data-cap="runner"]');
  await expect(runner).toHaveAttribute('data-ok', 'true');
  await expect(runner).toContainText('no pairing needed');
  // The runner page names its version, like a paired runner does (§6.2).
  await expect(runner).toContainText(`version ${pkg.version}`);
  await expect(page.getByTestId('step-word-check')).toHaveText('Start here');
  await expect(page.getByTestId('top-pair')).toHaveCount(0);

  await page.reload();
  await expect(runner).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('no-sidecar')).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(`${E2E_RUNNER}/`);
  await page.goForward();
  await expect(page).toHaveURL(`${E2E_RUNNER}/recover`);
  await expect(runner).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('step-word-check')).not.toHaveText('In progress');
  expect(external).toEqual([]);
  await ctx.close();
});

test('static preview: says it has no runner and cannot pair, points to the full local tool, and Check needs the runner', async ({ browser }) => {
  const { page, ctx, external } = await open(browser, `${PREVIEW}/recover`);
  const caps = page.getByTestId('caps');
  await expect(caps.locator('[data-cap="ui"]')).toContainText('Static preview');
  await expect(caps.locator('[data-cap="runner"]')).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('caps-preview-link')).toHaveAttribute('href', LOCAL_TOOL);
  await expect(page.getByTestId('no-sidecar')).toContainText(LOCAL_TOOL);
  // Nothing on this page offers a pairing a real runner would refuse.
  await expect(page.getByTestId('top-pair')).toHaveCount(0);
  await expect(page.getByTestId('caps-pair')).toHaveCount(0);
  await expect(page.getByTestId('step-word-check')).toHaveText('Needs the runner');
  await expect(page.locator('li[data-step="check"]')).toHaveAttribute('data-word', 'needsRunner');
  // 繁中 says the same.
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('step-word-check')).toHaveText('需要 runner');
  await expect(page.getByTestId('step-word-check')).not.toHaveText('進行中');
  expect(external).toEqual([]);
  await ctx.close();
});

test('the website build on http (wrangler dev): a static preview — no pairing offered, no --allow-origin, the full local tool named', async ({ browser }) => {
  const { page, ctx, external } = await open(browser, `${E2E_HOSTED_HTTP}/recover`);
  const caps = page.getByTestId('caps');
  await expect(caps.locator('[data-cap="ui"]')).toContainText('Static preview');
  await expect(page.getByTestId('caps-preview-link')).toHaveAttribute('href', LOCAL_TOOL);
  await expect(page.getByTestId('no-sidecar')).toContainText(LOCAL_TOOL);
  await expect(page.getByTestId('top-pair')).toHaveCount(0);
  await expect(page.getByTestId('caps-pair')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('--allow-origin http');
  // The same build on https is the website: it offers the pairing.
  await page.goto(`${E2E_HOSTED}/recover`);
  await expect(page.getByTestId('top-pair')).toBeVisible();
  expect(external).toEqual([]);
  await ctx.close();
});

test('website: unpaired Check needs the runner; paired it starts here; a runner of another release is named, still usable', async ({ browser }) => {
  const { code } = (await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string };
  const { page, ctx, external } = await open(browser, `${E2E_HOSTED}/recover`);
  await expect(page.getByTestId('step-word-check')).toHaveText('Needs the runner');
  // The runner answers the pairing as an older release would (same protocol): only the version field differs.
  await page.route(`${E2E_RUNNER}/api/pair`, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as Record<string, unknown>;
    await route.fulfill({ response: res, json: { ...body, version: '0.1.9' } });
  });
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-advanced').locator('summary').click();
  await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
  await page.getByTestId('pair-code').fill(code);
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('sheet-pair')).toBeHidden();
  const runner = page.getByTestId('caps').locator('[data-cap="runner"]');
  await expect(runner).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('caps-version-differs')).toContainText('0.1.9');
  await expect(page.getByTestId('caps-version-differs')).toContainText('0.2.0');
  await expect(page.getByTestId('step-word-check')).toHaveText('Start here');
  expect(external).toEqual([]);
  await ctx.close();
});
