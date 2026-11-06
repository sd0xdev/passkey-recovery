// Browser e2e of the RPC settings sheet (M1; opened from the top bar's endpoint chip) against the real sidecar bundle on 127.0.0.1:4175 in
// SYNTHETIC testchain mode, with a synthetic "custom provider" on 4176 whose URL path is a secret
// (test/support/e2e-servers.ts). Checks the settings lifecycle — test, use under the self-hosted
// exception, wrong-genesis refusal, clear, reload — and that the secret never reaches the page, the
// address bar, browser storage or the console.
import { expect, test, type Page } from '@playwright/test';
import { E2E_PROVIDER, E2E_RPC_SECRET } from '../support/e2e-constants';

const SIDECAR = 'http://127.0.0.1:4175';
const CUSTOM = `${E2E_PROVIDER}/rpc/${E2E_RPC_SECRET}`;
const OTHER_GENESIS = `${E2E_PROVIDER}/other/${E2E_RPC_SECRET}`;
test.describe.configure({ mode: 'serial', timeout: 240_000 }); // probes run a real anvil fork check
const external: string[] = [];
const consoleText: string[] = [];

async function open(page: Page) {
  await page.goto(`${SIDECAR}/recover`);
  await openSheet(page);
}

/** The RPC panel lives in a sheet opened from the top bar's endpoint chip. */
async function openSheet(page: Page) {
  await page.getByTestId('top-rpc').click();
  await expect(page.getByTestId('rpc-active')).toBeVisible();
}

/** The secret must not be anywhere the page or browser keeps state. */
async function expectNoSecret(page: Page) {
  const leaks = await page.evaluate((s) => {
    const inputs = [...document.querySelectorAll('input')].map((i) => i.value).join('\n');
    return {
      html: document.documentElement.outerHTML.includes(s),
      inputs: inputs.includes(s),
      url: location.href.includes(s),
      local: localStorage.length,
      session: sessionStorage.length,
    };
  }, E2E_RPC_SECRET);
  expect(leaks).toEqual({ html: false, inputs: false, url: false, local: 0, session: 0 });
  expect(consoleText.filter((t) => t.includes(E2E_RPC_SECRET))).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  external.length = 0;
  page.on('console', (m) => consoleText.push(m.text()));
  // The page itself may talk only to the sidecar; the provider stand-in is reached by the sidecar, not the browser.
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4175\/).*/, (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
});
test.afterEach(() => expect(external).toEqual([]));

