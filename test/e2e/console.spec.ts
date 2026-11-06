// Page hygiene and the proof-of-control sheet in the real browser. Headers and the no-secret-inputs
// check run on the static build (vite preview, 4174); the proof sheet needs a checked wallet, so it runs
// on the real sidecar bundle (4175, SYNTHETIC testchain) with synthetic wallet A checked from its
// creation evidence. Every assertion is built in Node from a throwaway fixture key. The page may talk
// only to its own origin; anything else is aborted (never answered with fake data).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { base64urlToBytes } from '../../src/crypto/bytes';
import { E2E_PROVIDER, type E2eWorld } from '../support/e2e-constants';
import { buildAssertion, syntheticKey } from '../fixtures/synthetic';

const SIDECAR = 'http://127.0.0.1:4175';
test.describe.configure({ timeout: 180_000 });
const external: string[] = [];

/** axe (WCAG 2.2 AA tags) on the state the page is in now. */
async function axeNow(p: Page, label: string) {
  const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.map((v) => `${label}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
}
let world: E2eWorld;

test.beforeAll(async () => {
  world = (await (await fetch(`${E2E_PROVIDER}/world`)).json()) as E2eWorld;
});

test.beforeEach(async ({ page }) => {
  external.length = 0;
  await page.route(/^(?!http:\/\/127\.0\.0\.1:417[45]\/).*/, (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
});
test.afterEach(() => expect(external).toEqual([]));

/** Checks wallet A (with its evidence, so it works deployed or not), opens the proof sheet, makes a challenge. */
async function openProof(page: Page, lang: 'en' | 'zh' = 'en') {
  const A = world.accounts.A;
  await page.goto(`${SIDECAR}/recover`);
  // The sheet is modal, so the language is chosen before it opens.
  if (lang === 'zh') {
    await page.getByTestId('lang-toggle').click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant-TW');
  }
  await page.getByTestId('check-account').fill(A.address);
  await page.getByTestId('check-evidence-toggle').click();
  await page.getByTestId('check-owners').fill(A.owners.join('\n'));
  await page.getByTestId('check-nonce').fill(A.nonce);
  await page.getByTestId('check-run').click();
  // Supported → the check step closes, and its summary line offers the proof.
  await expect(page.getByTestId('summary-prove')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('summary-prove').click();
  await expect(page.getByTestId('sheet-proof')).toBeVisible();
  await page.getByTestId('proof-start').click();
  return (await page.getByTestId('proof-challenge').textContent())!.trim();
}

const right = () => syntheticKey(world.accounts.A.passkey.seed);
const wrong = () => syntheticKey(0x7e);

test('served page carries CSP and no-referrer headers', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("style-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(res.headers()['referrer-policy']).toBe('no-referrer');
});

test('no seed / private-key / password inputs anywhere on the page', async ({ page }) => {
  await page.goto('/recover');
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  for (const ph of await page.locator('input, textarea').evaluateAll((els) => els.map((e) => `${e.getAttribute('placeholder') ?? ''} ${e.getAttribute('aria-label') ?? ''}`.toLowerCase()))) {
    expect(ph).not.toMatch(/seed|mnemonic|private key|助記詞|私鑰/);
  }
});

test('proof: the right fixture key → valid; the helper is the bundled one for this challenge', async ({ page }) => {
  const challenge = await openProof(page);
  await expect(page.getByTestId('proof-helper-sha256')).toContainText(/[0-9a-f]{64}/);
  await expect(page.getByTestId('proof-statement')).toContainText(world.accounts.A.address);
  await page.getByTestId('proof-input').fill(buildAssertion({ challenge: base64urlToBytes(challenge), key: right() }).json);
  await page.getByTestId('proof-verify').click();
  await expect(page.getByTestId('proof-result')).toHaveAttribute('data-status', 'valid');
  await expect(page.getByTestId('proof-result').locator('li[data-ok="false"]')).toHaveCount(0);
  await axeNow(page, 'proof-valid/en');
});

test('proof: a different key → mismatch on the signature only', async ({ page }) => {
  const challenge = await openProof(page);
  await page.getByTestId('proof-input').fill(buildAssertion({ challenge: base64urlToBytes(challenge), key: wrong() }).json);
  await page.getByTestId('proof-verify').click();
  const result = page.getByTestId('proof-result');
  await expect(result).toHaveAttribute('data-status', 'mismatch');
  await expect(result.locator('li[data-ok="false"]')).toHaveCount(1);
  await expect(result.locator('li[data-ok="false"]')).toHaveAttribute('data-check', 'signature');
  await axeNow(page, 'proof-mismatch/en');
});

test('proof: editing the signature discards the verdict and its export', async ({ page }) => {
  const challenge = await openProof(page);
  await page.getByTestId('proof-input').fill(buildAssertion({ challenge: base64urlToBytes(challenge), key: right() }).json);
  await page.getByTestId('proof-verify').click();
  await expect(page.getByTestId('proof-result')).toBeVisible();
  await page.getByTestId('proof-input').fill('{"format":"cbpr-assertion-v1"}');
  await expect(page.getByTestId('proof-result')).toHaveCount(0);
  await expect(page.getByTestId('proof-download')).toHaveCount(0);
});

test('proof: a shown valid verdict turns expired when the 10-minute window closes', async ({ page }) => {
  await page.clock.install();
  const challenge = await openProof(page);
  await page.getByTestId('proof-input').fill(buildAssertion({ challenge: base64urlToBytes(challenge), key: right() }).json);
  await page.getByTestId('proof-verify').click();
  const result = page.getByTestId('proof-result');
  await expect(result).toHaveAttribute('data-status', 'valid');
  await page.clock.fastForward('10:02');
  await expect(result).toHaveAttribute('data-status', 'expired');
  await expect(result.locator('li[data-check="expiry"]')).toHaveAttribute('data-ok', 'false');
  await axeNow(page, 'proof-expired/en');
});

test('proof: garbage → format-error, never valid; nothing lands in storage, URL or cookies', async ({ page, context }) => {
  await openProof(page);
  await page.getByTestId('proof-input').fill('{"format":"not-it"');
  await page.getByTestId('proof-verify').click();
  await expect(page.getByTestId('proof-result')).toHaveAttribute('data-status', 'format-error');
  await axeNow(page, 'proof-format-error/en');
  const store = await page.evaluate(() => ({ keys: Object.keys(localStorage).filter((k) => k !== 'cbpr.tracking.v1'), s: sessionStorage.length, u: location.href }));
  expect(store).toEqual({ keys: [], s: 0, u: `${SIDECAR}/recover` });
  expect(await context.cookies()).toEqual([]);
});

test('proof results in 繁中: valid, mismatch, format-error and expired are all axe clean', async ({ page }) => {
  await page.clock.install();
  const challenge = await openProof(page, 'zh');
  const result = page.getByTestId('proof-result');
  const verify = async (input: string, status: string) => {
    await page.getByTestId('proof-input').fill(input);
    await page.getByTestId('proof-verify').click();
    await expect(result).toHaveAttribute('data-status', status);
    await axeNow(page, `proof-${status}/zh`);
  };
  await verify(buildAssertion({ challenge: base64urlToBytes(challenge), key: wrong() }).json, 'mismatch');
  await verify('{"format":"not-it"', 'format-error');
  await verify(buildAssertion({ challenge: base64urlToBytes(challenge), key: right() }).json, 'valid');
  await page.clock.fastForward('10:02');
  await expect(result).toHaveAttribute('data-status', 'expired');
  await axeNow(page, 'proof-expired/zh');
});

test('the extension bridge is offered only on 127.0.0.1:4173: here it says so, sends nothing, and the helper stays', async ({ page }) => {
  // A page-visible chrome.runtime (as if some extension matched this origin): the client must still refuse.
  await page.addInitScript(() => {
    (window as unknown as { chrome: unknown }).chrome = { runtime: { sendMessage: () => ((window as unknown as { __bridgeSent: number }).__bridgeSent = 1) } };
  });
  await openProof(page);
  await expect(page.getByTestId('bridge-unavailable')).toContainText('http://127.0.0.1:4173');
  await expect(page.getByTestId('bridge-start')).toHaveCount(0);
  await page.getByTestId('proof-advanced').locator('summary').click();
  await expect(page.getByTestId('proof-helper')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __bridgeSent?: number }).__bridgeSent ?? 0)).toBe(0);
});
