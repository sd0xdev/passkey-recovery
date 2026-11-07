// UX behaviours (UX-03/04/05, behaviours 2/3/7/8/9/10) on the real built pages, SYNTHETIC only: the capability
// strip on the runner page and the website, step intros, sound opt-in with a FAKE AudioContext (no real audio
// ever plays), reduced motion on the live-status bar, the copy button when the browser refuses, the pairing
// errors, and the 1440 / 768 / 390 layouts in English and 繁中 (axe clean, no sideways scroll). Screenshots
// go to E2E_SHOT_DIR when it is set.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { E2E_HOSTED, E2E_PROVIDER, E2E_RUNNER, E2E_SIGNER, type E2eWorld } from '../support/e2e-constants';
import { fakeAudio, type AudioLog } from '../support/fakeAudio';
import { encryptKeystore } from '../fixtures/keystore';

test.describe.configure({ timeout: 120_000 });
const SHOTS = process.env.E2E_SHOT_DIR;
const ALLOW = /^https?:\/\/127\.0\.0\.1:41(77|78|79)\//;

async function open(browser: Browser, url: string, o: { reducedMotion?: 'reduce' | 'no-preference'; width?: number } = {}) {
  const ctx = await browser.newContext({ reducedMotion: o.reducedMotion ?? 'no-preference', viewport: { width: o.width ?? 1440, height: 1000 } });
  const page = await ctx.newPage();
  const external: string[] = [];
  await page.route((u) => !ALLOW.test(u.href) && u.href !== 'about:blank', (r) => (external.push(r.request().url()), r.abort('blockedbyclient')));
  await page.addInitScript(fakeAudio);
  await page.goto(url);
  return { page, ctx, external };
}
const audio = (p: Page) => p.evaluate(() => (window as unknown as { __audio: AudioLog }).__audio);
const axe = async (p: Page, label: string) => {
  const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
};
const noSideways = async (p: Page) => expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

test('runner page: the strip says who does what, with no pairing asked; each open step says what, why and afterwards', async ({ browser }) => {
  const { page, ctx, external } = await open(browser, `${E2E_RUNNER}/recover`);
  const caps = page.getByTestId('caps');
  await expect(caps.locator('[data-cap]')).toHaveCount(5);
  await expect(caps.locator('[data-cap="ui"]')).toContainText(`Served by the runner on this computer (${E2E_RUNNER})`);
  await expect(caps.locator('[data-cap="runner"]')).toHaveAttribute('data-ok', 'true');
  await expect(caps.locator('[data-cap="runner"]')).toContainText('no pairing needed');
  await expect(caps.locator('[data-cap="sim"]')).toContainText('runner’s local fork');
  await expect(caps.locator('[data-cap="spend"]')).toContainText('Only when you confirm a deploy step or a send');
  await expect(page.getByTestId('top-pair')).toHaveCount(0);
  await expect(page.getByTestId('caps-pair')).toHaveCount(0);
  // Not ready is said in words and by the hollow mark, not by colour alone.
  const payer = caps.locator('[data-cap="payer"]');
  await expect(payer).toHaveAttribute('data-ok', 'false');
  await expect(payer.locator('.lb-caps-mark')).toHaveText('○');
  await expect(page.getByTestId('intro-check').locator('dt')).toHaveText(['This step', 'Why', 'Afterwards']);
  // The payer row opens the gas sheet.
  await page.getByTestId('caps-payer').click();
  await expect(page.getByTestId('sheet-gas')).toBeVisible();
  expect(external).toEqual([]);
  await ctx.close();
});

