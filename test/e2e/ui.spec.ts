// Accessibility, keyboard and visual evidence for the M4 logbook against the real sidecar bundle
// (SYNTHETIC testchain). Walks synthetic wallet B (factory nonce 7, an address owner at index 0 and the
// Passkey at index 1) through check → deploy → move → track; at each state it runs axe (WCAG 2.2 AA
// rules) in English and 繁中 and, when E2E_SHOT_DIR is set, saves real screenshots at 1440 / 768 / 390.
// Also: the keyboard-only path, sheets and Escape, reduced motion / transparency, and the no-sidecar
// error state on the static build. No network, no real wallet, no real Passkey.
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { base64urlToBytes, hexToBytes } from '../../src/crypto/bytes';
import { E2E_PROVIDER, type E2eWorld } from '../support/e2e-constants';
import { installMockWallet } from '../support/mockWallet';
import { buildAssertion, syntheticKey } from '../fixtures/synthetic';

const SIDECAR = 'http://127.0.0.1:4175';
const SHOTS = process.env.E2E_SHOT_DIR;
const WIDTHS = [
  { name: 'desktop-1440', width: 1440, height: 1000 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'mobile-390', width: 390, height: 844 },
] as const;
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let world: E2eWorld;
test.beforeAll(async () => {
  world = (await (await fetch(`${E2E_PROVIDER}/world`)).json()) as E2eWorld;
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
});

