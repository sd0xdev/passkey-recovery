// The gas sheet against the runtime it really talks to (request 2026-11-01-gas-runtime-ux):
//   • an older native signer (no `api` in /gas/status, no /gas/keystore/unlock — what a runner started before an
//     update answers) gets update guidance before any unlock, never a raw "unknown endpoint"; a newer one asks
//     for a reload; once the runner answers the current contract, the same form opens the keystore;
//   • the hosted page paired with the runner opens both chosen-keystore sources (a path field of the item, a
//     picked file): data goes only to the paired signer, the derived address is the gas payer, and a wrong
//     password field or a wrong file is a recoverable error;
//   • disconnecting (hosted) forgets the earlier signer's key and version at once, and an unlock still waiting on it
//     leaves nothing in the new pairing; status reads are ordered (a late earlier read never wins); an unlock or a
//     confirmation that fails after the sheet was closed and opened again still shows why on the reopened form;
//   • the layout: whole-row options, the chosen one marked in words, the stage ledger, keyboard focus, no
//     horizontal overflow with long EN / 繁中 copy and a long file name at 1440 / 768 / 390.
// Nothing real: SYNTHETIC keystores and items answered by the fake `op`, testchain mode.
import AxeBuilder from '@axe-core/playwright';
import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { SIGNER_API } from '../../src/config/signerApi';
import { E2E_HOSTED, E2E_PROVIDER, E2E_RUNNER, E2E_SIGNER, type E2eWorld } from '../support/e2e-constants';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

let world: E2eWorld;
const opened: BrowserContext[] = [];
const external: string[] = [];
const sent: Array<{ url: string; body: string }> = [];
const carrying = (needle: string) => [...new Set(sent.filter((r) => r.body.includes(needle)).map((r) => new URL(r.url).origin))];

test.beforeAll(async () => {
  world = (await (await fetch(`${E2E_PROVIDER}/world`)).json()) as E2eWorld;
});
test.afterAll(async () => {
  expect(external).toEqual([]);
  for (const c of opened) await c.close();
});

async function openAt(browser: Browser, url: string, allow: RegExp, viewport = { width: 1440, height: 1600 }): Promise<Page> {
  const ctx = await browser.newContext({ viewport });
  opened.push(ctx);
  const page = await ctx.newPage();
  page.on('request', (r) => sent.push({ url: r.url(), body: r.postData() ?? '' }));
  await page.route((u) => !allow.test(u.href.replace(/^blob:/, '')), (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  await page.goto(url);
  return page;
}

/** An older signer: its status has no `api` (or a given one), and it may not know the chosen-keystore endpoint. */
async function signerSays(page: Page, api: number | null) {
  await page.route(`${E2E_SIGNER}/gas/status`, async (r) => {
    const res = await r.fetch();
    const j = (await res.json()) as Record<string, unknown>;
    if (api === null) delete j.api;
    else j.api = api;
    return r.fulfill({ response: res, json: j });
  });
}
const noUnlockEndpoint = (page: Page) => page.route(`${E2E_SIGNER}/gas/keystore/unlock`, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unknown endpoint' }) }));

/** Locks the shared signer from the sheet so no later test starts with a key installed. */
async function lockFromChip(page: Page) {
  await page.getByTestId('gas-chip').click();
  await page.getByTestId('gas-lock').click();
  await page.getByTestId('sheet-gas-close').click();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
}

test('an older signer (started before an update): update guidance before any unlock in EN and 繁中, never “unknown endpoint”; a newer one asks for a reload; the current one opens the keystore (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, 'about:blank', /^http:\/\/127\.0\.0\.1:417[78]\//);
  await signerSays(page, null);
  await page.goto(`${E2E_RUNNER}/recover`);
  await page.getByTestId('wallet-none').click();
  const compat = page.getByTestId('gas-compat');
  await expect(compat).toHaveAttribute('data-compat', 'runner-older');
  await expect(compat).toContainText('in a source checkout run npm run build, then npm run runner');
  await expect(compat).toContainText(`runner 1, page ${SIGNER_API}`);
  // Every native mode waits for the update; the browser modes stay usable.
  for (const m of ['native-op', 'native-keystore', 'native-file']) await expect(page.getByTestId(`gas-mode-${m}`)).toBeDisabled();
  await expect(page.locator('.lb-option', { has: page.getByTestId('gas-mode-native-keystore') })).toContainText('Update the local runner first');
  await expect(page.getByTestId('gas-mode-browser-file')).toBeEnabled();
  await page.getByTestId('sheet-gas-close').click();
  await page.getByTestId('lang-toggle').click();
  await page.getByTestId('wallet-none').click();
  await expect(compat).toContainText('source checkout 先執行 npm run build，再執行 npm run runner');
  await expect(page.locator('.lb-option', { has: page.getByTestId('gas-mode-native-op') })).toContainText('請先更新本機 runner');
  await page.getByTestId('sheet-gas-close').click();
  await page.getByTestId('lang-toggle').click();

  // A signer newer than the page: it serves its startup snapshot, so the guidance restarts it.
  await page.unroute(`${E2E_SIGNER}/gas/status`);
  await signerSays(page, SIGNER_API + 1);
  await page.reload();
  await page.getByTestId('wallet-none').click();
  await expect(compat).toHaveAttribute('data-compat', 'runner-newer');
  await expect(compat).toContainText('reloading alone does not help: stop the runner (Ctrl+C in its Terminal), then in a source checkout run npm run build before npm run runner');
  await page.getByTestId('sheet-gas-close').click();

  // Status says current, but the unlock endpoint is missing (a mixed install): the open fails with the runner
  // guidance, not the raw 404 and not a password complaint; the ledger marks the open stage failed.
  await page.unroute(`${E2E_SIGNER}/gas/status`);
  await noUnlockEndpoint(page);
  await page.reload();
  await page.getByTestId('wallet-none').click();
  await expect(compat).toHaveCount(0);
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  const ks = world.chosenKeystore;
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await expect(page.getByTestId('gas-ks-stage-open')).toHaveAttribute('data-state', 'input');
  await page.getByTestId('gas-ks-open').click();
  const error = page.getByTestId('gas-error');
  await expect(error).toContainText('it is older than this page. Stop the runner (Ctrl+C in its Terminal)');
  await expect(error).not.toContainText('unknown endpoint');
  await expect(error).not.toContainText('password');
  await expect(page.getByTestId('gas-ks-stage-open')).toHaveAttribute('data-state', 'failed');
  // The runner is current again: the same choices open it; the address is confirmed, then the key is locked.
  await page.unroute(`${E2E_SIGNER}/gas/keystore/unlock`);
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-address')).toHaveAttribute('data-value', ks.address);
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'input');
  await page.getByTestId('gas-confirm').click();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-account', ks.address, { timeout: 15_000 });
  await lockFromChip(page);
  await page.close();
});

test('hosted page paired with the runner: both chosen-keystore sources open, only the paired signer gets the link and the keystore, the derived address is the gas payer, and wrong input is recoverable (synthetic)', async ({ browser }) => {
  const { code } = (await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string };
  const page = await openAt(browser, `${E2E_HOSTED}/recover`, /^https?:\/\/127\.0\.0\.1:41(77|78|79)\//);
  await expect(page.getByTestId('no-sidecar')).toBeVisible();
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-advanced').locator('summary').click();
  await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
  await page.getByTestId('pair-code').fill(code);
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('sheet-pair')).toBeHidden();
  const ks = world.chosenKeystore;
  const before = sent.length;

  // A: the path field of the item. A wrong password field first: refused, nothing unlocked, choices kept.
  await page.getByTestId('wallet-none').click();
  await expect(page.getByTestId('gas-compat')).toHaveCount(0);
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('notesPlain');
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-error')).toContainText('does not open this keystore. Nothing was unlocked.');
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await expect(page.getByTestId('gas-ks-path-field')).toHaveValue('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-derived')).toHaveAttribute('data-confirmed', 'false');
  await expect(page.getByTestId('gas-address')).toHaveAttribute('data-value', ks.address);
  await page.getByTestId('gas-confirm').click();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  // The gas payer is exactly the derived address.
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-account', ks.address);
  await lockFromChip(page);

  // B: a picked file. Not a keystore first: refused; then the keystore file opens the same address.
  await page.getByTestId('gas-chip').click();
  await page.getByTestId('gas-ks-from-file').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-pick').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"synthetic":"not a keystore"}') });
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-error')).toContainText('not a version 3 keystore');
  await page.getByTestId('gas-ks-pick').setInputFiles(ks.file);
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-address')).toHaveAttribute('data-value', ks.address);
  await expect(page.getByTestId('gas-ks-source')).toContainText('keystore.json');
  await page.getByTestId('gas-confirm').click();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-account', ks.address, { timeout: 15_000 });

  // Where the inputs went: the link and the keystore only to the paired runner's signer — never the hosted
  // site or the runner's sidecar — and no request carried the keystore's path.
  const cipher = (JSON.parse(readFileSync(ks.file, 'utf8')) as { crypto: { ciphertext: string } }).crypto.ciphertext;
  expect(carrying(ks.link)).toEqual([E2E_SIGNER]);
  expect(carrying(cipher)).toEqual([E2E_SIGNER]);
  expect(sent.slice(before).filter((r) => r.body.includes(ks.path))).toEqual([]);

  // Disconnecting ends what the page knew about that signer at once: no gas payer, no address, no version is kept
  // from it (regression: the unlocked, confirmed key of the earlier pairing stayed "ready").
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-disconnect').click();
  await page.getByTestId('sheet-pair-close').click();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-account', '');
  // Pairing again (the runner restarted: its signer holds no key) reads the new signer before offering anything.
  const again = (await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string };
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-advanced').locator('summary').click();
  await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
  await page.getByTestId('pair-code').fill(again.code);
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('sheet-pair')).toBeHidden();
  await page.getByTestId('gas-chip').click();
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await expect(page.getByTestId('gas-derived')).toHaveCount(0);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await page.close();
});

