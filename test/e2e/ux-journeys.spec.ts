// UX-01: the main journeys, counted the same way before and after the UX pass (test/support/uxCount.ts).
// This is the AFTER version: the BEFORE one (same journeys on the pre-pass UI) is kept with the run's
// evidence. What changed per action is listed in the handoff's UX-01 table.
// SYNTHETIC only: the testchain world, a mock EIP-1193 wallet announced as OKX, the fake `op` item and
// Passkey-format assertions built in Node from throwaway fixture keys. Each journey appends its counts to
// UX_JOURNEY_OUT (default test-results/ux-journeys.json). External steps (the Terminal, the Passkey
// prompt, wallet pop-ups, 1Password approval) are listed in the handoff table, not counted here.
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { hexToBytes } from '../../src/crypto/bytes';
import { E2E_HOSTED, E2E_PROVIDER, E2E_RUNNER, type E2eWorld } from '../support/e2e-constants';
import { buildAssertion, syntheticKey } from '../fixtures/synthetic';
import { fakeAudio, type AudioLog } from '../support/fakeAudio';
import { installMockWallet } from '../support/mockWallet';
import { Journey } from '../support/uxCount';

test.describe.configure({ mode: 'serial', timeout: 300_000 });

let world: E2eWorld;
const opened: BrowserContext[] = [];
const external: string[] = [];
const ALLOW = /^https?:\/\/127\.0\.0\.1:41(77|78|79)\//;

test.beforeAll(async () => {
  world = (await (await fetch(`${E2E_PROVIDER}/world`)).json()) as E2eWorld;
});
test.afterAll(async () => {
  expect(external).toEqual([]);
  for (const c of opened) await c.close();
});