async function blockExternal(page: Page, origin: string) {
  const external: string[] = [];
  await page.route(new RegExp(`^(?!${origin.replace(/[.:/]/g, '\\$&')}/).*`), (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  return external;
}

async function axe(page: Page, label: string) {
  // Scanned from the top: mid-scroll, axe's target-size counts a control that has scrolled under the sticky site
  // header as too small, though at rest it is a full 44 px (focus is kept clear by `scroll-padding-top`).
  await page.evaluate(() => window.scrollTo(0, 0));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
}

/**
 * A full-page capture stitches the page at one scroll position, which smears sticky bars into the middle
 * of the image; for that capture only they are pinned static. A viewport shot keeps the real sticky look.
 */
async function shoot(page: Page, name: string) {
  await page.screenshot({ path: join(SHOTS!, `${name}-viewport.png`) });
  // CSSOM writes (not an injected <style>, which the page's CSP rightly refuses).
  const sticky = '.lb-top, .lb-actionbar, .lb-manifest';
  await page.evaluate((sel) => document.querySelectorAll<HTMLElement>(sel).forEach((e) => e.style.setProperty('position', 'static', 'important')), sticky);
  await page.screenshot({ path: join(SHOTS!, `${name}-full.png`), fullPage: true });
  await page.evaluate((sel) => document.querySelectorAll<HTMLElement>(sel).forEach((e) => e.style.removeProperty('position')), sticky);
}

/** axe in both languages, then screenshots at each width in both languages; leaves EN at 1440. */
async function evidence(page: Page, state: string) {
  for (const lang of ['en', 'zh'] as const) {
    if (lang === 'zh') await page.getByTestId('lang-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('lang', lang === 'en' ? 'en' : 'zh-Hant-TW');
    await axe(page, `${state}/${lang}`);
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w.width, height: w.height });
      // Nothing may scroll sideways at any width (full addresses wrap, they are never cut).
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${state} ${lang} ${w.name} horizontal overflow`).toBeLessThanOrEqual(0);
      if (SHOTS) await shoot(page, `${state}-${w.name}-${lang}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
}

/**
 * A sheet in both languages at 1440 / 768 / 390: axe clean, and neither the page nor the sheet itself
 * scrolls sideways. Opens with `open`, closes with Escape (the language toggle sits behind the modal).
 */
async function sheetEvidence(page: Page, testId: string, ready: string, open: () => Promise<void>) {
  for (const lang of ['en', 'zh'] as const) {
    if (lang === 'zh') await page.getByTestId('lang-toggle').click();
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w.width, height: w.height });
      await open();
      const sheet = page.getByTestId(testId);
      await expect(sheet).toBeVisible();
      // Measured once the sheet's own content has loaded, not on its loading placeholder.
      await expect(sheet.getByTestId(ready)).toBeVisible({ timeout: 60_000 });
      if (w.width === 1440) await axe(page, `${testId}/${lang}`);
      const overflow = await sheet.evaluate((el) => {
        const body = el.querySelector('.lb-sheet-body')!;
        return { sheet: el.scrollWidth - el.clientWidth, body: body.scrollWidth - body.clientWidth, page: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      });
      expect(overflow, `${testId} ${lang} ${w.name} horizontal overflow`).toEqual({ sheet: 0, body: 0, page: 0 });
      if (SHOTS) await page.screenshot({ path: join(SHOTS, `sheet-${testId}-${w.name}-${lang}.png`) });
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();
    }
  }
  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test('logbook states: axe clean in EN and 繁中, no sideways scroll at 1440/768/390, screenshots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const external = await blockExternal(page, SIDECAR);
  const wallet = await installMockWallet(page, world);
  // The plans the page received (public calldata), so the test can play "someone else" deploying a step.
  let lastPlan: { steps: Array<{ key: string; state: string; to: string; data: string; gasLimit: string | null }> } | null = null;
  page.on('response', async (r) => {
    if (r.url().endsWith('/api/deploy/plan') && r.ok()) lastPlan = (await r.json().catch(() => null)) ?? lastPlan;
  });
  const B = world.accounts.B;
  await page.goto(`${SIDECAR}/recover`);
  await evidence(page, '01-start');

  await page.getByTestId('check-account').fill(B.address);
  await page.getByTestId('check-evidence-toggle').click();
  await page.getByTestId('check-owners').fill(B.owners.join('\n'));
  await page.getByTestId('check-nonce').fill(B.nonce);
  await page.getByTestId('check-run').click();
  await expect(page.locator('li[data-step="deploy"]')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await page.getByTestId('wallet-connect').click();
  // The step plans on entry (nothing signed or spent); its controls are then driven from the keyboard.
  await expect(page.getByTestId('deploy-progress')).toBeVisible({ timeout: 120_000 });
  await evidence(page, '02-deploy');

  // Press each needed step once it is offered, until the wallet is deployed and Move funds opens.
  // The last step (B's own wallet) is deployed by someone else while its confirmation is open: the page
  // re-reads the chain before asking the wallet, finds it done, and sends nothing (a duplicate CREATE2
  // would revert and spend gas).
  const moveOpen = page.locator('li[data-step="move"][data-state="current"]');
  const sendBtn = page.getByTestId('deploy-send');
  const call = async (method: string, params: unknown[]) => ((await (await fetch(world.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: unknown }).result;
  let otherDeployed = false;
  for (let guard = 0; guard < 600 && !(await moveOpen.count()); guard++) {
    if ((await sendBtn.count()) && (await sendBtn.isEnabled())) {
      const before = wallet.sent.length;
      const needed = lastPlan!.steps.filter((x) => x.state === 'needed');
      await sendBtn.press('Enter');
      if (needed.length === 1 && !otherDeployed) {
        const tx = (await call('eth_sendTransaction', [{ from: world.gasWallet, to: needed[0]!.to, data: needed[0]!.data, gas: '0x' + BigInt(needed[0]!.gasLimit!).toString(16) }])) as string;
        await expect.poll(async () => ((await call('eth_getTransactionReceipt', [tx])) as { status?: string } | null)?.status, { timeout: 30_000 }).toBe('0x1');
        otherDeployed = true;
        await page.getByTestId('deploy-send-confirm').press('Enter');
        await expect(moveOpen).toHaveCount(1, { timeout: 120_000 });
        expect(wallet.sent.length).toBe(before);
        break;
      }
      await page.getByTestId('deploy-send-confirm').press('Enter');
      await expect.poll(() => wallet.sent.length, { timeout: 60_000 }).toBe(before + 1);
    }
    await page.waitForTimeout(200);
  }
  expect(otherDeployed).toBe(true);
  await expect(page.locator('li[data-step="move"]')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });

  // Nothing in the intent is chosen for the user: asset, amount and both recipient fields start empty.
  await expect(page.getByTestId('move-asset')).toHaveValue('');
  for (const id of ['move-amount', 'move-to', 'move-to-again']) await expect(page.getByTestId(id)).toHaveValue('');
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.getByTestId('move-asset').selectOption({ label: 'USDT0' });
  await page.getByTestId('move-amount').fill('42.000001');
  // A paste into the confirmation field alone asks for the cross-check too; editing the primary clears it.
  await page.getByTestId('move-to').fill(world.recipient);
  await page.getByTestId('move-to-again').dispatchEvent('paste');
  await page.getByTestId('move-to-again').fill(world.recipient);
  await expect(page.getByTestId('move-pasted')).toBeVisible();
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.getByTestId('move-cross-check').check();
  await expect(page.getByTestId('move-review')).toBeEnabled();
  await page.getByTestId('move-to').fill(world.recipient.slice(0, -1));
  await page.getByTestId('move-to').fill(world.recipient);
  await expect(page.getByTestId('move-cross-check')).not.toBeChecked();
  await expect(page.getByTestId('move-review')).toBeDisabled();
  // Emptying both fields starts over: no paste is remembered.
  await page.getByTestId('move-to').fill('');
  await page.getByTestId('move-to-again').fill('');
  await page.getByTestId('move-to').fill(world.recipient);
  await page.getByTestId('move-to-again').fill(world.recipient);
  await expect(page.getByTestId('move-pasted')).toHaveCount(0);
  await expect(page.getByTestId('move-review')).toBeEnabled();
  await page.getByTestId('move-to').fill('');
  await page.getByTestId('move-to-again').fill('');
  // A paste into either recipient field asks for a separate cross-check before Review works — here the
  // primary field; the typed confirmation alone does not lift it.
  await page.getByTestId('move-to').dispatchEvent('paste');
  await page.getByTestId('move-to').fill(world.recipient);
  await page.getByTestId('move-to-again').fill(world.recipient);
  await expect(page.getByTestId('move-pasted')).toBeVisible();
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.getByTestId('move-cross-check').check();
  await expect(page.getByTestId('move-review')).toBeEnabled();
  // The tick is for one exact address: editing either field clears it.
  await page.getByTestId('move-to-again').fill(world.recipient.slice(0, -1));
  await page.getByTestId('move-to-again').fill(world.recipient);
  await expect(page.getByTestId('move-cross-check')).not.toBeChecked();
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.getByTestId('move-cross-check').check();
  // Glass is only the control layer (top bar, action bar); the content it floats over is solid paper.
  const layers = await page.evaluate(() => {
    const css = (sel: string) => { const c = getComputedStyle(document.querySelector(sel)!); return { filter: c.backdropFilter, bg: c.backgroundColor }; };
    return { top: css('.lb-top'), bar: css('li[data-step="move"] .lb-actionbar'), paper: css('li[data-step="move"] .lb-paper, li[data-step="move"] .lb-entry, .lb-manifest') };
  });
  for (const glass of [layers.top, layers.bar]) {
    expect(glass.filter).toContain('blur(18px)');
    expect(glass.bg).toMatch(/^rgba\(.*, 0\.\d+\)$/);
  }
  expect(layers.paper.filter).toBe('none');
  expect(layers.paper.bg).toMatch(/^rgb\(/);
  await evidence(page, '03-move-draft');
  await page.getByTestId('move-review').click();
  const sign = page.getByTestId('sign');
  await expect(sign).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('move').getByTestId('manifest-nonce')).toHaveText('0');
  // The countdown is this page's own window, and it says so: it does not revoke or expire a signature.
  await expect(page.getByTestId('review-window')).toContainText(/Local validity window \d+:\d\d/);
  await expect(page.getByTestId('review-window')).toContainText('It is not an on-chain expiry: a signed transfer stays valid until the wallet nonce is used.');
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('review-window')).toContainText(/本機有效時間 \d+:\d\d/);
  await expect(page.getByTestId('review-window')).toContainText('這不是鏈上的到期時間');
  await page.getByTestId('lang-toggle').click();
  await evidence(page, '04-review-sign');

  const hash = (await sign.getAttribute('data-userop-hash')) as `0x${string}`;
  await page.getByTestId('sign-assertion').fill(buildAssertion({ challenge: hexToBytes(hash), kind: 'userop', key: syntheticKey(B.passkey.seed) }).json);
  await page.getByTestId('sign-submit').click();
  await expect(page.getByTestId('signed')).toBeVisible({ timeout: 120_000 });
  await evidence(page, '05-signed');
  // Leaving /recover with the Send confirmation open (amount typed) closes it and sends nothing; coming back
  // keeps the signed transfer, and the confirmation asks for the amount again.
  const dialogOpen = (id: string) => page.getByTestId(id).evaluate((el) => (el as HTMLDialogElement).open);
  await page.getByTestId('nav-guide').click();
  await page.getByTestId('nav-recover').click();
  await expect(page.getByTestId('signed')).toBeVisible();
  const sentBefore = wallet.sent.length;
  await page.getByTestId('send').click();
  await page.getByTestId('send-sheet').getByTestId('send-typed').fill('42.000001');
  await expect(page.getByTestId('send-confirm')).toBeEnabled();
  await page.goBack();
  await expect(page.getByTestId('page-recover')).toBeHidden();
  await expect.poll(() => dialogOpen('send-sheet')).toBe(false);
  expect(wallet.sent.length).toBe(sentBefore);
  await page.goForward();
  await expect(page.getByTestId('send')).toBeEnabled();
  await page.getByTestId('send').click();
  await expect(page.getByTestId('send-typed')).toHaveValue('');
  await expect(page.getByTestId('send-confirm')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect.poll(() => dialogOpen('send-sheet')).toBe(false);
  await sheetEvidence(page, 'send-sheet', 'send-typed', () => page.getByTestId('send').click());
  await page.getByTestId('send').click();
  await page.getByTestId('send-sheet').getByTestId('send-typed').fill('42.000001');
  await axe(page, 'send-sheet');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '06-send-confirm-desktop-1440-en.png') });
  await page.getByTestId('send-sheet').getByTestId('send-confirm').click();
  const row = page.getByTestId('track-row').filter({ hasText: '42.000001' });
  await expect(row).toHaveAttribute('data-state', /confirmed|final/, { timeout: 120_000 });
  expect(wallet.sent.length).toBeGreaterThan(0);
  await evidence(page, '07-track-receipt');

  await page.getByTestId('top-report').click();
  const report = (await page.getByTestId('report-json').textContent())!;
  expect(report).not.toMatch(/https?:\/\//);
  expect(report).not.toContain(B.address);
  expect(report).not.toMatch(/0x[0-9a-fA-F]{13,}/);
  await axe(page, 'report-sheet');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '08-ai-report-desktop-1440-en.png') });
  // Copy and download hand over exactly the JSON shown — nothing more.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SIDECAR });
  await page.getByTestId('report-copy').click();
  expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText()))).toEqual(JSON.parse(report));
  await expect(page.getByTestId('report-copy')).toHaveAttribute('data-copy', 'ok');
  // Refused: said so, with the same JSON selectable by hand; a retry that works says copied, no manual text.
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new DOMException('Denied', 'NotAllowedError')) } }));
  await page.getByTestId('report-copy').click();
  await expect(page.getByTestId('report-copy')).toHaveAttribute('data-copy', 'blocked');
  expect(JSON.parse(await page.getByTestId('report-copy-manual').inputValue())).toEqual(JSON.parse(report));
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } }));
  await page.getByTestId('report-copy').click();
  await expect(page.getByTestId('report-copy')).toHaveAttribute('data-copy', 'ok');
  await expect(page.getByTestId('report-copy-manual')).toHaveCount(0);
  await page.evaluate(() => delete (navigator as unknown as { clipboard?: unknown }).clipboard);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('report-download').click()]);
  expect(dl.suggestedFilename()).toMatch(/^passkey-recovery-report-\d+\.json$/);
  const { readFile } = await import('node:fs/promises');
  expect(JSON.parse(await readFile((await dl.path())!, 'utf8'))).toEqual(JSON.parse(report));
  await page.keyboard.press('Escape');
  await page.getByTestId('top-help').click();
  await axe(page, 'help-sheet');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '09-help-desktop-1440-en.png') });
  await page.keyboard.press('Escape');
  await page.getByTestId('top-rpc').click();
  await expect(page.getByTestId('rpc-settings')).toBeVisible();
  await axe(page, 'rpc-sheet');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '10-rpc-desktop-1440-en.png') });
  await page.keyboard.press('Escape');
  for (const [id, btn, ready] of [['sheet-report', 'top-report', 'report-json'], ['sheet-help', 'top-help', 'sheet-help-close'], ['sheet-rpc', 'top-rpc', 'rpc-active'], ['sheet-proof', 'summary-prove', 'proof-start']] as const) {
    await sheetEvidence(page, id, ready, () => page.getByTestId(btn).click());
  }
  // Proof of control, from the check summary: B's Passkey is owner 1 (owner 0 is an address).
  await page.getByTestId('summary-prove').click();
  await expect(page.getByTestId('proof-owner')).toHaveValue('1');
  await page.getByTestId('proof-start').click();
  const challenge = (await page.getByTestId('proof-challenge').textContent())!.trim();
  await page.getByTestId('proof-input').fill(buildAssertion({ challenge: base64urlToBytes(challenge), key: syntheticKey(B.passkey.seed) }).json);
  await page.getByTestId('proof-verify').click();
  await expect(page.getByTestId('proof-result')).toHaveAttribute('data-status', 'valid');
  await axe(page, 'proof-sheet');
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '11-proof-desktop-1440-en.png') });
  const [proof] = await Promise.all([page.waitForEvent('download'), page.getByTestId('proof-download').click()]);
  const proofText = await (await import('node:fs/promises')).readFile((await proof.path())!, 'utf8');
  expect(JSON.parse(proofText)).toMatchObject({ format: 'cbpr-proof-report-v3', status: 'valid' });
  // Never the pasted assertion (INV-004), not even a valid proof's: no assertion field, none of its parts.
  const pasted = JSON.parse(await page.getByTestId('proof-input').inputValue()) as { signature: string; clientDataJSON: string; authenticatorData: string };
  expect(JSON.parse(proofText)).not.toHaveProperty('assertion');
  for (const part of [pasted.signature, pasted.clientDataJSON, pasted.authenticatorData]) expect(proofText).not.toContain(part);
  await page.keyboard.press('Escape');
  expect(external).toEqual([]);
});