test('website, unpaired: the strip says the page alone cannot read the chain and offers Connect runner', async ({ browser }) => {
  const { page, ctx, external } = await open(browser, `${E2E_HOSTED}/recover`);
  const caps = page.getByTestId('caps');
  await expect(caps.locator('[data-cap="ui"]')).toContainText('the page only');
  await expect(caps.locator('[data-cap="runner"]')).toHaveAttribute('data-ok', 'false');
  await expect(caps.locator('[data-cap="sim"]')).toContainText('nothing is simulated on a server');
  // UX-03 regression: with no runner the check is blocked and says why — never shown as "checking…".
  await expect(page.getByTestId('check-blocked')).toContainText('Checking needs the runner');
  await expect(page.getByTestId('check-busy')).toHaveCount(0);
  await expect(page.getByTestId('check-run')).toBeDisabled();
  await expect(page.getByTestId('check-run')).not.toContainText('Checking');
  await page.getByTestId('caps-pair').click();
  await expect(page.getByTestId('sheet-pair')).toBeVisible();
  // Specific next steps: the command for a built clone (no package file is published), then wait for the code, then Connect.
  await expect(page.getByTestId('pair-command')).toContainText('npm run runner --');
  await expect(page.getByTestId('pair-command')).not.toContainText('.tgz');
  await expect(page.getByTestId('pair-steps-link')).toHaveAttribute('href', '/download');
  // The website is https: the command allowlists exactly this origin (the http case is a static preview with no
  // pairing at all — runner-preview.spec.ts, RUN-3).
  await expect(page.getByTestId('pair-command')).toContainText(`--allow-origin ${new URL(E2E_HOSTED).origin}`);
  await expect(page.getByTestId('pair-http')).toHaveCount(0);
  await expect(page.locator('.lb-pair-steps li')).toHaveCount(3);
  expect(external).toEqual([]);
  await ctx.close();
});

// Synthetic, well-formed and never funded: the reads below are refused before they reach the runner.
const SOME_ACCOUNT = '0x00000000000000000000000000000000000c0ffe';

test('regression: the runner that served the page stops answering → strip and Check say so, typing stays; Check again recovers in place', async ({ browser }) => {
  const { page, ctx } = await open(browser, `${E2E_RUNNER}/recover`);
  const runner = page.getByTestId('caps').locator('[data-cap="runner"]');
  await expect(runner).toHaveAttribute('data-ok', 'true');
  // The runner process is gone: every call to it fails at the network layer.
  await page.route(`${E2E_RUNNER}/api/**`, (r) => r.abort('connectionrefused'));
  await page.getByTestId('check-account').fill(SOME_ACCOUNT);
  await page.getByTestId('check-run').click();
  await expect(runner).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('caps-lost')).toContainText('Start it again in its Terminal');
  await expect(page.getByTestId('no-sidecar')).toContainText('stopped answering');
  await expect(page.getByTestId('no-sidecar')).not.toContainText('npm start');
  await expect(page.getByTestId('check-blocked')).toBeVisible();
  await expect(page.getByTestId('check-account')).toHaveValue(SOME_ACCOUNT);
  // Still down: said so, nothing else changes.
  await page.getByTestId('caps-retry').click();
  await expect(page.getByTestId('caps-still-lost')).toBeVisible();
  // A restarted runner no longer knows this page's session: only then is a reload asked for.
  await page.unroute(`${E2E_RUNNER}/api/**`);
  await page.route(`${E2E_RUNNER}/api/**`, (r) => r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'missing or stale session (reload the page)' }) }));
  await page.getByTestId('caps-retry').click();
  await expect(page.getByTestId('caps-reload')).toContainText('Reload this page');
  // Back (same runner): connected again without a reload, the typing still there.
  await page.unroute(`${E2E_RUNNER}/api/**`);
  await page.getByTestId('caps-retry').click();
  await expect(runner).toHaveAttribute('data-ok', 'true');
  await expect(runner).toContainText('no pairing needed');
  await expect(page.getByTestId('no-sidecar')).toHaveCount(0);
  await expect(page.getByTestId('check-account')).toHaveValue(SOME_ACCOUNT);
  await axe(page, 'runner-back');
  await ctx.close();
});

test('regression: the runner\'s signer stops answering (a gas-payer call) → the strip says the runner is lost; Check again recovers', async ({ browser }) => {
  const { page, ctx } = await open(browser, `${E2E_RUNNER}/recover`);
  const runner = page.getByTestId('caps').locator('[data-cap="runner"]');
  await expect(runner).toHaveAttribute('data-ok', 'true');
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-op').check();
  // Only the signer half of the runner fails here: the call is a gas-payer one, never the sidecar's.
  await page.route(`${E2E_SIGNER}/gas/**`, (r) => r.abort('connectionrefused'));
  await page.getByTestId('gas-op-link').fill('op://Synthetic Vault/Synthetic Item');
  await page.getByTestId('gas-op-inspect').click();
  await expect(runner).toHaveAttribute('data-ok', 'false');
  await expect(page.getByTestId('caps-lost')).toContainText('Start it again in its Terminal');
  await page.unroute(`${E2E_SIGNER}/gas/**`);
  await page.getByTestId('sheet-gas-close').click();
  await page.getByTestId('caps-retry').click();
  await expect(runner).toHaveAttribute('data-ok', 'true');
  await axe(page, 'signer-back');
  await ctx.close();
});