test('English by default with a 繁中 toggle that sets the panel language', async ({ page }) => {
  await open(page);
  const panel = page.getByTestId('rpc-settings');
  const sheet = page.getByTestId('sheet-rpc');
  await expect(panel).toHaveAttribute('lang', 'en');
  await expect(sheet.getByRole('heading', { name: 'RPC endpoint' })).toBeVisible();
  await expect(page.getByTestId('rpc-masked')).toHaveText(/^http:\/\/127\.0\.0\.1:\d+\/…$/);
  // The language toggle sits under the modal sheet: close, switch, reopen.
  await page.keyboard.press('Escape');
  await page.getByTestId('lang-toggle').click();
  await openSheet(page);
  await expect(panel).toHaveAttribute('lang', 'zh-Hant-TW');
  await expect(sheet.getByRole('heading', { name: 'RPC 端點' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('lang-toggle').click();
  await openSheet(page);
  await expect(sheet.getByRole('heading', { name: 'RPC endpoint' })).toBeVisible();
});

test('checking the testchain runs every capability; broadcast is never tested', async ({ page }) => {
  await open(page);
  await page.getByTestId('rpc-check').click();
  const log = page.getByTestId('cap-log');
  await expect(log.locator('[data-cap="fork"]')).toHaveAttribute('data-status', 'ok', { timeout: 120_000 });
  await expect(log.locator('[data-cap="chain"]')).toHaveAttribute('data-status', 'ok');
  await expect(log.locator('[data-cap="broadcast"]')).toHaveAttribute('data-status', 'not-probed');
  await expect(page.getByTestId('rpc-overall')).toHaveText('Ready for checks and simulation');
});

test('a private address is refused without the exception; the phrase gates the buttons', async ({ page }) => {
  await open(page);
  await page.getByTestId('rpc-url').fill(CUSTOM);
  await expect(page.getByTestId('rpc-url')).toHaveAttribute('type', 'password');
  await expect(page.getByTestId('rpc-url')).toHaveAttribute('autocomplete', 'off');
  await page.getByTestId('rpc-test').click();
  await expect(page.getByTestId('rpc-notice')).toContainText(/Not changed: .*(local|private|exception)/i);
  await page.getByTestId('rpc-local').check();
  await expect(page.getByTestId('rpc-use')).toBeDisabled();
  await page.getByTestId('rpc-phrase').fill('my own node');
  await expect(page.getByTestId('rpc-use')).toBeDisabled();
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'base');
  // The input still holds the URL here, by design; storage and the address bar never do.
  expect(await page.evaluate((s) => [location.href.includes(s), localStorage.length, sessionStorage.length], E2E_RPC_SECRET)).toEqual([false, 0, 0]);
});

test('use, refuse another genesis, clear, and a reload drops the custom endpoint', async ({ page, request }) => {
  await open(page);
  await page.getByTestId('rpc-url').fill(CUSTOM);
  await page.getByTestId('rpc-local').check();
  await page.getByTestId('rpc-phrase').fill('MY OWN NODE');
  await page.getByTestId('rpc-use').click();
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'custom', { timeout: 120_000 });
  await expect(page.getByTestId('rpc-masked')).toHaveText('http://127.0.0.1:4176/…');
  await expect(page.getByTestId('local-banner')).toBeVisible();
  await expect(page.getByTestId('rpc-url')).toHaveValue('');
  // The switch voids unsent plans, but never claims nothing was sent: a wallet request may already be out.
  await expect(page.getByTestId('rpc-changed')).toContainText('Anything your wallet already sent is not undone');
  await expect(page.getByTestId('rpc-changed')).not.toContainText('Nothing was sent');
  // UX-1: dismissing the warning leaves a quiet, timed line, not nothing.
  await page.getByTestId('sheet-rpc-close').click();
  await page.getByTestId('rpc-changed-close').click();
  await expect(page.getByTestId('rpc-changed')).toHaveCount(0);
  await expect(page.getByTestId('rpc-changed-note')).toContainText('The RPC endpoint changed at');
  await openSheet(page);
  await expectNoSecret(page);
  const hits = (await (await request.get(`${E2E_PROVIDER}/hits`)).json()) as { rpc: number; other: number; bad: number };
  expect(hits.rpc).toBeGreaterThan(0);
  expect(hits.bad).toBe(0);

  // Same chainId, another genesis: refused, still on the custom endpoint.
  await page.getByTestId('rpc-url').fill(OTHER_GENESIS);
  await page.getByTestId('rpc-local').check();
  await page.getByTestId('rpc-phrase').fill('MY OWN NODE');
  await page.getByTestId('rpc-use').click();
  await expect(page.getByTestId('rpc-notice')).toContainText(/different genesis/, { timeout: 60_000 });
  await expect(page.getByTestId('rpc-masked')).toHaveText('http://127.0.0.1:4176/…');
  await page.getByTestId('rpc-url').fill('');

  await page.getByTestId('rpc-clear').click();
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'base');
  await expect(page.getByTestId('rpc-notice')).toHaveText('Cleared. Back to the default endpoint.');
  await expect(page.getByTestId('local-banner')).toHaveCount(0);

  // Use again, then reload: a new page session starts on the default endpoint.
  await page.getByTestId('rpc-url').fill(CUSTOM);
  await page.getByTestId('rpc-local').check();
  await page.getByTestId('rpc-phrase').fill('MY OWN NODE');
  await page.getByTestId('rpc-use').click();
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'custom', { timeout: 120_000 });
  await page.reload();
  await openSheet(page);
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'base');
  await expectNoSecret(page);
});