test('closing one sheet and at once opening another: the first sheet’s late native close event does not shut the second', async ({ page }) => {
  const external = await blockExternal(page, SIDECAR);
  await page.goto(`${SIDECAR}/recover`);
  for (const [from, to, sheet] of [['top-rpc', 'top-help', 'sheet-help'], ['top-help', 'top-report', 'sheet-report']] as const) {
    await page.getByTestId(from).click();
    await expect(page.getByTestId(from === 'top-rpc' ? 'sheet-rpc' : 'sheet-help')).toBeVisible();
    // One task: close through the sheet's own button, then press the next opener before the dialog's queued close event runs.
    await page.evaluate(([closeId, openId]) => {
      (document.querySelector(`[data-testid="${closeId}"]`) as HTMLElement).click();
      (document.querySelector(`[data-testid="${openId}"]`) as HTMLElement).click();
    }, [from === 'top-rpc' ? 'sheet-rpc-close' : 'sheet-help-close', to] as const);
    await page.waitForTimeout(300);
    await expect(page.getByTestId(sheet)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(sheet)).toBeHidden();
  }
  expect(external).toEqual([]);
});

test('keyboard only: skip link, check form, sheets open with Enter and close with Escape, focus is visible', async ({ page }) => {
  const external = await blockExternal(page, SIDECAR);
  await page.goto(`${SIDECAR}/recover`);
  // The tool is a lazy chunk; the skip link's target is its current step.
  await page.locator('#current-step').waitFor();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to the current step' })).toBeFocused();
  // The focus ring is drawn (2px outline), not left to the browser default.
  expect(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineWidth)).toBe('2px');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('check-account')).toBeFocused();
  await page.keyboard.type(world.accounts.A.address);
  await page.keyboard.press('Enter');
  // Enter submits the check: a diagnosis (A undeployed) or, once flow.spec deployed A, the closed step's summary.
  await expect(page.locator('[data-testid="diagnosis"], [data-testid="check-edit"]').first()).toBeVisible({ timeout: 120_000 });

  // From the top of the page, Tab alone reaches Help and the language toggle; every stop shows a ring.
  const tabTo = async (testId: string) => {
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press('Tab');
      const at = await page.evaluate(() => ({ id: document.activeElement?.getAttribute('data-testid') ?? '', ring: getComputedStyle(document.activeElement!).outlineWidth }));
      expect(at.ring, `focus ring on ${at.id || 'element'}`).not.toBe('0px');
      if (at.id === testId) return;
    }
    throw new Error(`Tab never reached ${testId}`);
  };
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('body').focus();
  await tabTo('top-help');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('sheet-help')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sheet-help')).toBeHidden();
  await expect(page.getByTestId('top-help')).toBeFocused();
  await page.locator('body').focus();
  await tabTo('lang-toggle');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant-TW');
  expect(external).toEqual([]);
});