test('an unlock that fails after the sheet was closed and opened again still says why, on the reopened form (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  // The signer's refusal reaches the page only after the sheet was closed and opened again.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`${E2E_SIGNER}/gas/keystore/unlock`, async (r) => {
    const response = await r.fetch();
    await held;
    return r.fulfill({ response });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('notesPlain');
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-ks-waiting')).toBeVisible();
  await page.getByTestId('sheet-gas-close').click();
  await page.getByTestId('gas-chip').click();
  release();
  await expect(page.getByTestId('gas-error')).toContainText('does not open this keystore. Nothing was unlocked.', { timeout: 15_000 });
  // The reopened form starts at the item again (its link and fields were not kept), so the ledger marks no stage of
  // it failed: the open that failed is not this form's item stage. The error above says why.
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'input');
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="failed"]')).toHaveCount(0);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await page.close();
});

test('reading the item’s fields waits on 1Password at the item stage, not the open stage; when the fields arrive the ledger moves on (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`${E2E_SIGNER}/gas/op/inspect`, async (r) => {
    const response = await r.fetch();
    await held;
    return r.fulfill({ response });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(world.chosenKeystore.link);
  await page.getByTestId('gas-ks-inspect').click();
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByTestId('gas-ks-stage-item')).toContainText('waiting for your approval in the 1Password app');
  await expect(page.getByTestId('gas-ks-stage-open')).toHaveAttribute('data-state', 'next');
  release();
  await expect(page.getByTestId('gas-ks-path-field')).toBeVisible();
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'done');
  await expect(page.getByTestId('gas-ks-stage-fields')).toHaveAttribute('data-state', 'input');
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('the ledger fails the stage whose request failed: a second item read failing goes back to the item stage (not “open”), and a new source starts without the earlier failure (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await expect(page.getByTestId('gas-ks-stage-open')).toHaveAttribute('data-state', 'input');
  // The item is read again and that read fails: the item stage is the failed one, the open is not attempted.
  await page.route(`${E2E_SIGNER}/gas/op/inspect`, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic item read failure' }) }));
  await page.getByTestId('gas-ks-inspect').click();
  await expect(page.getByTestId('gas-error')).toContainText('synthetic item read failure');
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('gas-ks-stage-open')).toHaveAttribute('data-state', 'next');
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="failed"]')).toHaveCount(1);
  await page.unroute(`${E2E_SIGNER}/gas/op/inspect`);
  // Read again (it works), then the open fails: the open stage alone is failed.
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await noUnlockEndpoint(page);
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-ks-stage-open')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="failed"]')).toHaveCount(1);
  // Another source: its item stage is the user's turn, no failure and no error carried over.
  await page.getByTestId('gas-ks-from-file').check();
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="failed"]')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'input');
  await expect(page.getByTestId('gas-error')).toHaveCount(0);
  await page.unroute(`${E2E_SIGNER}/gas/keystore/unlock`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('a keystore open failing after the payer way was changed away and back shows no error and fails no stage of the new form (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen!: () => void;
  const asked = new Promise<void>((r) => (seen = r));
  await page.route(`${E2E_SIGNER}/gas/keystore/unlock`, async (r) => {
    seen();
    await held;
    return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'old attempt failed' }) });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await asked;
  await page.getByTestId('gas-mode-wallet').check();
  await page.getByTestId('gas-mode-native-keystore').check();
  release();
  await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await expect(page.getByTestId('gas-error')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="failed"]')).toHaveCount(0);
  await page.unroute(`${E2E_SIGNER}/gas/keystore/unlock`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('hosted: an item read failing late from the earlier pairing does not relabel the new signer’s open failure as an item failure (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_HOSTED}/recover`, /^https?:\/\/127\.0\.0\.1:41(77|78|79)\//);
  const ks = world.chosenKeystore;
  await pairHosted(page, await restartRunner());
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen!: () => void;
  const asked = new Promise<void>((r) => (seen = r));
  let first = true;
  await page.route(`${E2E_SIGNER}/gas/op/inspect`, async (r) => {
    if (!first) return r.fallback();
    first = false;
    seen();
    await held;
    return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'old pairing item failure' }) }).catch(() => {});
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await asked;
  await page.getByTestId('sheet-gas-close').click();
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-disconnect').click();
  await page.getByTestId('sheet-pair-close').click();
  await pairHosted(page, await restartRunner());
  await page.getByTestId('gas-chip').click();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await noUnlockEndpoint(page);
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-ks-stage-open')).toHaveAttribute('data-state', 'failed');
  release();
  // Give the earlier pairing's answer time to land; the new signer's open stays the failed stage.
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('gas-ks-stage-open')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('gas-ks-stage-item')).not.toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('gas-error')).not.toContainText('old pairing item failure');
  await page.unroute(`${E2E_SIGNER}/gas/keystore/unlock`);
  await page.unroute(`${E2E_SIGNER}/gas/op/inspect`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('an unlock that reaches the signer only after the way was changed is locked again: no key is left installed (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  // The unlock request is held before it reaches the signer, so the lock the way change sends arrives first.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen!: () => void;
  const asked = new Promise<void>((r) => (seen = r));
  await page.route(`${E2E_SIGNER}/gas/keystore/unlock`, async (r) => {
    seen();
    await held;
    return r.fallback();
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await asked;
  const firstLock = page.waitForResponse((r) => r.url().endsWith('/gas/lock'));
  await page.getByTestId('gas-mode-wallet').check();
  await firstLock;
  // Now the unlock reaches the signer and installs its key; the page answers with a second lock.
  const unlocked = page.waitForResponse((r) => r.url().endsWith('/gas/keystore/unlock'));
  const relock = page.waitForRequest((r) => r.url().endsWith('/gas/lock'));
  release();
  expect((await unlocked).status()).toBe(200);
  await relock;
  await page.unroute(`${E2E_SIGNER}/gas/keystore/unlock`);
  await page.getByTestId('gas-mode-native-keystore').check();
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'input');
  await expect(page.getByTestId('gas-derived')).toHaveCount(0);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('a 1Password item read answering after the way was changed sends no lock: the keystore key unlocked meanwhile stays (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen!: () => void;
  const asked = new Promise<void>((r) => (seen = r));
  let first = true;
  await page.route(`${E2E_SIGNER}/gas/op/inspect`, async (r) => {
    if (!first) return r.fallback();
    first = false;
    const response = await r.fetch();
    seen();
    await held;
    return r.fulfill({ response });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-op').check();
  await page.getByTestId('gas-op-link').fill(world.opLink);
  await page.getByTestId('gas-op-inspect').click();
  await asked;
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-derived')).toBeVisible({ timeout: 15_000 });
  const locks: string[] = [];
  page.on('request', (q) => q.url().endsWith('/gas/lock') && locks.push(q.url()));
  const late = page.waitForResponse((r) => r.url().endsWith('/gas/op/inspect'));
  release();
  await late;
  await page.waitForTimeout(500);
  expect(locks).toEqual([]);
  await expect(page.getByTestId('gas-derived')).toBeVisible();
  await page.unroute(`${E2E_SIGNER}/gas/op/inspect`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('a keystore unlock answered only after the way changed: a newer 1Password request waits for that answer, whose cleanup locks the old key by name, and the newer payer then stays ready (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  // The keystore key is installed in the signer; only its answer to the page is held.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen!: () => void;
  const answered = new Promise<void>((r) => (seen = r));
  let first = true;
  await page.route(`${E2E_SIGNER}/gas/keystore/unlock`, async (r) => {
    if (!first) return r.fallback();
    first = false;
    const response = await r.fetch();
    seen();
    await held;
    return r.fulfill({ response });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await answered;
  // The newer key: the 1Password app way. Its first request is not sent while the old unlock is unanswered.
  await page.getByTestId('gas-mode-native-op').check();
  // Leaving sent its own (unkeyed) lock, which locks the old key already installed; let it be answered.
  await page.waitForTimeout(300);
  const asked: string[] = [];
  page.on('request', (q) => asked.push(new URL(q.url()).pathname));
  await page.getByTestId('gas-op-link').fill(world.opLink);
  await page.getByTestId('gas-op-inspect').click();
  await page.waitForTimeout(500);
  expect(asked.filter((u) => u.startsWith('/gas/op/'))).toEqual([]);
  // The old answer lands: its cleanup lock names the old key; only then is the newer request sent.
  const cleanup = page.waitForRequest((q) => q.url().endsWith('/gas/lock'));
  release();
  const body = (await cleanup).postDataJSON() as { keyId?: unknown };
  expect(typeof body.keyId).toBe('string');
  await page.getByTestId('gas-op-field').selectOption('gaskey');
  expect(asked.indexOf('/gas/lock')).toBeLessThan(asked.indexOf('/gas/op/inspect'));
  await page.getByTestId('gas-op-unlock').click();
  await expect(page.getByTestId('sheet-gas')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  await page.unroute(`${E2E_SIGNER}/gas/keystore/unlock`);
  await lockFromChip(page);
  await page.close();
});

/** Opens the chosen keystore through the field source and confirms its address (the sheet then closes). */
async function openAndConfirmKeystore(page: Page, ks: { link: string }) {
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await page.getByTestId('gas-confirm').click();
  await expect(page.getByTestId('sheet-gas')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
}

test('a confirmation refused because the signer dropped the key fails the confirm stage, not an earlier one (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  // The signer's answer as when the keystore changed under it: the key is dropped (a real lock), then refused.
  await page.route(`${E2E_SIGNER}/gas/confirm`, async (r) => {
    await r.fetch({ url: `${E2E_SIGNER}/gas/lock`, postData: '{}' });
    return r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the keystore file changed', kind: 'keystore-changed' }) });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await page.getByTestId('gas-confirm').click();
  await expect(page.getByTestId('gas-error')).toContainText('changed', { timeout: 15_000 });
  await expect(page.getByTestId('gas-derived')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="failed"]')).toHaveCount(1);
  await page.unroute(`${E2E_SIGNER}/gas/confirm`);
  // Opening again starts over: the open is the stage at work, the refused confirmation no longer marks anything.
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-derived')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'input');
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="failed"]')).toHaveCount(0);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('leaving a confirmed keystore key: its lock names that key; back on the keystore way the left key is not offered as ready, and a 1Password request waits for that lock to be answered, so the newer key stays ready (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  await page.getByTestId('wallet-none').click();
  await openAndConfirmKeystore(page, ks);
  // The lock sent on leaving is held before it reaches the signer.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let lockBody: { keyId?: unknown } | null = null;
  await page.route(`${E2E_SIGNER}/gas/lock`, async (r) => {
    if (lockBody) return r.fallback();
    lockBody = r.request().postDataJSON() as { keyId?: unknown };
    await held;
    return r.fallback();
  });
  await page.getByTestId('gas-chip').click();
  // Away (to the browser wallet, which sends no lock of its own) and back while that lock is held: the left key is
  // not offered as ready.
  await page.getByTestId('gas-mode-wallet').check();
  await page.getByTestId('gas-mode-native-keystore').check();
  // Settled, not a first frame: the form has mounted on the keystore way and still offers no ready key.
  await expect(page.getByTestId('gas-ks-from-field')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await expect(page.getByTestId('gas-derived')).toHaveCount(0);
  expect(typeof lockBody!.keyId).toBe('string');
  // Find keystore (a read that would see the left key still unlocked) is not sent while that lock is unanswered.
  const asked: string[] = [];
  page.on('request', (q) => asked.push(new URL(q.url()).pathname));
  await page.getByTestId('gas-ks-from-manifest').check();
  await page.getByTestId('gas-ks-find').click();
  // While it waits, unsent, the page says so: not "working" with the signer, and its stage is "waiting for the signer".
  await expect(page.getByTestId('gas-queued')).toBeVisible();
  await expect(page.getByTestId('gas-ks-working')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'queued');
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="working"], [data-state="waiting"]')).toHaveCount(0);
  // The newer key: the 1Password app way, asked for while the first lock is held.
  await page.getByTestId('gas-mode-native-op').check();
  await page.getByTestId('gas-op-link').fill(world.opLink);
  await page.getByTestId('gas-op-inspect').click();
  // Not "approve in 1Password" nor its Stop: nothing has been asked of 1Password yet.
  await expect(page.getByTestId('gas-queued')).toBeVisible();
  await expect(page.getByTestId('gas-op-waiting')).toHaveCount(0);
  await expect(page.getByTestId('gas-op-stop')).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(asked.filter((u) => u === '/gas/manifest/status' || u === '/gas/op/inspect')).toEqual([]);
  const landed = page.waitForResponse((r) => r.url().endsWith('/gas/lock'));
  release();
  await landed;
  await page.getByTestId('gas-op-field').selectOption('gaskey');
  await page.getByTestId('gas-op-unlock').click();
  await expect(page.getByTestId('sheet-gas')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  expect(asked).not.toContain('/gas/manifest/status');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  await page.unroute(`${E2E_SIGNER}/gas/lock`);
  await lockFromChip(page);
  await page.close();
});

test('leaving while a keystore unlock is unanswered (no key known): a newer 1Password request is sent only after the unkeyed lock and that unlock are answered, so neither can lock the newer key (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  // The keystore unlock reaches the signer (its key is installed there), but its answer is held.
  let releaseUnlock!: () => void;
  const unlockHeld = new Promise<void>((r) => (releaseUnlock = r));
  let unlockSeen!: () => void;
  const unlockReached = new Promise<void>((r) => (unlockSeen = r));
  await page.route(`${E2E_SIGNER}/gas/keystore/unlock`, async (r) => {
    const response = await r.fetch();
    unlockSeen();
    await unlockHeld;
    return r.fulfill({ response });
  });
  // The lock sent on leaving is held before it reaches the signer.
  let releaseLock!: () => void;
  const lockHeld = new Promise<void>((r) => (releaseLock = r));
  let lockBody: { keyId?: unknown } | null = null;
  await page.route(`${E2E_SIGNER}/gas/lock`, async (r) => {
    if (lockBody) return r.fallback();
    lockBody = r.request().postDataJSON() as { keyId?: unknown };
    await lockHeld;
    return r.fallback();
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await unlockReached;
  await page.getByTestId('gas-mode-wallet').check();
  await expect.poll(() => lockBody).not.toBeNull();
  expect(lockBody!.keyId).toBeUndefined();
  const asked: string[] = [];
  page.on('request', (q) => asked.push(new URL(q.url()).pathname));
  await page.getByTestId('gas-mode-native-op').check();
  await page.getByTestId('gas-op-link').fill(world.opLink);
  await page.getByTestId('gas-op-inspect').click();
  await page.waitForTimeout(500);
  expect(asked.filter((u) => u.startsWith('/gas/op/'))).toEqual([]);
  // The unkeyed lock is answered (it locks the old key): the newer request still waits for the old unlock's answer.
  const landed = page.waitForResponse((r) => r.url().endsWith('/gas/lock'));
  releaseLock();
  await landed;
  await page.waitForTimeout(500);
  expect(asked.filter((u) => u.startsWith('/gas/op/'))).toEqual([]);
  // The old unlock's answer lands: its cleanup lock names its own key (already locked); then the newer request is sent.
  const cleanup = page.waitForRequest((q) => q.url().endsWith('/gas/lock'));
  const cleanupAnswer = page.waitForResponse((r) => r.url().endsWith('/gas/lock'));
  releaseUnlock();
  expect(typeof ((await cleanup).postDataJSON() as { keyId?: unknown }).keyId).toBe('string');
  expect(((await (await cleanupAnswer).json()) as { unlocked: boolean }).unlocked).toBe(false);
  await page.getByTestId('gas-op-field').selectOption('gaskey');
  await page.getByTestId('gas-op-unlock').click();
  await expect(page.getByTestId('sheet-gas')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  await page.unroute(`${E2E_SIGNER}/gas/keystore/unlock`);
  await page.unroute(`${E2E_SIGNER}/gas/lock`);
  await lockFromChip(page);
  await page.close();
});

test('a request queued behind the leave lock is cancelled by a way change: its “waiting for the signer” mark ends at once and it is never sent (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  await page.getByTestId('wallet-none').click();
  await openAndConfirmKeystore(page, world.chosenKeystore);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let first = true;
  await page.route(`${E2E_SIGNER}/gas/lock`, async (r) => {
    if (!first) return r.fallback();
    first = false;
    await held;
    return r.fallback();
  });
  const asked: string[] = [];
  page.on('request', (q) => asked.push(new URL(q.url()).pathname));
  await page.getByTestId('gas-chip').click();
  await page.getByTestId('gas-mode-wallet').check();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-manifest').check();
  await page.getByTestId('gas-ks-find').click();
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'queued');
  await expect(page.getByTestId('gas-queued')).toBeVisible();
  // Away: the queued Find is cancelled, and nothing says it will be sent.
  await page.getByTestId('gas-mode-wallet').check();
  await expect(page.getByTestId('gas-queued')).toHaveCount(0);
  // Back: the form is the user's turn again, not a queued request.
  await page.getByTestId('gas-mode-native-keystore').check();
  await expect(page.getByTestId('gas-ks-from-manifest')).toBeVisible();
  await expect(page.getByTestId('gas-queued')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'input');
  const landed = page.waitForResponse((r) => r.url().endsWith('/gas/lock'));
  release();
  await landed;
  await page.waitForTimeout(500);
  expect(asked).not.toContain('/gas/manifest/status');
  await expect(page.getByTestId('gas-queued')).toHaveCount(0);
  await page.unroute(`${E2E_SIGNER}/gas/lock`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('locking again after an unkeyed leave lock failed waits for a newer unlock still with the signer, and is not sent once it installed the newer key, which stays ready (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  // Keystore A's unlock reaches the signer (A is installed); its answer is held.
  let releaseA!: () => void;
  const heldA = new Promise<void>((r) => (releaseA = r));
  let reachedA!: () => void;
  const aReached = new Promise<void>((r) => (reachedA = r));
  await page.route(`${E2E_SIGNER}/gas/keystore/unlock`, async (r) => {
    const response = await r.fetch();
    reachedA();
    await heldA;
    return r.fulfill({ response });
  });
  // Every lock fails (not forwarded) until `forward`; each body is recorded.
  let forward = false;
  const locks: Array<{ keyId?: unknown }> = [];
  await page.route(`${E2E_SIGNER}/gas/lock`, (r) => {
    locks.push(r.request().postDataJSON() as { keyId?: unknown });
    return forward ? r.fallback() : r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'lock unavailable' }) });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await aReached;
  // Leaving with no key known: the unkeyed lock fails; A's late answer is cleaned up by name, and that fails too.
  await page.getByTestId('gas-mode-native-op').check();
  await expect(page.getByTestId('gas-lock-failed')).toBeVisible();
  releaseA();
  await expect.poll(() => locks.length).toBe(2);
  expect(locks[0]!.keyId).toBeUndefined();
  expect(typeof locks[1]!.keyId).toBe('string');
  await expect(page.getByTestId('gas-lock-failed')).toBeVisible();
  // 1Password key B: its unlock reaches the signer (B replaces A there); its answer is held.
  await page.getByTestId('gas-op-link').fill(world.opLink);
  await page.getByTestId('gas-op-inspect').click();
  await page.getByTestId('gas-op-field').selectOption('gaskey');
  let releaseB!: () => void;
  const heldB = new Promise<void>((r) => (releaseB = r));
  let reachedB!: () => void;
  const bReached = new Promise<void>((r) => (reachedB = r));
  await page.route(`${E2E_SIGNER}/gas/op/unlock`, async (r) => {
    const response = await r.fetch();
    reachedB();
    await heldB;
    return r.fulfill({ response });
  });
  await page.getByTestId('gas-op-unlock').click();
  await bReached;
  // Lock again now, with locks reaching the signer: it waits for B's answer instead of locking whatever is there.
  forward = true;
  await page.getByTestId('gas-lock-retry').click();
  await page.waitForTimeout(500);
  expect(locks).toHaveLength(2);
  releaseB();
  await expect(page.getByTestId('sheet-gas')).toBeHidden({ timeout: 15_000 });
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  // B's install ended the failed leave: the retry sends nothing, and B stays ready.
  await page.waitForTimeout(500);
  expect(locks).toHaveLength(2);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  await page.getByTestId('gas-chip').click();
  await expect(page.getByTestId('gas-lock-failed')).toHaveCount(0);
  await page.getByTestId('sheet-gas-close').click();
  await page.unroute(`${E2E_SIGNER}/gas/keystore/unlock`);
  await page.unroute(`${E2E_SIGNER}/gas/op/unlock`);
  await page.unroute(`${E2E_SIGNER}/gas/lock`);
  await lockFromChip(page);
  await page.close();
});

test('a lock on leaving that fails is said, with a way to lock again: the key the signer still holds is never offered as ready, and locking again locks it (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  // What the signer itself answers to each status read (the page may show a key it is leaving as locked).
  const real: Array<{ unlocked: boolean }> = [];
  await page.route(`${E2E_SIGNER}/gas/status`, async (r) => {
    const response = await r.fetch();
    real.push((await response.json()) as { unlocked: boolean });
    return r.fulfill({ response });
  });
  await page.getByTestId('wallet-none').click();
  await openAndConfirmKeystore(page, ks);
  await page.route(`${E2E_SIGNER}/gas/lock`, (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'lock unavailable' }) }));
  await page.getByTestId('gas-chip').click();
  const readAfter = page.waitForResponse((r) => r.url().endsWith('/gas/status'));
  await page.getByTestId('gas-mode-wallet').check();
  await readAfter;
  await expect(page.getByTestId('gas-lock-failed')).toBeVisible();
  expect(real.at(-1)!.unlocked).toBe(true);
  // Back on the keystore way the key the signer still holds is not offered as ready.
  await page.getByTestId('gas-mode-native-keystore').check();
  await expect(page.getByTestId('gas-ks-from-field')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await expect(page.getByTestId('gas-derived')).toHaveCount(0);
  await expect(page.getByTestId('gas-lock-failed')).toBeVisible();
  // Locking again, now answered: the notice ends and the signer holds no key.
  await page.unroute(`${E2E_SIGNER}/gas/lock`);
  const relocked = page.waitForResponse((r) => r.url().endsWith('/gas/status'));
  await page.getByTestId('gas-lock-retry').click();
  await relocked;
  await expect(page.getByTestId('gas-lock-failed')).toHaveCount(0);
  expect(real.at(-1)!.unlocked).toBe(false);
  await page.unroute(`${E2E_SIGNER}/gas/status`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

async function pairHosted(page: Page, code: string) {
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-advanced').locator('summary').click();
  await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
  await page.getByTestId('pair-code').fill(code);
  await page.getByTestId('pair-submit').click();
  await expect(page.getByTestId('sheet-pair')).toBeHidden();
}
const restartRunner = async () => ((await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string }).code;

test('status reads are ordered: a status read answering late (locked, from before the unlock) never replaces the confirmed key (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  // Leaving the 1Password mode locks the signer and reads its status again (nothing waits for that read): that
  // read is answered only after the key was opened and confirmed.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let holdNext = false;
  await page.route(`${E2E_SIGNER}/gas/status`, async (r) => {
    if (!holdNext) return r.fallback();
    holdNext = false;
    const response = await r.fetch();
    await held;
    return r.fulfill({ response });
  });
  const ks = world.chosenKeystore;
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-op').check();
  holdNext = true;
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await page.getByTestId('gas-confirm').click();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  expect(holdNext).toBe(false);
  const late = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/status` && r.status() === 200);
  release();
  await late;
  await page.waitForTimeout(500);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-account', ks.address);
  await lockFromChip(page);
  await page.close();
});

test('a busy answer to a status read (an older signer holding status behind another request) keeps the status known so far: the native modes stay offered (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  await page.getByTestId('wallet-none').click();
  await expect(page.getByTestId('gas-mode-native-keystore')).toBeEnabled();
  // From now on every status read is answered busy.
  await page.route(`${E2E_SIGNER}/gas/status`, (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the signer is busy with another request' }) }));
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(world.chosenKeystore.link);
  const read = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/status`);
  await page.getByTestId('gas-ks-inspect').click();
  await read;
  await page.waitForTimeout(300);
  for (const m of ['native-op', 'native-keystore', 'native-file']) await expect(page.getByTestId(`gas-mode-${m}`)).toBeEnabled();
  await expect(page.getByTestId('gas-compat')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-path-field')).toBeVisible();
  await page.close();
});

test('a signer whose version is not known yet (its first status read answered busy) offers no native mode and no native form, says so, and a recheck recovers (synthetic)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1600 } });
  opened.push(ctx);
  const page = await ctx.newPage();
  await page.route((u) => !/^http:\/\/127\.0\.0\.1:417[78]\//.test(u.href), (route) => (external.push(route.request().url()), route.abort('blockedbyclient')));
  const busy = (r: import('@playwright/test').Route) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the signer is busy with another request' }) });
  await page.route(`${E2E_SIGNER}/gas/status`, busy);
  await page.goto(`${E2E_RUNNER}/recover`);
  await page.getByTestId('wallet-none').click();
  await expect(page.getByTestId('gas-compat')).toHaveAttribute('data-compat', 'unknown');
  await expect(page.getByTestId('gas-compat')).toContainText('has not answered which version');
  for (const m of ['native-op', 'native-keystore', 'native-file']) await expect(page.getByTestId(`gas-mode-${m}`)).toBeDisabled();
  await page.getByTestId('gas-compat-recheck').click();
  await expect(page.getByTestId('gas-compat')).toHaveAttribute('data-compat', 'unknown');
  await page.unroute(`${E2E_SIGNER}/gas/status`, busy);
  await page.getByTestId('gas-compat-recheck').click();
  await expect(page.getByTestId('gas-compat')).toHaveCount(0);
  await page.getByTestId('gas-mode-native-keystore').check();
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await page.close();
});

test('hosted: with a native mode chosen, pairing again shows no native form until the new signer’s status is read (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_HOSTED}/recover`, /^https?:\/\/127\.0\.0\.1:41(77|78|79)\//);
  await pairHosted(page, await restartRunner());
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await expect(page.getByTestId('gas-ks-from-field')).toBeVisible();
  await page.getByTestId('sheet-gas-close').click();
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-disconnect').click();
  await page.getByTestId('sheet-pair-close').click();
  // The new signer's status is held: until it answers, the chosen mode shows no form.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`${E2E_SIGNER}/gas/status`, async (r) => {
    await held;
    return r.fallback();
  });
  await pairHosted(page, await restartRunner());
  await page.getByTestId('gas-chip').click();
  await expect(page.getByTestId('gas-compat')).toHaveAttribute('data-compat', 'unknown');
  await expect(page.getByTestId('gas-native-keystore')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-item-link')).toHaveCount(0);
  release();
  await expect(page.getByTestId('gas-compat')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await page.close();
});

test('finding the manifest wallet is the runner’s own read: it says “working”, never “approve in 1Password” (PM-01b, synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`${E2E_SIGNER}/gas/manifest/status`, async (r) => {
    const response = await r.fetch();
    await held;
    return r.fulfill({ response });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-manifest').check();
  await page.getByTestId('gas-ks-find').click();
  await expect(page.getByTestId('gas-ks-working')).toHaveText('Reading the gas wallet the Terminal signer set up. This does not ask 1Password for anything.');
  await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'working');
  release();
  await expect(page.getByTestId('gas-ks-wallet')).toBeVisible();
  await expect(page.getByTestId('gas-ks-working')).toHaveCount(0);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('a read still with the signer when the sheet is closed and opened again — the 1Password item, or the manifest wallet — keeps its stage word and a locked form, and sends no second request (PM-01a/b, synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const hold = async (path: string) => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const seen = { n: 0 };
    await page.route(`${E2E_SIGNER}${path}`, async (r) => {
      seen.n++;
      const response = await r.fetch();
      await held;
      return r.fulfill({ response });
    });
    return { seen, release };
  };
  const reopen = async () => {
    await page.getByTestId('sheet-gas-close').click();
    await page.getByTestId('gas-chip').click();
  };
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  // The item read (waits on 1Password): reopened, it is still the item stage's wait, with its Stop, on the same source.
  const item = await hold('/gas/op/inspect');
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(world.chosenKeystore.link);
  await page.getByTestId('gas-ks-inspect').click();
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'waiting');
  await reopen();
  await expect(page.getByTestId('gas-ks-from-field')).toBeChecked();
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'waiting');
  await expect(page.getByTestId('gas-ks-waiting')).toBeVisible();
  await expect(page.getByTestId('gas-ks-stop')).toBeVisible();
  await expect(page.getByTestId('gas-ks-inspect')).toBeDisabled();
  await expect(page.getByTestId('gas-ks-from-manifest')).toBeDisabled();
  expect(item.seen.n).toBe(1);
  item.release();
  // Answered while the reopened form was showing: the wait ends and the form is free again (its fields are read anew).
  await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('gas-ks-from-manifest')).toBeEnabled();
  expect(item.seen.n).toBe(1);
  await page.unroute(`${E2E_SIGNER}/gas/op/inspect`);
  // The manifest lookup (the runner's own read): reopened, it is still "working" with its own words, never a wait.
  const find = await hold('/gas/manifest/status');
  await page.getByTestId('gas-ks-from-manifest').check();
  await page.getByTestId('gas-ks-find').click();
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'working');
  await reopen();
  await expect(page.getByTestId('gas-ks-from-manifest')).toBeChecked();
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'working');
  await expect(page.getByTestId('gas-ks-working')).toHaveText('Reading the gas wallet the Terminal signer set up. This does not ask 1Password for anything.');
  await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-find')).toBeDisabled();
  expect(find.seen.n).toBe(1);
  find.release();
  await expect(page.getByTestId('gas-ks-working')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('gas-ks-find')).toBeEnabled();
  expect(find.seen.n).toBe(1);
  await page.unroute(`${E2E_SIGNER}/gas/manifest/status`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('an answer that lands on a reopened sheet while the signer’s status is still being read back keeps the form locked and “working” until the outcome shows — for the keystore item read and the 1Password app item read (PM-01a/b, synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const scenario = async (inspectPath: string, start: () => Promise<void>, check: { stage: boolean; inspect: string; free: string }) => {
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((r) => (releaseRead = r));
    await page.route(`${E2E_SIGNER}${inspectPath}`, async (r) => {
      const response = await r.fetch();
      await readHeld;
      return r.fulfill({ response });
    });
    let releaseStatus!: () => void;
    const statusHeld = new Promise<void>((r) => (releaseStatus = r));
    let holdStatus = false;
    await page.route(`${E2E_SIGNER}/gas/status`, async (r) => (holdStatus && (await statusHeld), r.continue()));
    await start();
    await page.getByTestId('sheet-gas-close').click();
    await page.getByTestId('gas-chip').click();
    // The read answers now, on the reopened sheet; the status read after it is held.
    holdStatus = true;
    const answered = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}${inspectPath}`);
    releaseRead();
    await answered;
    await page.waitForTimeout(300);
    if (check.stage) {
      await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'working');
      await expect(page.getByTestId('gas-ks-working')).toHaveText('The signer answered; reading its status to show the result.');
      await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0);
    } else {
      await expect(page.getByTestId('gas-op-waiting')).toHaveCount(0);
    }
    await expect(page.getByTestId(check.inspect)).toBeDisabled();
    releaseStatus();
    await page.unroute(`${E2E_SIGNER}/gas/status`);
    await page.unroute(`${E2E_SIGNER}${inspectPath}`);
    await expect(page.getByTestId(check.free)).toBeEnabled({ timeout: 15_000 });
  };
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await scenario(
    '/gas/op/inspect',
    async () => {
      await page.getByTestId('gas-ks-from-field').check();
      await page.getByTestId('gas-ks-item-link').fill(world.chosenKeystore.link);
      await page.getByTestId('gas-ks-inspect').click();
      await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'waiting');
    },
    { stage: true, inspect: 'gas-ks-inspect', free: 'gas-ks-item-link' },
  );
  await page.getByTestId('gas-mode-native-op').check();
  await scenario(
    '/gas/op/inspect',
    async () => {
      await page.getByTestId('gas-op-link').fill(world.opLink);
      await page.getByTestId('gas-op-inspect').click();
      await expect(page.getByTestId('gas-op-waiting')).toBeVisible();
    },
    { stage: false, inspect: 'gas-op-link', free: 'gas-op-link' },
  );
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('after the item read answers, reading the signer’s status back is “working”, not “approve in 1Password”, and offers no Stop (PM-01b, synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(world.chosenKeystore.link);
  // Hold the status read that follows the item read.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`${E2E_SIGNER}/gas/status`, async (r) => {
    const response = await r.fetch();
    await held;
    return r.fulfill({ response });
  });
  const inspected = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/op/inspect`);
  await page.getByTestId('gas-ks-inspect').click();
  await inspected;
  await expect(page.getByTestId('gas-ks-working')).toHaveText('The signer answered; reading its status to show the result.');
  await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="waiting"]')).toHaveCount(0);
  // The read-back still belongs to the item stage: the next stage is not marked at work while only it runs.
  await expect(page.getByTestId('gas-ks-stages')).toHaveAttribute('data-stage', 'item');
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'working');
  await expect(page.getByTestId('gas-ks-stage-fields')).toHaveAttribute('data-state', 'next');
  release();
  await expect(page.getByTestId('gas-ks-path-field')).toBeEnabled();
  await expect(page.getByTestId('gas-ks-working')).toHaveCount(0);
  await page.unroute(`${E2E_SIGNER}/gas/status`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('a confirmation still running when the user switches way and comes back belongs to the key it was for: the next key unlocked is free to confirm, and the late answer leaves nothing (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let confirms = 0;
  // Only the first confirmation is held (and refused late); a later one goes to the signer as usual.
  await page.route(`${E2E_SIGNER}/gas/confirm`, async (r) => {
    if (++confirms > 1) return r.continue();
    await held;
    return r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the keystore file changed', kind: 'keystore-changed' }) });
  });
  const unlock = async () => {
    await page.getByTestId('gas-ks-from-field').check();
    await page.getByTestId('gas-ks-item-link').fill(ks.link);
    await page.getByTestId('gas-ks-inspect').click();
    await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
    await page.getByTestId('gas-ks-password-field').selectOption('password');
    await page.getByTestId('gas-ks-open').click();
    await expect(page.getByTestId('gas-confirm')).toBeVisible({ timeout: 30_000 });
  };
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await unlock();
  await page.getByTestId('gas-confirm').click();
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'working');
  // Another way and back (leaving the way locks its key), then the key unlocked again: its confirmation is the
  // user's turn, not "working" on the earlier request.
  await page.getByTestId('gas-mode-native-op').check();
  await page.getByTestId('gas-mode-native-keystore').check();
  await unlock();
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'input');
  await expect(page.getByTestId('gas-confirm')).toBeEnabled();
  await expect(page.getByTestId('gas-lock')).toBeEnabled();
  // The earlier refusal lands now: nothing of it is shown against this key.
  const landed = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/confirm`);
  release();
  await landed;
  await page.waitForTimeout(500);
  await expect(page.getByTestId('gas-error')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'input');
  await page.getByTestId('gas-confirm').click();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes', { timeout: 15_000 });
  expect(confirms).toBe(2);
  await page.unroute(`${E2E_SIGNER}/gas/confirm`);
  // Confirming closed the sheet: open it to lock the key again for the next test.
  await page.getByTestId('gas-chip').click();
  await page.getByTestId('gas-lock').click();
  await expect(page.getByTestId('gas-derived')).toHaveCount(0);
  await page.close();
});

test('a confirmation the signer accepted, answering only after the user switched way and unlocked a key again, finishes nothing: the sheet stays open on the new key, which still needs its own confirmation (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let accepted!: () => void;
  const signerAccepted = new Promise<void>((r) => (accepted = r));
  let confirms = 0;
  // The first confirmation reaches the signer and is accepted there; only its delivery to the page is held.
  await page.route(`${E2E_SIGNER}/gas/confirm`, async (r) => {
    if (++confirms > 1) return r.continue();
    const response = await r.fetch();
    expect(response.status()).toBe(200);
    accepted();
    await held;
    return r.fulfill({ response });
  });
  const unlock = async () => {
    await page.getByTestId('gas-ks-from-field').check();
    await page.getByTestId('gas-ks-item-link').fill(ks.link);
    await page.getByTestId('gas-ks-inspect').click();
    await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
    await page.getByTestId('gas-ks-password-field').selectOption('password');
    await page.getByTestId('gas-ks-open').click();
    await expect(page.getByTestId('gas-confirm')).toBeVisible({ timeout: 30_000 });
  };
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await unlock();
  await page.getByTestId('gas-confirm').click();
  await signerAccepted;
  await page.getByTestId('gas-mode-native-op').check();
  await page.getByTestId('gas-mode-native-keystore').check();
  await unlock();
  await expect(page.getByTestId('gas-derived')).toHaveAttribute('data-confirmed', 'false');
  const landed = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/confirm`);
  release();
  await landed;
  await page.waitForTimeout(500);
  // Still open on the new key: its confirmation is the user's turn, and the payer is not ready.
  await expect(page.getByTestId('sheet-gas')).toBeVisible();
  await expect(page.getByTestId('gas-derived')).toHaveAttribute('data-confirmed', 'false');
  await expect(page.getByTestId('gas-confirm')).toBeEnabled();
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'input');
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  expect(confirms).toBe(1);
  await page.unroute(`${E2E_SIGNER}/gas/confirm`);
  await page.getByTestId('gas-lock').click();
  await expect(page.getByTestId('gas-derived')).toHaveCount(0);
  await page.close();
});