test('regression: a paired runner that stops answering ends the pairing → Not connected, how to reconnect, typing kept', async ({ browser }) => {
  const { code } = (await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string };
  const { page, ctx } = await open(browser, `${E2E_HOSTED}/recover`);
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-advanced').locator('summary').click();
  await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
  await page.getByTestId('pair-code').fill(code);
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('sheet-pair')).toBeHidden();
  const runner = page.getByTestId('caps').locator('[data-cap="runner"]');
  await expect(runner).toContainText('Connected:');
  await page.route(`${E2E_RUNNER}/api/**`, (r) => r.abort('connectionrefused'));
  await page.getByTestId('check-account').fill(SOME_ACCOUNT);
  await page.getByTestId('check-run').click();
  await expect(runner).toHaveAttribute('data-ok', 'false');
  await expect(runner).not.toContainText('Connected:');
  await expect(page.getByTestId('caps-pair')).toBeVisible();
  await expect(page.getByTestId('app-notice')).toContainText('stopped answering');
  await expect(page.getByTestId('app-notice')).toContainText('Connect runner');
  await expect(page.getByTestId('check-account')).toHaveValue(SOME_ACCOUNT);
  await page.unroute(`${E2E_RUNNER}/api/**`);
  // Started again (a new code) and paired again: the account typed is still there, as the notice says.
  const again = ((await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string }).code;
  await page.getByTestId('caps-pair').click();
  await page.getByTestId('pair-advanced').locator('summary').click();
  await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
  await page.getByTestId('pair-code').fill(again);
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('sheet-pair')).toBeHidden();
  await expect(runner).toContainText('Connected:');
  await expect(page.getByTestId('check-account')).toHaveValue(SOME_ACCOUNT);
  await ctx.close();
});

test('regression: a late config answer for an earlier pairing leaves the new pairing\'s native signer on', async ({ browser }) => {
  const restart = async () => ((await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string }).code;
  const { page, ctx } = await open(browser, `${E2E_HOSTED}/recover`);
  const connect = async (code: string) => {
    await page.getByTestId('top-pair').click();
    await page.getByTestId('pair-advanced').locator('summary').click();
    await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
    await page.getByTestId('pair-code').fill(code);
    await page.getByTestId('pair-submit').click();
    await expect(page.getByTestId('sheet-pair')).toBeHidden();
  };
  // The first pairing's config read is held back.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  await page.route(`${E2E_RUNNER}/api/config`, async (r) => {
    if (!first) return r.fallback();
    first = false;
    await held;
    return r.fallback();
  });
  await connect(await restart());
  // Disconnect, the runner restarts (the first pairing is now unknown to it: 401), pair again.
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-disconnect').click();
  await page.getByTestId('sheet-pair-close').click();
  await connect(await restart());
  await page.getByTestId('wallet-none').click();
  await expect(page.getByTestId('gas-mode-native-op')).toBeEnabled();
  await page.getByTestId('sheet-gas-close').click();
  // The first pairing's answer arrives now (refused: 401) and must not switch the new pairing's signer off.
  const late = page.waitForResponse(`${E2E_RUNNER}/api/config`);
  release();
  expect((await late).status()).toBe(401);
  await page.waitForTimeout(300);
  await page.getByTestId('wallet-none').click();
  await expect(page.getByTestId('gas-mode-native-op')).toBeEnabled();
  await expect(page.getByTestId('caps').locator('[data-cap="runner"]')).toContainText('Connected:');
  await page.unroute(`${E2E_RUNNER}/api/config`);
  await ctx.close();
});