test('a confirmation sheet a step opened closes when the reader leaves /recover; Back and Forward return to the step, not to the open sheet', async ({ page }) => {
  await blockExternal(page, SIDECAR);
  await installMockWallet(page, world);
  const C = world.accounts.C;
  await page.goto(`${SIDECAR}/guide`);
  await page.getByTestId('nav-recover').click();
  await expect(page.getByTestId('wallet-connect')).toBeVisible();
  await page.getByTestId('wallet-connect').click();
  await page.getByTestId('check-account').fill(C.address);
  await page.getByTestId('check-evidence-toggle').click();
  await page.getByTestId('check-owners').fill(C.owners.join('\n'));
  await page.getByTestId('check-nonce').fill(C.nonce);
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('deploy-send')).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId('deploy-send').click();
  await expect(page.getByTestId('deploy-send-sheet')).toBeVisible();

  await page.goBack();
  await expect(page.getByTestId('page-recover')).toBeHidden();
  // Closed while the Guide shows, not only once the reader returns.
  await expect.poll(() => page.getByTestId('deploy-send-sheet').evaluate((el) => (el as HTMLDialogElement).open)).toBe(false);
  await page.goForward();
  await expect(page.getByTestId('page-recover')).toBeVisible();
  // The step is where it was (the plan kept, the button ready), but nothing is waiting to be confirmed.
  await expect(page.getByTestId('deploy-send-sheet')).toBeHidden();
  await expect(page.getByTestId('deploy-send')).toBeEnabled();
  await expect(page.locator('li[data-step="deploy"]')).toHaveAttribute('data-state', 'current');
});