test('a confirmation the signer accepted, answering after the user switched way but before the lock that switch sent has answered, finishes nothing: the sheet stays open on the new way (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let accepted!: () => void;
  const signerAccepted = new Promise<void>((r) => (accepted = r));
  await page.route(`${E2E_SIGNER}/gas/confirm`, async (r) => {
    const response = await r.fetch();
    expect(response.status()).toBe(200);
    accepted();
    await held;
    return r.fulfill({ response });
  });
  // The lock the way switch sends is held: until it answers, the signer's status still shows the confirmed key.
  let releaseLock!: () => void;
  const lockHeld = new Promise<void>((r) => (releaseLock = r));
  await page.route(`${E2E_SIGNER}/gas/lock`, async (r) => (await lockHeld, r.continue()));
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-confirm')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('gas-confirm').click();
  await signerAccepted;
  await page.getByTestId('gas-mode-native-op').check();
  await expect(page.getByTestId('gas-native-op')).toBeVisible();
  const landed = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/confirm`);
  release();
  await landed;
  await page.waitForTimeout(800);
  await expect(page.getByTestId('sheet-gas')).toBeVisible();
  await expect(page.getByTestId('gas-native-op')).toBeVisible();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await expect(page.getByTestId('gas-error')).toHaveCount(0);
  releaseLock();
  await page.unroute(`${E2E_SIGNER}/gas/lock`);
  await page.unroute(`${E2E_SIGNER}/gas/confirm`);
  await expect(page.getByTestId('gas-derived')).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('a confirmation the signer accepted, answering after the user switched way and back while both locks are still with the signer, finishes nothing: the sheet stays open and, once the locks land, no key is left (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let accepted!: () => void;
  const signerAccepted = new Promise<void>((r) => (accepted = r));
  await page.route(`${E2E_SIGNER}/gas/confirm`, async (r) => {
    const response = await r.fetch();
    expect(response.status()).toBe(200);
    accepted();
    await held;
    return r.fulfill({ response });
  });
  // Both locks (away, then back) are held before they reach the signer: its status still shows the confirmed key.
  let releaseLocks!: () => void;
  const locksHeld = new Promise<void>((r) => (releaseLocks = r));
  let locks = 0;
  await page.route(`${E2E_SIGNER}/gas/lock`, async (r) => (locks++, await locksHeld, r.continue()));
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-confirm')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('gas-confirm').click();
  await signerAccepted;
  await page.getByTestId('gas-mode-native-op').check();
  await page.getByTestId('gas-mode-native-keystore').check();
  await expect.poll(() => locks).toBeGreaterThanOrEqual(1);
  const landed = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/confirm`);
  release();
  await landed;
  await page.waitForTimeout(800);
  // Still open (the status read still shows the old key until the held locks land).
  await expect(page.getByTestId('sheet-gas')).toBeVisible();
  releaseLocks();
  await page.unroute(`${E2E_SIGNER}/gas/lock`);
  await page.unroute(`${E2E_SIGNER}/gas/confirm`);
  await expect(page.getByTestId('gas-derived')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await expect(page.getByTestId('sheet-gas')).toBeVisible();
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('a 1Password app unlock the signer accepted, answering only after the user switched way, finishes nothing: the sheet stays open on the new way and no payer is ready (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let accepted!: () => void;
  const signerAccepted = new Promise<void>((r) => (accepted = r));
  let unlocks = 0;
  await page.route(`${E2E_SIGNER}/gas/op/unlock`, async (r) => {
    unlocks += 1;
    const response = await r.fetch();
    expect(response.status()).toBe(200);
    accepted();
    await held;
    return r.fulfill({ response });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-op').check();
  await page.getByTestId('gas-op-link').fill(world.opLink);
  await page.getByTestId('gas-op-inspect').click();
  await page.getByTestId('gas-op-field').selectOption('gaskey');
  // The field shows its address: one press unlocks and confirms exactly it (and would close the sheet).
  await page.getByTestId('gas-op-unlock').click();
  await signerAccepted;
  await page.getByTestId('gas-mode-native-keystore').check();
  await expect(page.getByTestId('gas-native-keystore')).toBeVisible();
  const landed = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/op/unlock`);
  release();
  await landed;
  await page.waitForTimeout(800);
  await expect(page.getByTestId('sheet-gas')).toBeVisible();
  await expect(page.getByTestId('gas-native-keystore')).toBeVisible();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  expect(unlocks).toBe(1);
  await page.unroute(`${E2E_SIGNER}/gas/op/unlock`);
  // The way switch locked the 1Password key: nothing is left unlocked.
  await expect(page.getByTestId('gas-derived')).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('native File: a keystore list answered on a reopened sheet while the signer’s status is still read back keeps the form locked until the outcome shows, and sends no second request (PM-01a, synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  let releaseList!: () => void;
  const listHeld = new Promise<void>((r) => (releaseList = r));
  let lists = 0;
  await page.route(`${E2E_SIGNER}/gas/file/list`, async (r) => {
    lists += 1;
    const response = await r.fetch();
    await listHeld;
    return r.fulfill({ response });
  });
  let releaseStatus!: () => void;
  const statusHeld = new Promise<void>((r) => (releaseStatus = r));
  let holdStatus = false;
  await page.route(`${E2E_SIGNER}/gas/status`, async (r) => (holdStatus && (await statusHeld), r.continue()));
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-file').check();
  await page.getByTestId('gas-nfile-list').click();
  await expect(page.getByTestId('gas-nfile-list')).toBeDisabled();
  await page.getByTestId('sheet-gas-close').click();
  await page.getByTestId('gas-chip').click();
  holdStatus = true;
  const answered = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/file/list`);
  releaseList();
  await answered;
  await page.waitForTimeout(300);
  // The reopened form cannot start another action while the earlier one's outcome is still being read.
  await expect(page.getByTestId('gas-nfile-list')).toBeDisabled();
  await page.waitForTimeout(500);
  expect(lists).toBe(1);
  releaseStatus();
  await page.unroute(`${E2E_SIGNER}/gas/status`);
  await page.unroute(`${E2E_SIGNER}/gas/file/list`);
  await expect(page.getByTestId('gas-nfile-list')).toBeEnabled({ timeout: 15_000 });
  // The list it reads now offers the create controls, free as well.
  await page.getByTestId('gas-nfile-list').click();
  await expect(page.getByTestId('gas-nfile-dir')).toBeVisible();
  await expect(page.getByTestId('gas-nfile-new-password')).toBeEnabled();
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('a confirmation refused while the sheet was closed still says why when it opens again (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  // The signer's refusal of the confirmation (the keystore changed: it dropped the key) lands after the sheet closed.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let confirms = 0;
  await page.route(`${E2E_SIGNER}/gas/confirm`, async (r) => {
    confirms++;
    await held;
    return r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the keystore file changed', kind: 'keystore-changed' }) });
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await page.getByTestId('gas-confirm').click();
  // PM-01a: a confirmation with the signer is "working" at the confirm stage, not the user's turn.
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'working');
  await page.getByTestId('sheet-gas-close').click();
  // Opened again while the confirmation is still with the signer: it is still "working" and the button stays locked,
  // so no second request can be sent.
  await page.getByTestId('gas-chip').click();
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'working');
  await expect(page.getByTestId('gas-confirm')).toBeDisabled();
  expect(confirms).toBe(1);
  await page.getByTestId('sheet-gas-close').click();
  // The refusal lands (and the status read after it) before the sheet opens again; the key itself is still unlocked.
  const landed = page.waitForResponse((r) => r.url() === `${E2E_SIGNER}/gas/confirm`);
  release();
  await landed;
  await page.waitForTimeout(500);
  await page.getByTestId('gas-chip').click();
  await expect(page.getByTestId('gas-derived')).toBeVisible();
  await expect(page.getByTestId('gas-error')).toContainText('changed', { timeout: 15_000 });
  // Still there once the reopened form has settled: not only on its first frame (an effect clearing it on mount
  // would leave the text for that one frame only).
  await page.waitForTimeout(300);
  await expect(page.getByTestId('gas-error')).toContainText('changed', { timeout: 1_000 });
  // PM-01b: the stage ledger agrees — the confirm stage failed; it is not "your turn".
  await expect(page.getByTestId('gas-ks-stage-confirm')).toHaveAttribute('data-state', 'failed');
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  expect(confirms).toBe(1);
  await page.unroute(`${E2E_SIGNER}/gas/confirm`);
  await page.getByTestId('gas-lock').click();
  await expect(page.getByTestId('gas-derived')).toHaveCount(0);
  await page.close();
});

test('hosted: an unlock still waiting when the page disconnects and pairs again belongs to the earlier pairing — the new form is free, and its late end leaves nothing (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_HOSTED}/recover`, /^https?:\/\/127\.0\.0\.1:41(77|78|79)\//);
  await pairHosted(page, await restartRunner());
  const ks = world.chosenKeystore;
  // The unlock is held in the page before it reaches the runner.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`${E2E_SIGNER}/gas/keystore/unlock`, async (r) => {
    await held;
    return r.continue().catch(() => undefined);
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('notesPlain');
  await page.getByTestId('gas-ks-open').click();
  await expect(page.getByTestId('gas-ks-waiting')).toBeVisible();
  await page.getByTestId('sheet-gas-close').click();
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-disconnect').click();
  await page.getByTestId('sheet-pair-close').click();
  await pairHosted(page, await restartRunner());
  await page.getByTestId('gas-chip').click();
  await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  release();
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('gas-error')).toHaveCount(0);
  await expect(page.getByTestId('gas-derived')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await page.close();
});

for (const [w, h] of [[1440, 1600], [768, 1800], [390, 2600]] as const) {
  test(`gas sheet layout at ${w}px in EN and 繁中: whole-row options with the choice in words, the stage ledger, keyboard focus, no horizontal overflow with a long file name`, async ({ browser }) => {
    const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//, { width: w, height: h });
    for (const lang of ['en', 'zh'] as const) {
      if (lang === 'zh') await page.getByTestId('lang-toggle').click();
      await page.getByTestId('wallet-none').click();
      const sheet = page.getByTestId('sheet-gas');
      await expect(sheet).toBeVisible();
      // Keyboard: the mode radios are one group; arrows move the choice, and the focused row shows a ring.
      await page.getByTestId('gas-mode-wallet').focus();
      await page.keyboard.press('ArrowDown');
      await expect(page.getByTestId('gas-mode-browser-file')).toBeChecked();
      await expect(page.getByTestId('gas-mode-browser-file')).toBeFocused();
      const row = page.locator('.lb-option', { has: page.getByTestId('gas-mode-browser-file') });
      expect(await row.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
      await expect(row).toHaveAttribute('data-state', 'chosen');
      await expect(row).toContainText(lang === 'en' ? 'Chosen' : '已選');
      // The whole row is the label: a click on its words chooses it. On a narrow sheet (PM-02) the purpose line of an
      // available way is folded so the five ways fit with the form below; it is the reason line of an unavailable one.
      const ks = page.locator('.lb-option', { has: page.getByTestId('gas-mode-native-keystore') });
      if (w < 900) await expect(ks.locator('.lb-option-line')).toBeHidden();
      await ks.locator(w < 900 ? '.lb-option-title' : '.lb-option-line').click();
      await expect(page.getByTestId('gas-mode-native-keystore')).toBeChecked();
      // Only the chosen mode's form is open.
      await expect(page.getByTestId('gas-native-keystore')).toHaveCount(1);
      await expect(page.locator('[data-testid="gas-native-op"], [data-testid="gas-native-file"], [data-testid="gas-wallet"]')).toHaveCount(0);
      // Two columns on a wide sheet, one on narrow screens.
      const modes = (await page.locator('.lb-gas-modes').boundingBox())!;
      const form = (await page.getByTestId('gas-form').boundingBox())!;
      if (w >= 1440) expect(form.x).toBeGreaterThan(modes.x + modes.width - 1);
      else expect(form.y).toBeGreaterThanOrEqual(modes.y + modes.height - 1);
      // The ledger: the source is done, reading the item is now.
      await page.getByTestId('gas-ks-from-file').check();
      await expect(page.getByTestId('gas-ks-stage-source')).toHaveAttribute('data-state', 'done');
      await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('aria-current', 'step');
      await expect(page.getByTestId('gas-ks-stage-item')).toContainText(lang === 'en' ? 'your turn' : '待你操作');
      // A long file name (not opened) wraps; nothing scrolls sideways.
      await page.getByTestId('gas-ks-pick').setInputFiles({ name: `synthetic-${'very-long-keystore-file-name-'.repeat(6)}UTC--2026-11-01.json`, mimeType: 'application/json', buffer: Buffer.from('{"synthetic":"not opened"}') });
      await expect(page.getByTestId('gas-ks-picked')).toBeVisible();
      const over = await page.evaluate(() => {
        const b = document.querySelector('[data-testid="sheet-gas"] .lb-sheet-body')!;
        return { body: b.scrollWidth - b.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      expect(over).toEqual({ body: 0, doc: 0 });
      if (w === 1440) {
        const r = await new AxeBuilder({ page }).include('[data-testid="sheet-gas"]').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
        expect(r.violations.map((v) => `${lang}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
      }
      // Back to the browser wallet (leaving the native mode locks the signer), then close.
      await page.getByTestId('gas-mode-wallet').check();
      await page.getByTestId('sheet-gas-close').click();
    }
    await page.getByTestId('lang-toggle').click();
    await page.close();
  });
}

const GAS_MODES = ['wallet', 'browser-file', 'native-op', 'native-keystore', 'native-file'] as const;

/** The control a reader uses next in each way's form (the wallet way, with no browser wallet here, shows its notice;
 * the existing keystore starts on the runner's manifest, whose next action is finding its keystore). */
const FIRST_GAS_CONTROL = {
  wallet: 'gas-no-wallet',
  'browser-file': 'gas-file-input',
  'native-op': 'gas-op-link',
  'native-keystore': 'gas-ks-find',
  'native-file': 'gas-nfile-list',
} as const satisfies Record<(typeof GAS_MODES)[number], string>;

// PM-02 (request 2026-11-02 PM revision): on a 390×844 phone, choosing a way to pay gas brings that way's form and
// its next field into the same screen; "Change how gas is paid" goes back to the choice with the keyboard; the
// longer explanation is folded on narrow sheets, open on wide ones; 320 px still reflows.
test('a status read-back already under way when the way is changed away and back belongs to the way left: the new form is free and no stage of it is at work (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(world.chosenKeystore.link);
  // The item read answers; the status read-back after it is held.
  let releaseStatus!: () => void;
  const statusHeld = new Promise<void>((r) => (releaseStatus = r));
  let sawStatus!: () => void;
  const statusStarted = new Promise<void>((r) => (sawStatus = r));
  await page.route(`${E2E_SIGNER}/gas/status`, async (r) => {
    const response = await r.fetch();
    sawStatus();
    await statusHeld;
    return r.fulfill({ response });
  });
  await page.getByTestId('gas-ks-inspect').click();
  await statusStarted;
  await expect(page.getByTestId('gas-ks-stage-item')).toHaveAttribute('data-state', 'working');
  await page.getByTestId('gas-mode-wallet').check();
  await page.getByTestId('gas-mode-native-keystore').check();
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await expect(page.getByTestId('gas-ks-working')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="working"], [data-state="waiting"]')).toHaveCount(0);
  releaseStatus();
  await page.unroute(`${E2E_SIGNER}/gas/status`);
  // Its end changes nothing in the new form.
  await page.waitForTimeout(300);
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="working"], [data-state="waiting"]')).toHaveCount(0);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('a stale read-back ending never ends a newer one: with the sheet reopened while the newer read-back runs, the form stays locked until that one ends (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  // Each armed hold catches the next status read only; every other status read goes through.
  type Hold = { started: Promise<void>; release: () => void; delivered: Promise<void> };
  let armed: ((r: import('@playwright/test').Route) => Promise<void>) | null = null;
  const arm = (): Hold => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let start!: () => void;
    const started = new Promise<void>((r) => (start = r));
    let deliver!: () => void;
    const delivered = new Promise<void>((r) => (deliver = r));
    armed = async (r) => {
      const response = await r.fetch();
      start();
      await held;
      await r.fulfill({ response });
      deliver();
    };
    return { started, release, delivered };
  };
  await page.route(`${E2E_SIGNER}/gas/status`, async (r) => {
    const h = armed;
    armed = null;
    return h ? h(r) : r.fallback();
  });
  const readItem = async () => {
    await page.getByTestId('gas-ks-from-field').check();
    await page.getByTestId('gas-ks-item-link').fill(world.chosenKeystore.link);
    await page.getByTestId('gas-ks-inspect').click();
  };
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  // The old item read's read-back is held; the way is changed away and back.
  const old = arm();
  await readItem();
  await old.started;
  await page.getByTestId('gas-mode-wallet').check();
  await page.getByTestId('gas-mode-native-keystore').check();
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  // A newer item read; its read-back is held too.
  const newer = arm();
  await readItem();
  await newer.started;
  // Reopened, the form knows the newer read-back only from the payer state: it is locked.
  await page.getByTestId('sheet-gas-close').click();
  await page.getByTestId('gas-chip').click();
  await expect(page.getByTestId('gas-ks-from-field')).toBeDisabled();
  // The old read-back ends: the newer one still runs, so the form stays locked.
  old.release();
  await old.delivered;
  await page.waitForTimeout(300);
  await expect(page.getByTestId('gas-ks-from-field')).toBeDisabled();
  // The newer one ends: the form is free.
  newer.release();
  await newer.delivered;
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await page.unroute(`${E2E_SIGNER}/gas/status`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('an unlock still waiting on 1Password when the way is changed away and back: the new form does not say “approve in 1Password” and is free; the late answer is locked again (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//);
  const ks = world.chosenKeystore;
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen!: () => void;
  const asked = new Promise<void>((r) => (seen = r));
  await page.route(`${E2E_SIGNER}/gas/keystore/unlock`, async (r) => {
    seen();
    await held;
    return r.fallback();
  });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(ks.link);
  await page.getByTestId('gas-ks-inspect').click();
  await page.getByTestId('gas-ks-path-field').selectOption('keystore_path');
  await page.getByTestId('gas-ks-password-field').selectOption('password');
  await page.getByTestId('gas-ks-open').click();
  await asked;
  await expect(page.getByTestId('gas-ks-waiting')).toBeVisible();
  const leave = page.waitForResponse((r) => r.url().endsWith('/gas/lock'));
  await page.getByTestId('gas-mode-wallet').check();
  await leave;
  await page.getByTestId('gas-mode-native-keystore').check();
  // The old attempt's approval wording and its opening lock stay with the old way.
  await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-working')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="waiting"], [data-state="working"]')).toHaveCount(0);
  // The old unlock lands now: its key is locked again by name, and nothing is ready. Its status read-back is held:
  // it belongs to the way left, so the new form stays free and no stage of it is at work meanwhile.
  let releaseStatus!: () => void;
  const statusHeld = new Promise<void>((r) => (releaseStatus = r));
  let sawStatus!: () => void;
  const statusStarted = new Promise<void>((r) => (sawStatus = r));
  await page.route(`${E2E_SIGNER}/gas/status`, async (r) => {
    const response = await r.fetch();
    sawStatus();
    await statusHeld;
    return r.fulfill({ response });
  });
  const relock = page.waitForRequest((r) => r.url().endsWith('/gas/lock'));
  release();
  expect(typeof ((await relock).postDataJSON() as { keyId?: unknown }).keyId).toBe('string');
  await statusStarted;
  await expect(page.getByTestId('gas-ks-from-field')).toBeEnabled();
  await expect(page.getByTestId('gas-ks-working')).toHaveCount(0);
  await expect(page.getByTestId('gas-ks-stages').locator('[data-state="working"], [data-state="waiting"]')).toHaveCount(0);
  releaseStatus();
  await page.unroute(`${E2E_SIGNER}/gas/status`);
  await expect(page.getByTestId('gas-ks-waiting')).toHaveCount(0);
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'no');
  await page.unroute(`${E2E_SIGNER}/gas/keystore/unlock`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('“Change how gas is paid” after the chosen native way became unavailable (an older runner): focus goes to the first way that can be chosen, with the list on screen (synthetic)', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//, { width: 390, height: 844 });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  await page.getByTestId('gas-ks-from-field').check();
  await page.getByTestId('gas-ks-item-link').fill(world.chosenKeystore.link);
  // The status read after the item read says the runner is older: the chosen radio is disabled, still chosen.
  await signerSays(page, null);
  await page.getByTestId('gas-ks-inspect').click();
  await expect(page.getByTestId('gas-compat')).toHaveAttribute('data-compat', 'runner-older');
  await expect(page.getByTestId('gas-mode-native-keystore')).toBeDisabled();
  await expect(page.getByTestId('gas-mode-native-keystore')).toBeChecked();
  await page.getByTestId('gas-change').click();
  await expect(page.getByTestId('gas-mode-wallet')).toBeFocused();
  await expect(page.getByTestId('gas-mode-wallet')).toBeInViewport();
  await page.unroute(`${E2E_SIGNER}/gas/status`);
  await page.getByTestId('gas-mode-wallet').check();
  await page.close();
});

test('gas sheet at 390×844 in EN and 繁中: the chosen way and its next field share one screen, Change returns to the choice, help is folded; 320 reflows; 1440 keeps help open and no Change', async ({ browser }) => {
  const page = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//, { width: 390, height: 844 });
  for (const lang of ['en', 'zh'] as const) {
    if (lang === 'zh') await page.getByTestId('lang-toggle').click();
    await page.getByTestId('wallet-none').click();
    await expect(page.getByTestId('sheet-gas')).toBeVisible();
    await page.getByTestId('gas-mode-native-keystore').check();
    await expect(page.locator('.lb-gas-form-title'), lang).toHaveText(lang === 'en' ? 'Existing gas wallet' : '既有 gas 錢包');
    // The sheet scrolls the form in (smoothly unless reduced motion); then its title and the next choice are on screen.
    await expect(page.locator('.lb-gas-form-title'), lang).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId('gas-ks-from-file'), lang).toBeInViewport();
    await expect(page.getByTestId('gas-about'), lang).not.toHaveAttribute('open', '');
    // Change: back to the choice, focus on the chosen radio, so arrows switch the way at once.
    await expect(page.getByTestId('gas-change')).toHaveText(lang === 'en' ? 'Change how gas is paid' : '改用其他付款方式');
    await page.getByTestId('gas-change').click();
    await expect(page.getByTestId('gas-mode-native-keystore')).toBeFocused();
    await expect(page.getByTestId('gas-mode-native-keystore')).toBeInViewport();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByTestId('gas-mode-native-file')).toBeChecked();
    // All five ways remain offered.
    await expect(page.locator('.lb-gas-modes input[type="radio"]')).toHaveCount(5);
    // Every way, with and without reduced motion (instant vs smooth scroll): its title and its first usable
    // control land inside the 844 px screen.
    for (const motion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion: motion });
      for (const mode of GAS_MODES) {
        if (await page.getByTestId('gas-change').isVisible()) await page.getByTestId('gas-change').click();
        await page.getByTestId(`gas-mode-${mode}`).check();
        await expect(page.locator('.lb-gas-form-title'), `${lang} ${motion} ${mode}`).toBeInViewport({ ratio: 1 });
        const first = page.getByTestId(FIRST_GAS_CONTROL[mode]);
        if (mode !== 'wallet') await expect(first, `${lang} ${motion} ${mode}`).toBeEnabled();
        await expect(first, `${lang} ${motion} ${mode}`).toBeInViewport({ ratio: 1 });
        // The other two keystore sources: their next action is the item link, on the same screen.
        if (mode === 'native-keystore') {
          for (const src of ['field', 'file'] as const) {
            await page.getByTestId(`gas-ks-from-${src}`).check();
            const link = page.getByTestId('gas-ks-item-link');
            await expect(link, `${lang} ${motion} ${src}`).toBeEnabled();
            await expect(link, `${lang} ${motion} ${src}`).toBeInViewport({ ratio: 1 });
          }
          await page.getByTestId('gas-ks-from-manifest').check();
        }
      }
    }
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    if (await page.getByTestId('gas-change').isVisible()) await page.getByTestId('gas-change').click();
    await page.getByTestId('gas-mode-wallet').check();
    await page.getByTestId('sheet-gas-close').click();
  }
  await page.getByTestId('lang-toggle').click();
  // 320 CSS px (WCAG 1.4.10): the sheet and the page reflow without sideways scrolling.
  await page.setViewportSize({ width: 320, height: 720 });
  await page.getByTestId('wallet-none').click();
  await page.getByTestId('gas-mode-native-keystore').check();
  const over = await page.evaluate(() => {
    const b = document.querySelector('[data-testid="sheet-gas"] .lb-sheet-body')!;
    return { body: b.scrollWidth - b.clientWidth, doc: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  expect(over).toEqual({ body: 0, doc: 0 });
  await page.getByTestId('gas-mode-wallet').check();
  await page.getByTestId('sheet-gas-close').click();
  await page.close();
  // Wide sheet: both columns are on screen, so the explanation starts open and Change is not shown.
  const wide = await openAt(browser, `${E2E_RUNNER}/recover`, /^http:\/\/127\.0\.0\.1:417[78]\//, { width: 1440, height: 1000 });
  await wide.getByTestId('wallet-none').click();
  await wide.getByTestId('gas-mode-native-keystore').check();
  await expect(wide.getByTestId('gas-about')).toHaveAttribute('open', '');
  await expect(wide.getByTestId('gas-change')).toBeHidden();
  // Crossing the breakpoint with the sheet open (a resize or zoom to a phone width) folds the explanation, so the
  // next way chosen still shares the screen with its first field; widening again opens it.
  await wide.setViewportSize({ width: 390, height: 844 });
  await expect(wide.getByTestId('gas-about')).not.toHaveAttribute('open', '');
  await wide.getByTestId('gas-change').click();
  await wide.getByTestId('gas-mode-browser-file').check();
  await expect(wide.locator('.lb-gas-form-title')).toBeInViewport({ ratio: 1 });
  await expect(wide.getByTestId('gas-file-input')).toBeInViewport({ ratio: 1 });
  await wide.setViewportSize({ width: 1440, height: 1000 });
  await expect(wide.getByTestId('gas-about')).toHaveAttribute('open', '');
  await wide.getByTestId('gas-mode-wallet').check();
  await wide.getByTestId('sheet-gas-close').click();
  await wide.close();
});