test('regression: a Check answer read through an earlier pairing is dropped after the runner restarts and is paired again', async ({ browser }) => {
  const restart = async () => ((await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string }).code;
  const { page, ctx } = await open(browser, `${E2E_HOSTED}/recover`);
  const connect = async (code: string) => {
    await page.getByTestId('top-pair').click();
    await page.getByTestId('pair-advanced').locator('summary').click();
    await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
    await page.getByTestId('pair-code').fill(code);
    await page.getByTestId('pair-submit').click();
    await expect(page.getByTestId('sheet-pair')).toBeHidden();
  };
  await connect(await restart());
  // The first pairing's check is answered by that runner, then held back.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let answered = false;
  let delivered = false;
  await page.route(`${E2E_RUNNER}/api/diagnose`, async (r) => {
    const old = await r.fetch();
    answered = old.ok();
    await held;
    await r.fulfill({ response: old });
    delivered = true;
  }, { times: 1 });
  await page.getByTestId('check-account').fill(SOME_ACCOUNT);
  await page.getByTestId('check-run').click();
  await expect.poll(() => answered).toBe(true);
  // Disconnect, the runner restarts (its endpoint epoch starts again), pair again.
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-disconnect').click();
  await page.getByTestId('sheet-pair-close').click();
  await connect(await restart());
  release();
  await expect.poll(() => delivered).toBe(true);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))));
  // The old answer is not this connection's diagnosis: Check is still the step to do, the account still typed.
  await expect(page.getByTestId('diagnosis')).toHaveCount(0);
  await expect(page.locator('li[data-step="check"]')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('check-account')).toHaveValue(SOME_ACCOUNT);
  await ctx.close();
});

test('regression: a finished Check is void after the runner restarts at the same RPC epoch and is paired again; Deploy and Move wait for a new Check', async ({ browser }) => {
  const world = (await (await fetch(`${E2E_PROVIDER}/world`)).json()) as E2eWorld;
  const a = world.accounts.C;
  const restart = async () => ((await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string }).code;
  const { page, ctx } = await open(browser, `${E2E_HOSTED}/recover`);
  // Pair and return the endpoint epoch the new connection reads first.
  const connect = async (code: string) => {
    const state = page.waitForResponse((r) => r.url() === `${E2E_RUNNER}/api/rpc/state`);
    await page.getByTestId('top-pair').click();
    await page.getByTestId('pair-advanced').locator('summary').click();
    await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
    await page.getByTestId('pair-code').fill(code);
    await page.getByTestId('pair-submit').click();
    await expect(page.getByTestId('sheet-pair')).toBeHidden();
    return ((await (await state).json()) as { epoch: number }).epoch;
  };
  const first = await connect(await restart());
  await page.getByTestId('check-account').fill(a.address);
  await page.getByTestId('check-evidence-toggle').click();
  await page.getByTestId('check-owners').fill(a.owners.join('\n'));
  await page.getByTestId('check-nonce').fill(a.nonce);
  await page.getByTestId('check-run').click();
  await expect(page.locator('li[data-step="check"]')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
  // The check opened the next step (Deploy for this undeployed account, else Move).
  const opened = page.locator('li[data-step="deploy"][data-state="current"], li[data-step="move"][data-state="current"]');
  await expect(opened).toHaveCount(1);

  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-disconnect').click();
  await page.getByTestId('sheet-pair-close').click();
  // Same epoch on purpose: only the connection changed, so the epoch path cannot be what voids the Check.
  expect(await connect(await restart())).toBe(first);

  await expect(page.getByTestId('diagnosis')).toHaveCount(0);
  await expect(page.locator('li[data-step="check"]')).toHaveAttribute('data-state', 'current');
  await expect(opened).toHaveCount(0);
  await expect(page.locator('li[data-step="move"]')).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByTestId('check-account')).toHaveValue(a.address);
  await ctx.close();
});