test('keyboard only, end to end: wallet C is checked, deployed and moves 1 USDT0 by Tab, typing and Enter; every sheet returns focus', async ({ page }) => {
  const external = await blockExternal(page, SIDECAR);
  const wallet = await installMockWallet(page, world);
  const C = world.accounts.C;
  await page.goto(`${SIDECAR}/recover`);
  const tabTo = async (testId: string) => {
    for (let i = 0; i < 200; i++) {
      await page.keyboard.press('Tab');
      const at = await page.evaluate(() => ({ id: document.activeElement?.getAttribute('data-testid') ?? '', ring: getComputedStyle(document.activeElement!).outlineWidth }));
      expect(at.ring, `focus ring on ${at.id || 'element'}`).not.toBe('0px');
      if (at.id === testId) return;
    }
    throw new Error(`Tab never reached ${testId}`);
  };
  // The injected wallet is offered once EIP-6963 discovery has had its moment (useGasPayer DISCOVERY_MS).
  await expect(page.getByTestId('wallet-connect')).toBeVisible();
  await tabTo('wallet-connect');
  await page.keyboard.press('Enter');
  // Check: C is not deployed yet, so its creation evidence is entered from the keyboard too.
  await tabTo('check-account');
  await page.keyboard.type(C.address);
  await tabTo('check-evidence-toggle');
  await page.keyboard.press('Enter');
  await tabTo('check-owners');
  await page.keyboard.type(C.owners.join('\n'));
  await tabTo('check-nonce');
  await page.keyboard.type(C.nonce);
  await tabTo('check-run');
  await page.keyboard.press('Enter');
  await expect(page.locator('li[data-step="deploy"]')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  // Deploy: the shared contracts already exist, so only C's own wallet is needed. The confirmation
  // sheet closes on Escape and returns focus to the step button; the second time it is confirmed.
  // The step plans on entry: no plan key press.
  await expect(page.getByTestId('deploy-send')).toBeEnabled({ timeout: 120_000 });
  await page.locator('body').focus();
  await tabTo('deploy-send');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('deploy-send-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('deploy-send-sheet')).toBeHidden();
  await expect(page.getByTestId('deploy-send')).toBeFocused();
  expect(wallet.sent).toHaveLength(0);
  // Reopened at once (regression: the sheet's own close event used to arrive after this press and swallow it).
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('deploy-send-sheet')).toBeVisible();
  await tabTo('deploy-send-confirm');
  await page.keyboard.press('Enter');
  await expect(page.locator('li[data-step="move"]')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  expect(wallet.sent).toHaveLength(1);
  await tabTo('move-asset');
  await page.keyboard.type('U'); // type-ahead picks USDT0 on the closed select
  await expect(page.getByTestId('move-asset')).not.toHaveValue('');
  await tabTo('move-amount');
  await page.keyboard.type('1');
  await tabTo('move-to');
  await page.keyboard.type(world.recipient);
  await tabTo('move-to-again');
  await page.keyboard.type(world.recipient);
  await tabTo('move-review');
  await page.keyboard.press('Enter');
  const sign = page.getByTestId('sign');
  await expect(sign).toBeVisible({ timeout: 120_000 });
  const hash = (await sign.getAttribute('data-userop-hash')) as `0x${string}`;
  await tabTo('sign-assertion');
  await page.keyboard.insertText(buildAssertion({ challenge: hexToBytes(hash), kind: 'userop', key: syntheticKey(C.passkey.seed) }).json);
  await tabTo('sign-submit');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('signed')).toBeVisible({ timeout: 120_000 });
  const sentBefore = wallet.sent.length;
  await tabTo('send');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('send-sheet')).toBeVisible();
  await tabTo('send-typed');
  await page.keyboard.type('1');
  await tabTo('send-confirm');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('move-sent')).toBeVisible({ timeout: 60_000 });
  expect(wallet.sent.length).toBe(sentBefore + 1);
  await expect(page.getByTestId('track-row').first()).toHaveAttribute('data-state', /confirmed|final/, { timeout: 120_000 });
  for (const [btn, sheet] of [['top-report', 'sheet-report'], ['top-rpc', 'sheet-rpc'], ['top-help', 'sheet-help'], ['summary-prove', 'sheet-proof']] as const) {
    await page.locator('body').focus();
    await tabTo(btn);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId(sheet)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId(sheet)).toBeHidden();
    await expect(page.getByTestId(btn)).toBeFocused();
  }
  expect(external).toEqual([]);
});