async function context(browser: Browser): Promise<Page> {
  // UX_VIDEO_DIR: record each journey (synthetic data only) for the UX-04 evidence.
  const video = process.env.UX_VIDEO_DIR;
  const ctx = await browser.newContext({ acceptDownloads: true, ...(video ? { recordVideo: { dir: video, size: { width: 1280, height: 800 } } } : {}) });
  opened.push(ctx);
  const page = await ctx.newPage();
  await page.route((u) => !ALLOW.test(u.href.replace(/^blob:/, '')) && u.href !== 'about:blank', (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  return page;
}
const fund = (address: string) => fetch(`${E2E_PROVIDER}/fund`, { method: 'POST', body: JSON.stringify({ address }) }).then((r) => expect(r.status).toBe(204));
const freshCode = async () => ((await (await fetch(`${E2E_PROVIDER}/runner/restart`, { method: 'POST' })).json()) as { code: string }).code;
const sameAddress = (a: string) => new RegExp(`^${a}$`, 'i');

async function pair(u: Journey, page: Page, code: string) {
  await u.click(page.getByTestId('top-pair'));
  // Harness only: the test runner listens on a non-default port (a user on the default port skips this).
  await u.setup(async () => {
    await page.getByTestId('pair-advanced').locator('summary').click();
    await u.fill(page.getByTestId('pair-url'), `${E2E_RUNNER}/recover`, 'runner url');
  });
  await u.fill(page.getByTestId('pair-code'), code, 'pairing code');
  // One Connect: asks who is there, pairs, closes the sheet.
  await u.click(page.getByTestId('pair-submit'));
  await expect(page.getByTestId('sheet-pair')).toBeHidden();
  await expect(page.getByTestId('no-sidecar')).toHaveCount(0);
}

async function pickOkx(u: Journey, page: Page) {
  await u.click(page.getByTestId('wallet-pick'));
  await u.check(page.getByTestId('gas-wallet-com.okex.wallet'));
  await u.click(page.getByTestId('gas-wallet-connect'));
  await expect(page.getByTestId('gas-address')).toHaveAttribute('data-value', sameAddress(world.gasWallet));
  await u.click(page.getByTestId('sheet-gas-close'));
}

async function check(u: Journey, page: Page, a: E2eWorld['accounts']['H'], evidence: boolean) {
  await u.fill(page.getByTestId('check-account'), a.address, 'source account');
  if (evidence) {
    await u.click(page.getByTestId('check-evidence-toggle'));
    await u.fill(page.getByTestId('check-owners'), a.owners.join('\n'), 'owners');
    await u.fill(page.getByTestId('check-nonce'), a.nonce, 'factory nonce');
  }
  await u.click(page.getByTestId('check-run'));
  await expect(page.locator('li[data-step="check"]')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
}

async function deployAll(u: Journey, page: Page) {
  // The step plans on entry.
  await expect(page.getByTestId('deploy')).toHaveAttribute('data-progress', /^\d+\/\d+$/, { timeout: 120_000 });
  const moveOpen = page.locator('li[data-step="move"][data-state="current"]');
  const send = page.getByTestId('deploy-send');
  const next = async () => ((await moveOpen.count()) ? 'done' : (await send.count()) && (await send.isEnabled()) ? 'send' : 'wait');
  for (let i = 0; i < 12; i++) {
    await expect.poll(next, { timeout: 120_000 }).not.toBe('wait');
    if ((await next()) === 'done') break;
    const before = await page.getByTestId('deploy').getAttribute('data-progress');
    await u.click(send);
    await u.click(page.getByTestId('deploy-send-confirm'));
    u.c.deploySteps++;
    await expect.poll(async () => (await moveOpen.count()) || (await page.getByTestId('deploy').getAttribute('data-progress')) !== before, { timeout: 120_000 }).toBeTruthy();
  }
  await expect(moveOpen).toHaveCount(1, { timeout: 120_000 });
}

/**
 * Draft → Passkey proof (pasted back) → send → receipt. `wrongFirst`: a proof for another transfer is
 * pasted first. `cancelFirst`: the send sheet is opened and closed once — nothing may go out.
 */
async function move(u: Journey, page: Page, seed: number, o: { payer: 'wallet' | 'direct'; wrongFirst?: boolean; cancelFirst?: boolean }) {
  await u.select(page.getByTestId('move-asset'), { label: 'USDT0' });
  await u.fill(page.getByTestId('move-amount'), '1', 'amount');
  await u.fill(page.getByTestId('move-to'), world.recipient, 'recipient');
  await u.fill(page.getByTestId('move-to-again'), world.recipient, 'recipient again');
  await u.click(page.getByTestId('move-review'));
  const sign = page.getByTestId('sign');
  await expect(sign).toBeVisible({ timeout: 120_000 });
  const hash = (await sign.getAttribute('data-userop-hash')) as `0x${string}`;
  if (o.wrongFirst) {
    const other = buildAssertion({ challenge: hexToBytes(`0x${'ab'.repeat(32)}`), kind: 'userop', key: syntheticKey(seed) });
    await u.paste(page.getByTestId('sign-assertion'), other.json, 'wrong proof');
    await expect(page.getByTestId('sign-error')).toBeVisible({ timeout: 60_000 });
    u.startRecovery('a Passkey proof for another transfer was pasted');
  }
  const a = buildAssertion({ challenge: hexToBytes(hash), kind: 'userop', key: syntheticKey(seed) });
  // Pasting the proof checks it at once (no separate button); after a wrong one the field is selected, so
  // the next paste replaces it.
  await u.paste(page.getByTestId('sign-assertion'), a.json, 'Passkey proof');
  await expect(page.getByTestId('signed')).toBeVisible({ timeout: 120_000 });
  if (o.wrongFirst) u.endRecovery();
  if (o.cancelFirst) {
    const rows = await page.getByTestId('track-row').count();
    u.startRecovery('the send sheet was opened and closed without sending');
    await u.click(page.getByTestId('send'));
    await u.click(page.getByTestId('send-sheet-close'));
    await expect(page.getByTestId('send-sheet')).toBeHidden();
    // Cancelled: nothing was sent and no record was made; the signed transfer is still ready to send.
    await expect(page.getByTestId('move-sent')).toHaveCount(0);
    await expect(page.getByTestId('track-row')).toHaveCount(rows);
    await expect(page.getByTestId('signed')).toBeVisible();
    u.endRecovery();
  }
  await u.click(page.getByTestId('send'));
  // The confirmation says who asks next: a browser wallet confirms once more; a File key or the runner's signer sends here.
  const sheet = page.getByTestId('send-sheet');
  if (o.payer === 'wallet') await expect(sheet).toContainText('Your wallet will ask you to confirm');
  else await expect(sheet).toContainText('There is no further confirmation');
  await expect(sheet.getByTestId('send-confirm')).toHaveText(o.payer === 'wallet' ? 'Send in my wallet' : 'Sign and send now');
  await u.fill(page.getByTestId('send-sheet').getByTestId('send-typed'), '1', 'amount again');
  await u.click(page.getByTestId('send-sheet').getByTestId('send-confirm'), { timeout: 15_000 });
  const row = page.getByTestId('track-row').first();
  await expect(row).toHaveAttribute('data-state', /confirmed|final/, { timeout: 120_000 });
}

test('J3 runner page, 1Password gas payer: set up, check, deploy, move with one failed Passkey paste', async ({ browser }) => {
  const u = new Journey('J3 local runner page · 1Password payer · first use');
  const page = await context(browser);
  await u.goto(page, `${E2E_RUNNER}/recover`);
  await expect(page.getByTestId('top-pair')).toHaveCount(0);
  await u.click(page.locator('[data-testid="wallet-none"], [data-testid="gas-chip"]').first());
  // Another spec may have left the runner's signer unlocked: start from a locked signer (harness only).
  await u.setup(async () => {
    await page.getByTestId('gas-mode-native-op').check();
    if (await page.getByTestId('gas-lock').count()) await page.getByTestId('gas-lock').click();
    await page.getByTestId('gas-mode-wallet').check();
  });
  await u.check(page.getByTestId('gas-mode-native-op'));
  await u.fill(page.getByTestId('gas-op-link'), world.opLink, '1Password link');
  await u.click(page.getByTestId('gas-op-inspect'));
  await u.select(page.getByTestId('gas-op-field'), 'gaskey');
  // The picker shows the address this field unlocks; one press unlocks and uses exactly it.
  const payer = (await page.getByTestId('gas-op-picked-address').getAttribute('data-value'))!;
  await fund(payer);
  await u.click(page.getByTestId('gas-op-unlock'));
  await expect(page.getByTestId('sheet-gas')).toBeHidden();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  await check(u, page, world.accounts.I, true);
  await deployAll(u, page);
  await move(u, page, world.accounts.I.passkey.seed, { payer: 'direct', wrongFirst: true });
  u.save();
});

test('J4 runner page, browser File gas payer: create the encrypted file and confirm its address', async ({ browser }) => {
  const u = new Journey('J4 browser File payer · create');
  const page = await context(browser);
  await u.goto(page, `${E2E_RUNNER}/recover`);
  await u.click(page.locator('[data-testid="wallet-none"], [data-testid="gas-chip"]').first());
  await u.check(page.getByTestId('gas-mode-browser-file'));
  await u.fill(page.getByTestId('gas-file-new-password'), 'synthetic-ux-pass-1', 'new password');
  await u.fill(page.getByTestId('gas-file-repeat'), 'synthetic-ux-pass-1', 'password again');
  const download = page.waitForEvent('download');
  await u.click(page.getByTestId('gas-file-create'));
  await download;
  await expect(page.getByTestId('gas-address')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('gas-file-why')).toBeVisible();
  await u.click(page.getByTestId('gas-confirm'));
  await expect(page.getByTestId('sheet-gas')).toBeHidden();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  u.save();
});

test('J1 website first use with OKX: pair, choose the wallet, check, deploy, move', async ({ browser }) => {
  const u = new Journey('J1 website · OKX wallet · first use');
  const code = await freshCode();
  const page = await context(browser);
  await installMockWallet(page, world, { announce: { rdns: 'com.okex.wallet', name: 'OKX Wallet' } });
  await page.addInitScript(() => {
    const provider = { request: async () => Promise.reject(Object.assign(new Error('decoy'), { code: 4100 })), on: () => {}, removeListener: () => {} };
    const info = Object.freeze({ uuid: 'b6f1a1de-0000-4000-8000-0000000000d2', name: 'Other Wallet', icon: 'data:image/svg+xml,<svg/>', rdns: 'test.synthetic.decoy' });
    const say = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', say);
    say();
  });
  await u.goto(page, `${E2E_HOSTED}/recover`);
  await pair(u, page, code);
  await pickOkx(u, page);
  await check(u, page, world.accounts.H, true);
  await deployAll(u, page);
  await move(u, page, world.accounts.H.passkey.seed, { payer: 'wallet' });
  u.save();
});

test('J2 website return visit with OKX: pair again after a reload, check the deployed wallet, move', async ({ browser }) => {
  const u = new Journey('J2 website · OKX wallet · return visit');
  const code = await freshCode();
  const page = await context(browser);
  await installMockWallet(page, world, { announce: { rdns: 'com.okex.wallet', name: 'OKX Wallet' } });
  // A FAKE AudioContext records the cues; no real sound plays.
  await page.addInitScript(fakeAudio);
  const notes = async () => (await page.evaluate(() => (window as unknown as { __audio: AudioLog }).__audio)).notes.length;
  await u.goto(page, `${E2E_HOSTED}/recover`);
  await pair(u, page, code);
  // Sound is optional, so turning it on is not counted (harness only); the click plays one two-note preview.
  await u.setup(() => page.getByTestId('sound-toggle').click());
  expect(await notes()).toBe(2);
  // One announced wallet: it is offered, the user connects it.
  const chip = page.locator('[data-testid="wallet-pick"], [data-testid="wallet-connect"]').first();
  if ((await chip.getAttribute('data-testid')) === 'wallet-pick') await pickOkx(u, page);
  else await u.click(chip);
  await expect(page.getByTestId('wallet-connected')).toHaveAttribute('data-account', sameAddress(world.gasWallet));
  // Which cue each note belongs to ('sine' done, 'triangle' attention): a wrong count names its source.
  const kinds = async () => (await page.evaluate(() => (window as unknown as { __audio: AudioLog }).__audio)).kinds.join(',');
  await check(u, page, world.accounts.H, false);
  // A Check of the already-deployed wallet plays nothing.
  expect(await kinds(), 'no cue during the return-visit Check').toBe('sine,sine');
  await move(u, page, world.accounts.H.passkey.seed, { payer: 'wallet' });
  // UX-04: the transfer verified in a block plays the "done" cue once (two notes); later polls and the
  // block turning final do not replay it. A just-sent transfer never plays "attention" on the way.
  await expect.poll(notes, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  expect(await kinds(), 'preview, then done only').toBe('sine,sine,sine,sine');
  await expect(page.getByTestId('track-row').first().getByTestId('ladder')).toHaveAttribute('data-at', /block|final/);
  await page.waitForTimeout(8_000);
  expect(await notes()).toBe(4);
  u.save();
  // A reload starts with sound off. Turned on again, the receipt row loaded from before this page load
  // stays silent: only the preview plays.
  await page.reload();
  await expect(page.getByTestId('sound-toggle')).toHaveAttribute('aria-pressed', 'false');
  expect(await notes()).toBe(0);
  await page.getByTestId('sound-toggle').click();
  // (The website is unpaired again after a reload, so the row cannot be re-read; whatever it shows, it is old.)
  await expect(page.getByTestId('track-row').first()).toBeVisible({ timeout: 60_000 });
  await page.waitForTimeout(6_000);
  expect(await notes()).toBe(2);
});

test('J5 website, browser File gas payer: pair, create and confirm the file, check, deploy, move with a cancelled send', async ({ browser }) => {
  const u = new Journey('J5 website · browser File payer · first use');
  const code = await freshCode();
  const page = await context(browser);
  await u.goto(page, `${E2E_HOSTED}/recover`);
  await pair(u, page, code);
  await u.click(page.locator('[data-testid="wallet-none"], [data-testid="gas-chip"]').first());
  await u.check(page.getByTestId('gas-mode-browser-file'));
  await u.fill(page.getByTestId('gas-file-new-password'), 'synthetic-ux-pass-5', 'new password');
  await u.fill(page.getByTestId('gas-file-repeat'), 'synthetic-ux-pass-5', 'password again');
  const download = page.waitForEvent('download');
  await u.click(page.getByTestId('gas-file-create'));
  await download;
  const payer = (await page.getByTestId('gas-address').getAttribute('data-value', { timeout: 60_000 }))!;
  await u.click(page.getByTestId('gas-confirm'));
  await expect(page.getByTestId('sheet-gas')).toBeHidden();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-account', payer);
  await fund(payer);
  await check(u, page, world.accounts.J, true);
  await deployAll(u, page);
  await move(u, page, world.accounts.J.passkey.seed, { payer: 'direct', cancelFirst: true });
  u.save();
});

test('J6 website, 1Password through the paired runner: pair, unlock and use, check, deploy, move with one failed Passkey paste', async ({ browser }) => {
  const u = new Journey('J6 website · 1Password payer (paired runner) · first use');
  const code = await freshCode();
  const page = await context(browser);
  await u.goto(page, `${E2E_HOSTED}/recover`);
  await pair(u, page, code);
  await u.click(page.locator('[data-testid="wallet-none"], [data-testid="gas-chip"]').first());
  // Another journey may have left the runner's signer unlocked: start from a locked signer (harness only).
  await u.setup(async () => {
    await page.getByTestId('gas-mode-native-op').check();
    if (await page.getByTestId('gas-lock').count()) await page.getByTestId('gas-lock').click();
    await page.getByTestId('gas-mode-browser-file').check();
  });
  await u.check(page.getByTestId('gas-mode-native-op'));
  await u.fill(page.getByTestId('gas-op-link'), world.opLink, '1Password link');
  await u.click(page.getByTestId('gas-op-inspect'));
  await u.select(page.getByTestId('gas-op-field'), 'gaskey');
  const payer = (await page.getByTestId('gas-op-picked-address').getAttribute('data-value'))!;
  await fund(payer);
  await u.click(page.getByTestId('gas-op-unlock'));
  await expect(page.getByTestId('sheet-gas')).toBeHidden();
  await expect(page.getByTestId('gas-chip')).toHaveAttribute('data-ready', 'yes');
  await check(u, page, world.accounts.K, true);
  await deployAll(u, page);
  await move(u, page, world.accounts.K.passkey.seed, { payer: 'direct', wrongFirst: true });
  // Harness only: leave the runner's signer locked for whatever runs next.
  await u.setup(async () => {
    await page.getByTestId('gas-chip').click();
    await page.getByTestId('gas-lock').click();
  });
  u.save();
});

test('regression (PM-06): a balance read asked through an earlier pairing changes nothing when it answers after the runner restarted and was paired again', async ({ browser }) => {
  const page = await context(browser);
  const a = world.accounts.H; // deployed by J1
  const connect = async (code: string) => {
    await page.getByTestId('top-pair').click();
    await page.getByTestId('pair-advanced').locator('summary').click();
    await page.getByTestId('pair-url').fill(`${E2E_RUNNER}/recover`);
    await page.getByTestId('pair-code').fill(code);
    await page.getByTestId('pair-submit').click();
    await expect(page.getByTestId('sheet-pair')).toBeHidden();
  };
  const bal = page.getByTestId('move-balance');
  const checkMove = async () => {
    await page.getByTestId('check-account').fill(a.address);
    await page.getByTestId('check-run').click();
    await expect(page.locator('li[data-step="move"]')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
    await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
    return { block: (await bal.getAttribute('data-block'))!, text: (await bal.textContent())! };
  };
  await page.goto(`${E2E_HOSTED}/recover`);
  await connect(await freshCode());
  await checkMove();
  // A read again through this pairing: its answer is held (with made-up figures) past the re-pair below.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let done!: () => void;
  const fulfilled = new Promise<void>((r) => (done = r));
  let k = 0;
  await page.route(`${E2E_RUNNER}/api/diagnose`, async (route) => {
    if (++k > 1) return route.fallback();
    const res = await route.fetch();
    const body = (await res.json()) as { block: string; balances: { tokens: Record<string, string | null> } };
    await held;
    const tokens = Object.fromEntries(Object.keys(body.balances.tokens).map((key) => [key, '999000000']));
    await route.fulfill({ response: res, json: { ...body, block: '1', balances: { ...body.balances, tokens } } }).catch(() => undefined);
    done();
  });
  await page.getByTestId('move-balance-refresh').click();
  await expect(bal).toHaveAttribute('data-state', 'reading');
  // The runner restarts and is paired again: what was read is void, Check runs again through the new pairing.
  await page.getByTestId('top-pair').click();
  await page.getByTestId('pair-disconnect').click();
  await page.getByTestId('sheet-pair-close').click();
  await connect(await freshCode());
  const now = await checkMove();
  release();
  await fulfilled;
  await page.waitForTimeout(300);
  await expect(bal).toHaveAttribute('data-block', now.block);
  await expect(bal).toHaveText(now.text);
  await expect(bal).toHaveAttribute('data-state', 'fresh');
  await page.unroute(`${E2E_RUNNER}/api/diagnose`);
});