test('another tab opening the tool resets the endpoint; this tab learns it on the next look and warns again', async ({ page }) => {
  await open(page);
  await page.getByTestId('rpc-url').fill(CUSTOM);
  await page.getByTestId('rpc-local').check();
  await page.getByTestId('rpc-phrase').fill('MY OWN NODE');
  await page.getByTestId('rpc-use').click();
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'custom', { timeout: 120_000 });
  await page.getByTestId('sheet-rpc-close').click();
  await page.getByTestId('rpc-changed-close').click();
  await expect(page.getByTestId('rpc-changed-note')).toBeVisible();

  // A second tab loads the tool page: the sidecar starts every page session on the default endpoint.
  const other = await page.context().newPage();
  await other.route(/^(?!http:\/\/127\.0\.0\.1:4175\/).*/, (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  await other.goto(`${SIDECAR}/recover`);
  await expect(other.locator('#current-step')).toBeVisible();
  await other.close();

  // The first tab is told, not left showing the custom endpoint as active or the old change as old news.
  await openSheet(page);
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'base');
  await expect(page.getByTestId('local-banner')).toHaveCount(0);
  await page.getByTestId('sheet-rpc-close').click();
  await expect(page.getByTestId('rpc-changed')).toBeVisible();
  await expect(page.getByTestId('rpc-changed-note')).toHaveCount(0);
  await expectNoSecret(page);
});

test('a slow first endpoint answer that arrives after a change never rolls the page back to the old endpoint', async ({ page }) => {
  // Hold the tool's first state answer (read before any change: the default endpoint) until a change has landed.
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  let held = 0;
  let delivered = false;
  await page.route(`${SIDECAR}/api/rpc/state`, async (route) => {
    if (held++ > 0) return route.fallback();
    const old = await route.fetch();
    await gate;
    await route.fulfill({ response: old });
    delivered = true;
  });
  await open(page);
  await page.getByTestId('rpc-url').fill(CUSTOM);
  await page.getByTestId('rpc-local').check();
  await page.getByTestId('rpc-phrase').fill('MY OWN NODE');
  await page.getByTestId('rpc-use').click();
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'custom', { timeout: 120_000 });
  await page.getByTestId('sheet-rpc-close').click();
  await page.getByTestId('rpc-changed-close').click();
  await expect(page.getByTestId('rpc-changed-note')).toBeVisible();
  const chip = await page.getByTestId('top-rpc').innerText();

  release();
  await expect.poll(() => delivered).toBe(true);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))));

  // The old answer is dropped: no fresh change notice, the endpoint chip unchanged, the sheet still on the custom one.
  await expect(page.getByTestId('rpc-changed')).toHaveCount(0);
  await expect(page.getByTestId('rpc-changed-note')).toBeVisible();
  await expect(page.getByTestId('top-rpc')).toHaveText(chip);
  await openSheet(page);
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'custom');
  await expectNoSecret(page);
});

test('the native signer address arriving while the first endpoint answer is in flight does not drop it: a later change still warns', async ({ page }) => {
  // The runner reports a native signer (its address is announced through the same connection signal); the
  // first endpoint answer is held until that has been applied.
  let configDone!: () => void;
  const config = new Promise<void>((r) => (configDone = r));
  await page.route(`${SIDECAR}/api/config`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    await route.fulfill({ response: res, json: { ...body, runner: { ...(body.runner ?? {}), nativeSignerUrl: SIDECAR } } });
    configDone();
  });
  let held = 0;
  let delivered = false;
  await page.route(`${SIDECAR}/api/rpc/state`, async (route) => {
    if (held++ > 0) return route.fallback();
    const first = await route.fetch();
    await config;
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 50))));
    await route.fulfill({ response: first });
    delivered = true;
  });
  await page.goto(`${SIDECAR}/recover`);
  await expect(page.locator('#current-step')).toBeVisible();
  await expect.poll(() => delivered).toBe(true);

  // Another tab puts a custom endpoint in use; this tab's next look must call it a change.
  const other = await page.context().newPage();
  await other.route(/^(?!http:\/\/127\.0\.0\.1:4175\/).*/, (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  await open(other);
  await other.getByTestId('rpc-url').fill(CUSTOM);
  await other.getByTestId('rpc-local').check();
  await other.getByTestId('rpc-phrase').fill('MY OWN NODE');
  await other.getByTestId('rpc-use').click();
  await expect(other.getByTestId('rpc-active')).toHaveAttribute('data-active', 'custom', { timeout: 120_000 });
  await other.close();
  await openSheet(page);
  await expect(page.getByTestId('rpc-active')).toHaveAttribute('data-active', 'custom');
  await page.getByTestId('sheet-rpc-close').click();
  await expect(page.getByTestId('rpc-changed')).toBeVisible();
});