test('a review past its local window: shown as expired, nothing to sign, axe clean in EN and 繁中', async ({ page }) => {
  await page.clock.install();
  const external = await blockExternal(page, SIDECAR);
  await installMockWallet(page, world);
  await page.goto(`${SIDECAR}/recover`);
  await page.getByTestId('wallet-connect').click();
  await page.getByTestId('check-account').fill(world.accounts.B.address);
  await page.getByTestId('check-run').click();
  await expect(page.locator('li[data-step="move"]')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await page.getByTestId('move-asset').selectOption({ label: 'XPL' });
  await page.getByTestId('move-amount').fill('0.01');
  await page.getByTestId('move-to').fill(world.recipient);
  await page.getByTestId('move-to-again').fill(world.recipient);
  await page.getByTestId('move-review').click();
  await expect(page.getByTestId('sign')).toBeVisible({ timeout: 120_000 });
  await page.clock.fastForward('10:30');
  await expect(page.getByTestId('review-expired')).toBeVisible();
  await expect(page.getByTestId('sign')).toHaveCount(0);
  await axe(page, 'review-expired/en');
  await page.getByTestId('lang-toggle').click();
  await axe(page, 'review-expired/zh');
  await page.getByTestId('lang-toggle').click();

  // PM-06: "Review again" waits for the latest balances, like Review in the form — held, then failed, then read.
  const again = page.getByTestId('review-again');
  const bal = page.getByTestId('move-balance');
  await expect(again).toBeEnabled();
  let releaseRead!: () => void;
  const readHeld = new Promise<void>((r) => (releaseRead = r));
  await page.route('**/api/diagnose', async (route) => {
    await readHeld;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'upstream RPC did not answer' }) });
  });
  await page.getByTestId('move-balance-refresh').click();
  await expect(bal).toHaveAttribute('data-state', 'reading');
  await expect(again).toBeDisabled();
  releaseRead();
  await expect(bal).toHaveAttribute('data-state', 'failed');
  await expect(again).toBeDisabled();
  await page.unroute('**/api/diagnose');
  await page.getByTestId('move-balance-refresh').click();
  await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
  await expect(again).toBeEnabled();
  expect(external).toEqual([]);
});