test('pairing errors are specific and keep what was typed: bad code shape, nobody at the address, then a refused copy', async ({ browser }) => {
  const { page, ctx } = await open(browser, `${E2E_HOSTED}/recover`);
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-code').fill('ABC-12');
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('pair-error')).toContainText('eight letters and digits');
  // A port nobody listens on (loopback only; nothing is scanned): the message names the address and the fix.
  await page.getByTestId('pair-advanced').locator('summary').click();
  await page.getByTestId('pair-url').fill('http://127.0.0.1:4199/');
  await page.getByTestId('pair-code').fill('ABCD-1234');
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('pair-error')).toContainText('No runner answered at http://127.0.0.1:4199');
  await expect(page.getByTestId('pair-code')).toHaveValue('ABCD-1234');
  // The browser refuses the clipboard: said so, and the command stays selectable on screen.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) }, configurable: true }));
  await page.getByTestId('pair-copy').click();
  await expect(page.getByTestId('pair-copy-blocked')).toContainText('blocked copying');
  await expect(page.getByTestId('pair-command')).toBeVisible();
  // PM-08: the exact command is offered for copying by hand, selected on focus.
  const command = ((await page.getByTestId('pair-command').textContent()) ?? '').trim();
  expect(command).not.toBe('');
  await expect(page.getByTestId('pair-copy-manual')).toHaveValue(command);
  await page.getByTestId('pair-copy-manual').focus();
  expect(await page.getByTestId('pair-copy-manual').evaluate((e: HTMLTextAreaElement) => e.value.slice(e.selectionStart, e.selectionEnd))).toBe(command);
  // No Clipboard API at all: a failure too, never a silent "Copied".
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }));
  await page.getByTestId('pair-copy').click();
  await expect(page.getByTestId('pair-copy')).toHaveAttribute('data-copy', 'blocked');
  await expect(page.getByTestId('pair-copy-manual')).toHaveValue(command);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.resolve() }, configurable: true }));
  await page.getByTestId('pair-copy').click();
  await expect(page.getByTestId('pair-copy')).toHaveAttribute('data-copy', 'ok');
  await expect(page.getByTestId('pair-copy')).toHaveText('Copied');
  await expect(page.getByTestId('pair-copy-manual')).toHaveCount(0);
  await ctx.close();
});

test('live status: a long Check says what it is doing and for how long; after 20 s it says it is still working (no percentage)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await ctx.newPage();
  await page.route((u) => !ALLOW.test(u.href) && u.href !== 'about:blank', (r) => r.abort('blockedbyclient'));
  await page.clock.install();
  await page.goto(`${E2E_RUNNER}/recover`);
  await expect(page.getByTestId('caps').locator('[data-cap="runner"]')).toHaveAttribute('data-ok', 'true');
  // The runner's answer is held: the Check stays in progress while the page clock moves on.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`${E2E_RUNNER}/api/**`, async (r) => {
    await held;
    await r.fallback();
  });
  await page.getByTestId('check-account').fill(SOME_ACCOUNT);
  await page.getByTestId('check-run').click();
  const busy = page.getByTestId('check-busy');
  await expect(busy).toHaveAttribute('role', 'status');
  // No creation evidence: the Check only reads the chain, and its lines say so — never a fork simulation (PM-09).
  await expect(busy).toContainText('Reading the account on chain…');
  await expect(busy).not.toContainText('Still working');
  await page.clock.runFor(21_000);
  await expect(busy).toHaveAttribute('data-elapsed', /^2\d$/);
  await expect(page.getByTestId('check-busy-slow')).toHaveAttribute('data-slow', 'other');
  await expect(busy).toContainText('Still working.');
  await expect(busy).not.toContainText(/fork|%/);
  release();
  await page.unroute(`${E2E_RUNNER}/api/**`);
  await expect(busy).toHaveCount(0, { timeout: 60_000 });
  // With creation evidence a fork simulation may run when the chain alone cannot answer: those lines say "may".
  let release2!: () => void;
  const held2 = new Promise<void>((r) => (release2 = r));
  await page.route(`${E2E_RUNNER}/api/**`, async (r) => {
    await held2;
    await r.fallback();
  });
  if (await page.getByTestId('check-edit').count()) await page.getByTestId('check-edit').click();
  await page.getByTestId('check-evidence-toggle').click();
  await page.getByTestId('check-owners').fill(SOME_ACCOUNT);
  await page.getByTestId('check-run').click();
  await expect(busy).toContainText('Checking on chain (a local fork may be used when needed)…');
  await page.clock.runFor(21_000);
  await expect(page.getByTestId('check-busy-slow')).toHaveAttribute('data-slow', 'maybeSim');
  await expect(busy).toContainText('When it is needed, the check simulates on a local fork');
  release2();
  await page.unroute(`${E2E_RUNNER}/api/**`);
  await expect(busy).toHaveCount(0, { timeout: 60_000 });
  await ctx.close();
});