test('fonts: both Atkinson Hyperlegible faces load from this origin and are listed with their SIL Open Font License 1.1', async ({ page }) => {
  const external = await blockExternal(page, SIDECAR);
  await page.goto(`${SIDECAR}/recover`);
  const fonts = await page.evaluate(async () => {
    await Promise.all(['400 16px "Atkinson Hyperlegible Next"', '700 16px "Atkinson Hyperlegible Next"', '400 16px "Atkinson Hyperlegible Mono"', '700 16px "Atkinson Hyperlegible Mono"'].map((f) => document.fonts.load(f)));
    const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => `${f.family.replace(/"/g, '')} ${f.weight}`);
    const files = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /\.(woff2?|ttf|otf)(\?|$)/.test(n));
    return { loaded, files, origin: location.origin };
  });
  for (const face of ['Atkinson Hyperlegible Next 400', 'Atkinson Hyperlegible Next 700', 'Atkinson Hyperlegible Mono 400', 'Atkinson Hyperlegible Mono 700']) expect(fonts.loaded).toContain(face);
  expect(fonts.files.length).toBeGreaterThanOrEqual(4);
  for (const f of fonts.files) expect(f.startsWith(`${fonts.origin}/`)).toBe(true);
  const { readFile } = await import('node:fs/promises');
  const notices = await readFile(join(process.cwd(), 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const name of ['Atkinson Hyperlegible Next', 'Atkinson Hyperlegible Mono']) expect(notices).toMatch(new RegExp(`${name}[^\n]*SIL Open Font License 1\\.1`));
  expect(external).toEqual([]);
});

test('dark color scheme: the disconnected "Connect wallet" chip and the start page stay axe clean', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const external = await blockExternal(page, SIDECAR);
  await installMockWallet(page, world);
  await page.goto(`${SIDECAR}/recover`);
  await expect(page.getByTestId('wallet-connect')).toBeVisible();
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => v.id)).toEqual([]);
  await page.getByTestId('wallet-connect').hover();
  const hovered = await new AxeBuilder({ page }).include('[data-testid="wallet-connect"]').withRules(['color-contrast']).analyze();
  expect(hovered.violations).toEqual([]);
  expect(external).toEqual([]);
});

test('reduced motion and reduced transparency: no animation, solid surfaces', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const external = await blockExternal(page, SIDECAR);
  // Playwright has no option for reduced transparency; the DevTools protocol emulates the media feature.
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }, { name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await page.goto(`${SIDECAR}/recover`);
  await page.getByTestId('top-help').click();
  const seen = await page.evaluate(() => {
    const els = [...document.querySelectorAll<HTMLElement>('.logbook *, .lb-sheet *')];
    const moving = els.filter((e) => { const c = getComputedStyle(e); return c.transitionDuration.split(',').some((d) => parseFloat(d) > 0) || c.animationName !== 'none'; });
    const glass = [...document.querySelectorAll<HTMLElement>('.lb-top, .lb-actionbar, .lb-sheet')].map((e) => { const c = getComputedStyle(e); return { filter: c.backdropFilter, bg: c.backgroundColor }; });
    return { matches: matchMedia('(prefers-reduced-transparency: reduce)').matches, checked: els.length, moving: moving.length, glass };
  });
  expect(seen.matches).toBe(true);
  expect(seen.checked).toBeGreaterThan(20);
  expect(seen.moving).toBe(0);
  expect(seen.glass.length).toBeGreaterThanOrEqual(2);
  for (const g of seen.glass) {
    expect(g.filter).toBe('none');
    // Solid: an opaque background (no alpha channel below 1).
    expect(g.bg).toMatch(/^rgb\(/);
  }
  expect(external).toEqual([]);
  await ctx.close();
});

test('static build without the sidecar: a real error state, no inert steps, no external request', async ({ page }) => {
  const external = await blockExternal(page, 'http://127.0.0.1:4174');
  await page.goto('/#/recover');
  await expect(page.getByTestId('no-sidecar')).toBeVisible();
  await expect(page.getByTestId('check-run')).toBeDisabled();
  await expect(page.getByTestId('top-rpc')).toBeDisabled();
  await axe(page, 'no-sidecar');
  await page.getByTestId('lang-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant-TW');
  await axe(page, 'no-sidecar/zh');
  await page.getByTestId('lang-toggle').click();
  // The footer credits the author and links the harness; Source code stays on the site (the repository is not
  // public yet, PM-05); nothing else leaves the page.
  const footer = page.locator('footer.lb-footer');
  await expect(footer).toContainText('sd0x');
  const hrefs = await footer.locator('a').evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
  expect(hrefs).toEqual(expect.arrayContaining(['https://github.com/sd0xdev', 'https://github.com/sd0xdev/sd0x-harness']));
  if (SHOTS) await page.screenshot({ path: join(SHOTS, '00-no-sidecar-desktop-1440-en.png'), fullPage: true });
  expect(external).toEqual([]);
});