test('website, browser File payer: a wrong File password is refused and nothing is installed; the right one opens it', async ({ browser }) => {
  const { page, ctx } = await open(browser, `${E2E_HOSTED}/recover`);
  // SYNTHETIC keystore of a random key, written to a fresh temp directory.
  const dir = mkdtempSync(join(tmpdir(), 'cbpr-e2e-wrongpw-'));
  const path = join(dir, 'gas.json');
  const pw = 'synthetic e2e website file pass';
  writeFileSync(path, encryptKeystore(randomBytes(32), pw));
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-browser-file').check();
  await page.getByTestId('gas-file-input').setInputFiles(path);
  await page.getByTestId('gas-file-password').fill('synthetic e2e wrong pass');
  await page.getByTestId('gas-file-open').click();
  await expect(page.getByTestId('gas-error')).toContainText('Wrong password for this keystore.', { timeout: 60_000 });
  await expect(page.getByTestId('gas-address')).toHaveCount(0);
  // The chosen file stays: only the password is typed again.
  await page.getByTestId('gas-file-password').fill(pw);
  await page.getByTestId('gas-file-open').click();
  await expect(page.getByTestId('gas-address')).toHaveAttribute('data-value', /^0x[0-9a-fA-F]{40}$/, { timeout: 60_000 });
  await expect(page.getByTestId('gas-error')).toHaveCount(0);
  await ctx.close();
});

test('sound: off by default with no audio context; the toggle click starts it with one preview; a reload is silent and off again', async ({ browser }) => {
  const { page, ctx } = await open(browser, `${E2E_RUNNER}/recover`);
  const toggle = page.getByTestId('sound-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(await audio(page)).toEqual({ created: 0, resumed: 0, notes: [], kinds: [] });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await audio(page)).toMatchObject({ created: 1, resumed: 1 });
  expect((await audio(page)).notes).toHaveLength(2);
  // Off again: nothing more plays.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect((await audio(page)).notes).toHaveLength(2);
  // Not persisted: a reload starts off, with no context.
  await page.reload();
  await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(await audio(page)).toEqual({ created: 0, resumed: 0, notes: [], kinds: [] });
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))).not.toMatch(/sound/i);
  // The control is a named toggle for screen readers in both languages.
  await expect(page.getByTestId('sound-toggle')).toHaveAccessibleName(/Sound off.*Short sounds/);
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('sound-toggle')).toHaveAccessibleName(/音效：關.*提示音/);
  await ctx.close();
});

test('motion: the live-status bar moves only without reduced motion; under reduce it and the step-open are still', async ({ browser }) => {
  // The tool is a lazy chunk: probe once its open step is on the page.
  const probe = async (p: Page) => {
    await p.locator('.lb-step-current .lb-step-body').waitFor();
    return p.evaluate(() => {
      const host = document.querySelector('.logbook')!;
      const busy = document.createElement('div');
      busy.className = 'lb-busy';
      busy.innerHTML = '<span class="lb-busy-bar"></span>';
      host.appendChild(busy);
      const bar = busy.querySelector('.lb-busy-bar')!;
      const body = document.querySelector('.lb-step-current .lb-step-body');
      const r = { bar: getComputedStyle(bar, '::after').animationName, open: body ? getComputedStyle(body).animationName : 'none' };
      busy.remove();
      return r;
    });
  };
  const moving = await open(browser, `${E2E_RUNNER}/recover`);
  expect(await probe(moving.page)).toEqual({ bar: 'lb-tide', open: 'lb-open' });
  await moving.ctx.close();
  const still = await open(browser, `${E2E_RUNNER}/recover`, { reducedMotion: 'reduce' });
  expect(await probe(still.page)).toEqual({ bar: 'none', open: 'none' });
  await still.ctx.close();
});

for (const width of [1440, 768, 390]) {
  test(`layout ${width}: strip, intro and pair sheet readable in English and 繁中, axe clean, no sideways scroll`, async ({ browser }) => {
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    const { page, ctx } = await open(browser, `${E2E_HOSTED}/recover`, { width });
    for (const lang of ['en', 'zh'] as const) {
      if (lang === 'zh') await page.getByTestId('lang-toggle').click();
      await expect(page.getByTestId('caps')).toBeVisible();
      await axe(page, `ux-start-${width}-${lang}`);
      await noSideways(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/ux-start-${width}-${lang}.png`, fullPage: true });
      await page.getByTestId('top-pair').click();
      await expect(page.getByTestId('sheet-pair')).toBeVisible();
      await axe(page, `ux-pair-${width}-${lang}`);
      await noSideways(page);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/ux-pair-${width}-${lang}.png` });
      await page.getByTestId('sheet-pair-close').click();
    }
    await ctx.close();
  });
}
