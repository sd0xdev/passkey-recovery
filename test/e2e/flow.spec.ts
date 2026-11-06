// The full M4 product flow in the real browser against the real sidecar bundle (127.0.0.1:4175,
// SYNTHETIC testchain that starts with no infrastructure): check a counterfactual wallet from its
// creation evidence → deploy it step by step through the user's EIP-1193 wallet (mock: anvil's dev
// account signs) → move funds with a Passkey-format assertion built in Node from a throwaway fixture key
// over the page's own UserOp hash → track to a receipt. Interruptions on the way: a rejected deploy step,
// a deploy step whose wallet answer is lost, a rejected send, a send with no hash, and a page refresh.
// Nonces 0, 1 and 2 on one wallet. Nothing real: no network, no real wallet, no real Passkey.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page, type Route } from '@playwright/test';
import { hexToBytes } from '../../src/crypto/bytes';
import { buildHelper } from '../../src/webauthn/helper';
import { SUPPORTED } from '../../src/config/registry';
import { initCodeFor } from '../../src/wallet/derive';
import { handleOpsData } from '../../server/sim';
import type { UserOperationV06 } from '../../src/userop/hash';
import { E2E_PROVIDER, type E2eWorld } from '../support/e2e-constants';
import { installMockWallet, type MockWallet } from '../support/mockWallet';
import { buildAssertion, syntheticKey } from '../fixtures/synthetic';

const SIDECAR = 'http://127.0.0.1:4175';
test.describe.configure({ mode: 'serial', timeout: 240_000 });

let world: E2eWorld;
let ctx: BrowserContext;
let page: Page;
let wallet: MockWallet;
const external: string[] = [];
/** What the Terminal signer received for the nonce-3 hand-off: the signed op, never broadcast by the page. */
let claimed: { op: Record<string, string>; gasWallet: `0x${string}` } | null = null;

/** axe (WCAG 2.2 AA tags) on the state the page is in now, in English and 繁中. */
async function axeBoth(p: Page, label: string) {
  for (const lang of ['en', 'zh'] as const) {
    if (lang === 'zh') await p.getByTestId('lang-toggle').click();
    const r = await new AxeBuilder({ page: p }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    expect(r.violations.map((v) => `${label}/${lang}: ${v.id} ${v.nodes[0]?.target.join(' ')} ${v.nodes[0]?.failureSummary ?? ''}`)).toEqual([]);
  }
  await p.getByTestId('lang-toggle').click();
  await expect(p.locator('html')).toHaveAttribute('lang', 'en');
}

async function balance(addr: string): Promise<bigint> {
  const r = (await (await fetch(world.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [addr, 'latest'] }) })).json()) as { result: string };
  return BigInt(r.result);
}

/** A decimal amount in 10^-18 units, so two shown figures can be compared exactly. */
function units(s: string): bigint {
  const [i, f = ''] = s.trim().split('.');
  return BigInt(i!) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
/** The USDT0 figure Move shows and the block it was read at (PM-06). */
async function usdt0Shown(): Promise<{ amount: string; block: string }> {
  const bal = page.getByTestId('move-balance');
  const text = (await bal.textContent()) ?? '';
  const m = /Balance ([\d.]+) USDT0/.exec(text);
  expect(m, text).not.toBeNull();
  return { amount: m![1]!, block: (await bal.getAttribute('data-block'))! };
}
/** USDT0 as Move showed it before the first transfer. */
let preTransfer: { amount: string; block: string } | null = null;

async function openPage(browser: Browser) {
  ctx = await browser.newContext();
  page = await ctx.newPage();
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4175\/).*/, (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  wallet = await installMockWallet(page, world);
  await page.goto(`${SIDECAR}/recover`);
}

test.beforeAll(async ({ browser }) => {
  world = (await (await fetch(`${E2E_PROVIDER}/world`)).json()) as E2eWorld;
  await openPage(browser);
});
test.afterAll(async () => {
  expect(external).toEqual([]);
  await ctx.close();
});

const step = (k: string) => page.locator(`li[data-step="${k}"]`);

/**
 * Home-page Demo stills (6-recovery-atlas.md §3): only when E2E_DEMO_DIR is set (scripts/design/capture-demo.mjs),
 * the real UI is captured here, on this SYNTHETIC testchain — never a real wallet, link or code. Off by default.
 */
const DEMO_DIR = process.env.E2E_DEMO_DIR;
async function demoShot(name: string, stepKey: string, at: ReturnType<Page['locator']>, action?: ReturnType<Page['locator']>) {
  if (!DEMO_DIR) return;
  await expect(at).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  // Framed from the step's heading, just below the site header: the still shows the tool, not a second
  // clickable-looking header, and both the heading and the stage it is named for are inside the clip.
  const head = step(stepKey).locator('.lb-step-head');
  await head.evaluate((el) => { el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -88); });
  const clip = { x: 0, y: 64, width: 1280, height: 736 };
  // A still whose point is an action (Check's "Add creation data", PM-03c): framed lower if needed so the whole action
  // sits above the step's sticky action bar; then the still shows the stage and its action, not the heading.
  if (action) {
    const bar = (await step(stepKey).locator('.lb-actionbar').boundingBox())!;
    const b = (await action.boundingBox())!;
    const over = b.y + b.height + 16 - Math.min(bar.y, clip.y + clip.height);
    if (over > 0) await page.evaluate((dy) => window.scrollBy(0, dy), over);
    const a = (await action.boundingBox())!;
    const barNow = (await step(stepKey).locator('.lb-actionbar').boundingBox())!;
    expect(a.y, `${name} action inside the still`).toBeGreaterThanOrEqual(clip.y);
    expect(a.y + a.height, `${name} action above the action bar`).toBeLessThanOrEqual(Math.min(barNow.y, clip.y + clip.height));
  }
  for (const [what, loc] of (action ? [['stage', at]] : [['heading', head], ['stage', at]]) as Array<[string, ReturnType<Page['locator']>]>) {
    const b = await loc.boundingBox();
    expect(b, `${name} ${what}`).not.toBeNull();
    expect(b!.y, `${name} ${what} starts inside the still`).toBeGreaterThanOrEqual(clip.y);
    expect(b!.y, `${name} ${what} starts inside the still`).toBeLessThan(clip.y + clip.height - 40);
  }
  await page.screenshot({ path: `${DEMO_DIR}/${name}.png`, clip });
}

/** Signs the page's current UserOp hash with the account's fixture key, the way a Passkey would. */
async function signOnPage(seed: number) {
  const sign = page.getByTestId('sign');
  await expect(sign).toBeVisible();
  const hash = (await sign.getAttribute('data-userop-hash')) as `0x${string}`;
  // The helper the page offers is the bundled one for exactly this hash.
  await page.getByTestId('sign-advanced').locator('summary').click();
  expect(await page.getByTestId('sign-helper').textContent()).toBe(buildHelper(hexToBytes(hash), 'userop').source);
  const a = buildAssertion({ challenge: hexToBytes(hash), kind: 'userop', key: syntheticKey(seed) });
  await page.getByTestId('sign-assertion').fill(a.json);
  await page.getByTestId('sign-submit').click();
  await expect(page.getByTestId('signed')).toBeVisible({ timeout: 120_000 });
}

async function confirmSend(amount: string) {
  await page.getByTestId('send').click();
  const sheet = page.getByTestId('send-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('send-confirm')).toBeDisabled();
  // GAS-01: the irreversible sheet names the full gas payer (here the connected browser wallet).
  await expect(sheet.getByTestId('manifest-payer')).toHaveAttribute('data-value', world.gasWallet);
  await expect(sheet.getByTestId('manifest-payer')).toBeVisible();
  await sheet.getByTestId('send-typed').fill(amount);
  await sheet.getByTestId('send-confirm').click({ timeout: 15_000 });
  await expect(sheet).toBeHidden();
}

async function draft(amount: string, asset: 'XPL' | 'USDT0') {
  await page.getByTestId('move-asset').selectOption({ label: asset });
  await page.getByTestId('move-amount').fill(amount);
  await page.getByTestId('move-to').fill(world.recipient);
  await page.getByTestId('move-to-again').fill(world.recipient);
  await expect(page.getByTestId('move-match')).toBeVisible();
  await page.getByTestId('move-review').click();
}

test('check: an undeployed wallet needs its creation evidence; malformed calldata is an error, its raw createAccount calldata and its pasted initCode (factory ‖ calldata) are each accepted', async () => {
  await expect(page.getByTestId('testchain-banner')).toBeVisible();
  await page.getByTestId('check-account').fill(world.accounts.A.address);
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('diagnosis')).toHaveAttribute('data-supported', 'false');
  // PM-03: only the creation evidence is missing → one more input with a way on, not "can't help".
  await expect(page.getByTestId('diagnosis')).toHaveAttribute('data-needs-evidence', 'true');
  await expect(page.getByTestId('check-needs-evidence')).toContainText('One more input');
  await expect(page.getByTestId('diagnosis')).not.toContainText('can’t help');
  await demoShot('demo-check', 'check', page.getByTestId('check-needs-evidence'), page.getByTestId('check-add-evidence'));
  await page.getByTestId('check-add-evidence').click();
  await expect(page.getByTestId('check-calldata')).toBeFocused();
  // Evidence that derives another address is a stop, not "one more input": the blocking heading, no
  // continuation button, and no link to the not-yet-public repository (PM-05).
  await page.getByTestId('check-calldata').fill(initCodeFor(SUPPORTED[0]!, world.accounts.A.owners as `0x${string}`[], BigInt(world.accounts.A.nonce) + 1n));
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('diagnosis')).toHaveAttribute('data-needs-evidence', 'false');
  await expect(page.getByTestId('diagnosis')).toHaveAttribute('data-supported', 'false');
  await expect(page.getByTestId('check-add-evidence')).toHaveCount(0);
  await expect(page.getByTestId('diagnosis').locator('h3.lb-tone-bad')).toHaveText('We can’t help with this wallet yet');
  await expect(page.getByTestId('diagnosis').locator('a[href*="github.com/sd0xdev/passkey-recovery"]')).toHaveCount(0);
  // Malformed raw calldata: a visible error from the parser, and Check stays where it is.
  await page.getByTestId('check-calldata').fill('0x3a3e2b4f00');
  const malformed = page.waitForRequest((r) => r.url().endsWith('/api/diagnose'));
  await page.getByTestId('check-run').click();
  expect(((await malformed).postDataJSON() as { evidence?: unknown }).evidence).toEqual({ calldata: '0x3a3e2b4f00' });
  await expect(page.getByTestId('app-error')).toBeVisible();
  await expect(step('deploy')).not.toHaveAttribute('data-state', 'current');
  // The raw createAccount calldata (initCode without the factory address) is sent as calldata and accepted.
  const full = initCodeFor(SUPPORTED[0]!, world.accounts.A.owners as `0x${string}`[], BigInt(world.accounts.A.nonce));
  const calldata = `0x${full.slice(42)}`;
  await page.getByTestId('check-calldata').fill(calldata);
  const raw = page.waitForRequest((r) => r.url().endsWith('/api/diagnose'));
  await page.getByTestId('check-run').click();
  expect(((await raw).postDataJSON() as { evidence?: unknown }).evidence).toEqual({ calldata });
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  // Supported: the tool moves on to Deploy (Check folds into its summary).
  await expect(step('deploy')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  // Checked again with the pasted initCode (factory ‖ createAccount calldata): accepted as initCode, not as calldata.
  await page.getByTestId('check-edit').click();
  const details = page.getByTestId('check-evidence-toggle').locator('xpath=..');
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await page.getByTestId('check-evidence-toggle').click();
  await page.getByTestId('check-calldata').fill(full);
  const init = page.waitForRequest((r) => r.url().endsWith('/api/diagnose'));
  await page.getByTestId('check-run').click();
  expect(((await init).postDataJSON() as { evidence?: unknown }).evidence).toEqual({ initCode: full });
  // Supported: the tool moves on to Deploy (Check folds into its summary).
  await expect(step('deploy')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
});

test('deploy: a rejected step sends nothing; a lost wallet answer re-plans instead of resending', async () => {
  await expect(page.getByTestId('deploy-need-wallet')).toBeVisible();
  await page.getByTestId('wallet-connect').click();
  await expect(page.getByTestId('wallet-connected')).toHaveAttribute('data-account', world.gasWallet);
  // Entering the step with a ready payer plans at once (a chain read and a fork simulation): no click,
  // and nothing is asked of the wallet until a step is confirmed.
  await expect(page.getByTestId('deploy')).toHaveAttribute('data-progress', /^0\/\d$/, { timeout: 120_000 });
  expect(wallet.sent).toHaveLength(0);
  const total = Number((await page.getByTestId('deploy').getAttribute('data-progress'))!.split('/')[1]);
  expect(total).toBeGreaterThanOrEqual(2);

  // The wallet holds the request (nothing broadcast) and the user declines it later.
  wallet.next('defer');
  // GAS-01 (browser wallet mode): the full payer address in the step preview and the final confirmation.
  await expect(page.getByTestId('deploy-payer')).toHaveAttribute('data-value', world.gasWallet);
  await demoShot('demo-deploy', 'deploy', page.getByTestId('deploy-payer'));
  await page.getByTestId('deploy-send').click();
  await expect(page.getByTestId('deploy-confirm-payer')).toHaveAttribute('data-value', world.gasWallet);
  await page.getByTestId('deploy-send-confirm').click();
  // PM-01c: while the gas payer has the request, the header says so; a refusal turns it to "needs attention".
  await expect.poll(() => wallet.deferred(), { timeout: 60_000 }).toBe(1);
  await expect(page.getByTestId('step-word-deploy')).toHaveText('Waiting for the gas payer');
  wallet.answerDeferred('reject');
  await expect(page.getByTestId('deploy-rejected')).toBeVisible();
  await expect(page.getByTestId('step-word-deploy')).toHaveText('Needs attention');
  expect(wallet.sent).toHaveLength(0);
  await axeBoth(page, 'deploy-rejected');

  // Step 1: the wallet broadcasts but the page is reloaded before it answers. The send was recorded
  // before the wallet was asked, so after the reload the page checks the chain for that step instead of
  // offering it again: it is done, and nothing is sent twice.
  wallet.next('hold');
  await page.getByTestId('deploy-send').click();
  await page.getByTestId('deploy-send-confirm').click();
  await expect.poll(() => wallet.sent.length, { timeout: 60_000 }).toBe(1);
  const stored = await page.evaluate(() => localStorage.getItem('cbpr.deploy.v1') ?? '');
  expect(stored).toContain('"txHash":null');
  expect(stored.toLowerCase()).not.toContain(world.accounts.A.address.slice(2).toLowerCase());
  expect(stored.toLowerCase()).not.toContain(world.gasWallet.slice(2).toLowerCase());
  await page.reload();
  await page.getByTestId('check-account').fill(world.accounts.A.address);
  await page.getByTestId('check-evidence-toggle').click();
  await page.getByTestId('check-owners').fill(world.accounts.A.owners.join('\n'));
  await page.getByTestId('check-nonce').fill(world.accounts.A.nonce);
  await page.getByTestId('check-run').click();
  await expect(step('deploy')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  if (await page.getByTestId('wallet-connect').isVisible()) await page.getByTestId('wallet-connect').click();
  await expect(page.getByTestId('deploy')).toHaveAttribute('data-progress', `1/${total}`, { timeout: 120_000 });
  expect(wallet.sent).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('cbpr.deploy.v1'))).toBeNull();

  // Step 2: the wallet sends but the answer is lost → the page checks the chain, sees it done, never asks again.
  wallet.next('no-hash');
  await expect(page.getByTestId('deploy-send')).toBeEnabled({ timeout: 60_000 });
  // PM-01: a planned step nobody has sent yet is the user's turn — the header is not busy before a send.
  await expect(page.getByTestId('step-word-deploy')).toHaveText('Your turn');
  await page.getByTestId('deploy-send').click();
  await page.getByTestId('deploy-send-confirm').click();
  await expect(page.getByTestId('deploy')).toHaveAttribute('data-progress', `2/${total}`, { timeout: 120_000 });
  expect(wallet.sent).toHaveLength(2);

  // Step 3, with the sidecar failing at the two worst moments (fault injection on the page's own API
  // calls; the chain and the wallet are real): one step-verdict poll errors → the poll retries instead of
  // stalling; then the re-plan after "confirmed" errors → the confirmed step is NOT offered again (the old
  // plan still lists it as needed); only an explicit successful "plan again" moves on.
  expect(total).toBeGreaterThanOrEqual(3);
  let trackFails = 1;
  let planFails = 0;
  // The first verdict poll is also held for a moment: the step was broadcast and its verdict is not in yet.
  let releaseTrack!: () => void;
  const trackHeld = new Promise<void>((r) => (releaseTrack = r));
  let trackAsked!: () => void;
  const trackSeen = new Promise<void>((r) => (trackAsked = r));
  await page.route('**/api/deploy/track', async (route) => {
    if (trackFails > 0) {
      trackAsked();
      await trackHeld;
    }
    if (trackFails-- > 0) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'upstream RPC unavailable (injected)' }) });
    planFails = 1;
    return route.fallback();
  });
  await page.route('**/api/deploy/plan', async (route) => {
    if (planFails-- > 0) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'upstream RPC unavailable (injected)' }) });
    return route.fallback();
  });
  await expect(page.getByTestId('deploy-send')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('deploy-send').click();
  await page.getByTestId('deploy-send-confirm').click();
  // PM-01c: sent, verdict not in yet → "Waiting for the block", in EN and 繁中 (never "Your turn" or "Done").
  await trackSeen;
  try {
    await expect(page.getByTestId('step-word-deploy')).toHaveText('Waiting for the block');
    await page.getByTestId('lang-toggle').click();
    await expect(page.getByTestId('step-word-deploy')).toHaveText('等待區塊確認');
    await page.getByTestId('lang-toggle').click();
    await expect(page.getByTestId('step-word-deploy')).toHaveText('Waiting for the block');
  } finally {
    releaseTrack();
  }
  await expect(page.getByTestId('app-error')).toContainText('injected', { timeout: 60_000 });
  await expect(page.getByTestId('deploy-plan')).toBeVisible({ timeout: 60_000 });
  await axeBoth(page, 'deploy-error');
  await expect(page.getByTestId('deploy-send')).toHaveCount(0);
  expect(wallet.sent).toHaveLength(3);
  await page.unroute('**/api/deploy/track');
  await page.unroute('**/api/deploy/plan');
  await page.getByTestId('deploy-plan').click();
  if (total > 3) await expect(page.getByTestId('deploy')).toHaveAttribute('data-progress', `3/${total}`, { timeout: 120_000 });

  for (let n = 4; n <= total; n++) {
    await expect(page.getByTestId('deploy-send')).toBeEnabled({ timeout: 60_000 });
    await page.getByTestId('deploy-send').click();
    await page.getByTestId('deploy-send-confirm').click();
    if (n < total) await expect(page.getByTestId('deploy')).toHaveAttribute('data-progress', `${n}/${total}`, { timeout: 120_000 });
  }
  await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  expect(wallet.sent).toHaveLength(total);
  await expect(step('deploy')).toHaveAttribute('data-state', 'done');
});

test('move nonce 0 (USDT0): review → sign → signed simulation → send → tracked to a receipt', async () => {
  // UX-1 Move words: nothing open yet → "Choose a transfer"; reviewed but unsigned → not "Ready to send";
  // signed and the signed transfer simulated → "Ready to send".
  await expect(page.getByTestId('step-word-move')).toHaveText('Choose a transfer');
  await page.getByTestId('move-asset').selectOption({ label: 'USDT0' });
  await expect(page.getByTestId('move-balance')).toHaveAttribute('data-state', 'fresh');
  preTransfer = await usdt0Shown();
  await draft('1.5', 'USDT0');
  await expect(page.getByTestId('sign')).toBeVisible({ timeout: 120_000 });
  // PM-01: a reviewed, unsigned transfer is the user's to continue — not "In progress".
  await expect(page.getByTestId('step-word-move')).toHaveText('Continue the transfer');
  await expect(page.getByTestId('review-window')).toContainText(/\d+:\d\d/, { timeout: 120_000 });
  const manifest = page.getByTestId('move').getByTestId('manifest');
  await expect(manifest).toHaveAttribute('data-verified', 'true');
  await expect(manifest.getByTestId('manifest-nonce')).toHaveText('0');
  await expect(manifest.getByTestId('fee-network')).toBeVisible();
  await expect(manifest.getByTestId('fee-wallet')).toBeVisible();
  await signOnPage(world.accounts.A.passkey.seed);
  await expect(page.getByTestId('step-word-move')).toHaveText('Ready to send', { timeout: 120_000 });
  await demoShot('demo-approve', 'move', page.getByTestId('signed'));
  // PM-06: once Track sees this wallet's transfer in a block, the balances are read again without being asked.
  const reread = page.waitForRequest('**/api/diagnose', { timeout: 120_000 });
  await confirmSend('1.5');
  await expect(page.getByTestId('move-sent')).toBeVisible({ timeout: 60_000 });
  const row = page.getByTestId('track-row').first();
  await expect(row).toHaveAttribute('data-state', /confirmed|final/, { timeout: 60_000 });
  await reread;
  await expect(row.getByTestId('receipt')).toContainText('1.5 USDT0');
  // UX-1: the two fee legs are named separately on the receipt, never summed into one number.
  const fees = row.getByTestId('receipt-fees');
  await expect(fees.getByTestId('fee-network')).toBeVisible();
  await expect(fees.getByTestId('fee-wallet')).toBeVisible();
  await expect(fees).toContainText('not added together');
  await expect(page.getByTestId('step-word-move')).toHaveText('Sent');
  // UX-1: a transfer in a block that is not final yet is still followed on chain; once the only transfer is final,
  // Track says so — never a busy word beside a finished receipt. (The testchain does not finalise on its own:
  // the tracker's real answer is marked final, the way the tracker reports it once the block is.)
  await expect(page.getByTestId('step-word-track')).toHaveText('Following the chain');
  // UX-1 fee roles: the tracker's decoded bundle sender and handleOps beneficiary are shown on their own legs,
  // and the export names both without a combined field. Rewritten while still confirmed (Track keeps polling).
  const BUNDLER = '0xabcdef0000000000000000000000000000abcdef';
  const OTHER = '0x2222222222222222222222222222222222222222';
  // Known amounts on each leg (decimal strings, as the sidecar sends bigints): 0.0002 XPL network, 0.0001 XPL wallet.
  let roles: { bundler: string | null; beneficiary: string | null; outerFeeWei?: string; actualGasCost?: string } | 'real' = { bundler: BUNDLER, beneficiary: OTHER, outerFeeWei: '200000000000000', actualGasCost: '100000000000000' };
  let finalise = false;
  await page.route('**/api/track', async (route) => {
    const real = (await (await route.fetch()).json()) as { state: string; detail?: string; confirmations?: string | number | null; receipt?: Record<string, unknown> };
    const receipt = real.receipt && roles !== 'real' ? { ...real.receipt, ...roles } : real.receipt;
    // Marked final the way the tracker reports it once the depth is reached: the confirmations and the detail agree
    // with "final" (the Demo still is captured from this answer), never "1 confirmation(s); final at N" beside it.
    const depth = finalise && real.state === 'confirmed' ? /final at (\d+)/.exec(real.detail ?? '')?.[1] : undefined;
    const final = depth ? { state: 'final', confirmations: typeof real.confirmations === 'number' ? Number(depth) : depth, detail: `${depth} confirmations (tool finality depth ${depth})` } : {};
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...real, receipt, ...final }) });
  });
  const exported = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), row.getByTestId('receipt-export').click()]);
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile((await dl.path())!, 'utf8')) as Record<string, unknown>;
  };
  const addr = (leg: string) => fees.getByTestId(leg).locator('.lb-addr');
  // Different payer and payee: each leg names its own address, no "same address" line.
  await expect(addr('fee-network')).toHaveAttribute('data-value', BUNDLER, { timeout: 15_000 });
  await expect(addr('fee-wallet')).toHaveAttribute('data-value', OTHER);
  await expect(fees.getByTestId('fee-same')).toHaveCount(0);
  // Each amount and role on its own leg: the network fee paid by the bundle sender, the wallet fee charged to
  // this wallet toward the beneficiary — in EN and in 繁中.
  await expect(fees.getByTestId('fee-network').locator('dd.lb-mono')).toHaveText(/^0\.00020*\s+XPL$/);
  await expect(fees.getByTestId('fee-network')).toContainText('Paid in XPL by the address that sent the bundle');
  await expect(fees.getByTestId('fee-wallet').locator('dd.lb-mono')).toHaveText(/^0\.00010*\s+XPL$/);
  await expect(fees.getByTestId('fee-wallet')).toContainText('Charged to this wallet; it counts toward the bundle’s payment to the beneficiary');
  await page.getByTestId('lang-toggle').click();
  await expect(fees.getByTestId('fee-network')).toContainText('由送出 bundle 的地址以 XPL 支付');
  await expect(fees.getByTestId('fee-wallet')).toContainText('由這個錢包付出，計入 bundle 付給 beneficiary 的款項');
  await expect(fees).toContainText('不會相加');
  await page.getByTestId('lang-toggle').click();
  let json = await exported();
  expect([json.networkFeePaidBy, json.walletFeePaidTo]).toEqual([BUNDLER, OTHER]);
  expect(Object.keys(json).filter((k) => /total|sum|combined/i.test(k))).toEqual([]);
  // The same address in two cases: still two legs, plus the line saying the bundle sender was paid back.
  const shouted = BUNDLER.toUpperCase().replace('0X', '0x');
  expect(shouted).not.toBe(BUNDLER);
  roles = { bundler: BUNDLER, beneficiary: shouted };
  await expect(fees.getByTestId('fee-same')).toHaveCount(1, { timeout: 15_000 });
  await expect(fees.getByTestId('fee-same')).toHaveText('That beneficiary is the same address that sent the bundle.');
  await expect(addr('fee-network')).toHaveCount(1);
  await expect(addr('fee-wallet')).toHaveCount(1);
  // Not decoded: no address is invented, the legs stay, and the export says null rather than guessing.
  roles = { bundler: null, beneficiary: null };
  await expect(addr('fee-network')).toHaveCount(0, { timeout: 15_000 });
  await expect(addr('fee-wallet')).toHaveCount(0);
  await expect(fees.getByTestId('fee-same')).toHaveCount(0);
  json = await exported();
  expect([json.networkFeePaidBy, json.walletFeePaidTo]).toEqual([null, null]);
  roles = 'real';
  finalise = true;
  await expect(row).toHaveAttribute('data-state', 'final', { timeout: 30_000 });
  await expect(step('track')).toHaveAttribute('data-word', 'allFinal');
  await expect(page.getByTestId('step-word-track')).toHaveText('All final');
  await expect(row.getByTestId('receipt')).toBeVisible();
  await demoShot('demo-track', 'track', row);
  await page.unroute('**/api/track');
});

test('PM-06/07/08: after a success — "Next transfer", balances read again (held, failed, out of order, over the balance), copies per request, "Clear and start over"', async () => {
  // PM-07: this transfer is in a block and succeeded → "Next transfer"; PM-09: its row is "This transfer".
  const next = page.getByTestId('move-new');
  await expect(next).toHaveAttribute('data-kind', 'next');
  await expect(next).toHaveText('Next transfer');
  await expect(page.getByTestId('move-clear-note')).toHaveCount(0);
  const row0 = page.getByTestId('track-row').first();
  await expect(row0).toHaveAttribute('data-current', 'current');
  await expect(row0.getByTestId('track-which')).toHaveText('This transfer');
  await page.getByTestId('lang-toggle').click();
  await expect(next).toHaveText('再來一筆');
  await expect(row0.getByTestId('track-which')).toHaveText('這一筆');
  await page.getByTestId('lang-toggle').click();

  // PM-06: the read again on "Next transfer" is held — Review waits; what is typed meanwhile is kept.
  let releaseRead!: () => void;
  const readHeld = new Promise<void>((r) => (releaseRead = r));
  await page.route('**/api/diagnose', async (route) => {
    await readHeld;
    await route.fallback();
  });
  // A read again only reads: from "Next transfer" through a held, a failed and a retried read, nothing is
  // previewed, signed, sent or unlocked, and the tracking records stay the same ones.
  const forbidden: string[] = [];
  const watchWrites = (r: { url(): string }) => {
    if (/\/api\/transfer\/|\/api\/deploy\/|\/gas\/[^/]*\/?(unlock|sign)|\/gas\/sign/.test(r.url())) forbidden.push(r.url());
  };
  page.on('request', watchWrites);
  const trackedOps = () => page.evaluate(() => (JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as { record: { userOpHash: string } }[]).map((x) => x.record.userOpHash).sort().join(','));
  const opsBefore = await trackedOps();
  const sendsBefore = wallet.sent.length;
  await next.click();
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  await expect(page.getByTestId('move-to')).toHaveValue('');
  const bal = page.getByTestId('move-balance');
  await expect(bal).toHaveAttribute('data-state', 'reading');
  await page.getByTestId('move-asset').selectOption({ label: 'USDT0' });
  await page.getByTestId('move-amount').fill('0.5');
  await page.getByTestId('move-to').fill(world.recipient);
  await page.getByTestId('move-to-again').fill(world.recipient);
  await expect(page.getByTestId('move-match')).toBeVisible();
  await expect(page.getByTestId('move-review')).toBeDisabled();
  releaseRead();
  await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
  await page.unroute('**/api/diagnose');
  await expect(page.getByTestId('move-amount')).toHaveValue('0.5');
  await expect(page.getByTestId('move-review')).toBeEnabled();
  // The figure is the new one: 1.5 USDT0 less than before the first transfer, read at a later block.
  const after = await usdt0Shown();
  expect(units(preTransfer!.amount) - units(after.amount)).toBe(units('1.5'));
  expect(BigInt(after.block)).toBeGreaterThan(BigInt(preTransfer!.block));

  // Over the fresh balance: Review is blocked and says why; back under it, Review is open again.
  await page.getByTestId('move-amount').fill(String(BigInt(after.amount.split('.')[0]!) + 1n));
  await expect(page.getByTestId('move-over')).toBeVisible();
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.getByTestId('move-amount').fill('0.5');
  await expect(page.getByTestId('move-over')).toHaveCount(0);

  // A read that fails: said so with the old block, Review waits, and "Try again" reads it.
  await page.route('**/api/diagnose', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'upstream RPC did not answer' }) }));
  await page.getByTestId('move-balance-refresh').click();
  await expect(bal).toHaveAttribute('data-state', 'failed');
  await expect(bal).toContainText('Could not read the balance again');
  await expect(bal).toContainText(after.block);
  await expect(page.getByTestId('move-balance-refresh')).toHaveText('Try again');
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.getByTestId('lang-toggle').click();
  await expect(bal).toContainText('無法重新讀取餘額');
  await expect(page.getByTestId('move-balance-refresh')).toHaveText('再試一次');
  await page.getByTestId('lang-toggle').click();
  await page.unroute('**/api/diagnose');
  await page.getByTestId('move-balance-refresh').click();
  await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
  await expect(page.getByTestId('move-review')).toBeEnabled();
  await expect(page.getByTestId('move-amount')).toHaveValue('0.5');
  page.off('request', watchWrites);
  expect(forbidden).toEqual([]);
  expect(wallet.sent.length).toBe(sendsBefore);
  expect(await trackedOps()).toBe(opsBefore);

  // A read from an RPC behind the block holding the last transfer is not the latest: said so, Review waits.
  await page.route('**/api/diagnose', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...((await res.json()) as object), block: '1' } });
  });
  await page.getByTestId('move-balance-refresh').click();
  await expect(bal).toHaveAttribute('data-state', 'failed');
  await expect(bal).toContainText('the RPC answered at block 1, before block');
  await expect(bal).toHaveAttribute('data-block', after.block);
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.unroute('**/api/diagnose');
  // A read where this token's balance did not come back: no figure to check against, Review waits.
  await page.route('**/api/diagnose', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { balances: { tokens: Record<string, string | null> } };
    const tokens = Object.fromEntries(Object.keys(body.balances.tokens).map((k) => [k, null]));
    await route.fulfill({ response: res, json: { ...body, balances: { ...body.balances, tokens } } });
  });
  await page.getByTestId('move-balance-refresh').click();
  await expect(page.getByTestId('move-unread')).toContainText('USDT0 balance could not be read');
  await expect(bal).toHaveAttribute('data-state', 'fresh');
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.unroute('**/api/diagnose');
  await page.getByTestId('move-balance-refresh').click();
  await expect(page.getByTestId('move-unread')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('move-review')).toBeEnabled();

  // Out of order: an earlier read answering after a later one changes nothing (its figures are made up here).
  let n = 0;
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((r) => (releaseFirst = r));
  let firstDone!: () => void;
  const firstFulfilled = new Promise<void>((r) => (firstDone = r));
  await page.route('**/api/diagnose', async (route) => {
    if (++n > 1) return route.fallback();
    const res = await route.fetch();
    const body = (await res.json()) as { block: string; balances: { tokens: Record<string, string | null> } };
    await firstHeld;
    const tokens = Object.fromEntries(Object.keys(body.balances.tokens).map((k) => [k, '999000000']));
    await route.fulfill({ response: res, json: { ...body, block: '1', balances: { ...body.balances, tokens } } });
    firstDone();
  });
  await page.getByTestId('move-balance-refresh').click();
  await expect.poll(() => n).toBe(1);
  await page.getByTestId('move-balance-refresh').click();
  await expect.poll(() => n).toBe(2);
  await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
  const latest = await usdt0Shown();
  releaseFirst();
  await firstFulfilled;
  await page.waitForTimeout(300);
  await expect(bal).toHaveAttribute('data-block', latest.block);
  await expect(bal).not.toContainText('999');
  await page.unroute('**/api/diagnose');

  // PM-08: the second transfer's request code. Copies are written only (a stub records them; nothing reads the clipboard).
  await page.getByTestId('move-review').click();
  const bm = page.getByTestId('sign-bookmarklet');
  await expect(bm).toBeVisible({ timeout: 120_000 });
  const code = (await bm.getByTestId('sign-bookmarklet-code').textContent())!.trim();
  const status = bm.getByTestId('sign-bookmarklet-copy-status');
  const manual = bm.getByTestId('sign-bookmarklet-manual');
  const stub = (how: 'ok' | 'reject' | 'none' | 'throw' | 'slow-bookmark') =>
    page.evaluate((how) => {
      const w = window as unknown as { __writes: string[] };
      w.__writes ??= [];
      const writeText = (t: string) => {
        if (how === 'throw') throw new Error('not allowed');
        if (how === 'reject') return Promise.reject(new Error('denied'));
        if (how === 'slow-bookmark') return t.startsWith('javascript:') ? new Promise<void>((r) => setTimeout(() => (w.__writes.push(t), r()), 1_500)) : Promise.reject(new Error('denied'));
        w.__writes.push(t);
        return Promise.resolve();
      };
      Object.defineProperty(navigator, 'clipboard', { value: how === 'none' ? undefined : { writeText }, configurable: true });
    }, how);
  const writes = () => page.evaluate(() => (window as unknown as { __writes: string[] }).__writes);
  await stub('ok');
  await bm.getByTestId('sign-bookmarklet-copy-code').click();
  await expect(status).toHaveAttribute('data-copy', 'ok');
  await expect(status).toHaveAttribute('data-what', 'code');
  await expect(status).toHaveText('Request code copied');
  expect((await writes()).at(-1)).toBe(code);
  // Refused: said so, with the code selectable on screen; a retry that works clears it.
  await stub('reject');
  await bm.getByTestId('sign-bookmarklet-copy-code').click();
  await expect(status).toHaveAttribute('data-copy', 'failed');
  await expect(manual).toHaveValue(code);
  await stub('ok');
  await bm.getByTestId('sign-bookmarklet-copy-code').click();
  await expect(status).toHaveAttribute('data-copy', 'ok');
  await expect(manual).toHaveCount(0);
  // No Clipboard API, or one that throws at once: failures too, with the bookmarklet's text to copy by hand.
  await stub('none');
  await bm.getByTestId('sign-bookmarklet-copy-bookmark').click();
  await expect(status).toHaveAttribute('data-copy', 'failed');
  await expect(status).toHaveAttribute('data-what', 'bookmark');
  await expect(manual).toHaveValue(/^javascript:/);
  await stub('throw');
  await bm.getByTestId('sign-bookmarklet-copy-code').click();
  await expect(manual).toHaveValue(code);
  // Only the latest copy decides: a slow earlier one that succeeds later does not turn a later failure into "copied".
  await stub('slow-bookmark');
  await bm.getByTestId('sign-bookmarklet-copy-bookmark').click();
  await bm.getByTestId('sign-bookmarklet-copy-code').click();
  await expect(status).toHaveAttribute('data-what', 'code');
  await expect.poll(async () => (await writes()).some((t) => t.startsWith('javascript:')), { timeout: 5_000 }).toBe(true);
  await expect(status).toHaveAttribute('data-copy', 'failed');
  await expect(status).toHaveAttribute('data-what', 'code');
  // The DevTools helper's copy: a refusal shows the helper source for copying by hand.
  await page.getByTestId('sign-advanced').locator('summary').click();
  await stub('reject');
  await page.getByTestId('sign-copy-helper').click();
  await expect(page.getByTestId('sign-copy-helper-blocked')).toBeVisible();
  await expect(page.getByTestId('sign-copy-helper-manual')).toHaveValue(/navigator\.credentials\.get/);
  await stub('ok');

  // PM-07 "Clear and start over" on a signed, unsent transfer: discarded here, never sent, not called revoked.
  await signOnPage(world.accounts.A.passkey.seed);
  await expect(page.getByTestId('signed')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('move-clear-signed')).toContainText('not revoked on chain');
  // The limit is the wallet nonce, not the page's review window.
  await expect(page.getByTestId('move-clear-signed')).toContainText('wallet nonce');
  await expect(page.getByTestId('move-clear-signed')).not.toContainText('expires');
  const sentBefore = wallet.sent.length;
  // The runner does not confirm the discard (503): said so, the signed plan stays, nothing is sent.
  await page.route('**/api/transfer/discard', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'runner unavailable' }) }));
  await page.getByTestId('move-clear').click();
  await expect(page.getByTestId('app-error')).toContainText('the runner did not confirm it discarded this transfer');
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
  await expect(page.getByTestId('signed')).toBeVisible();
  await page.unroute('**/api/transfer/discard');
  // Regression: "Discard this transfer" is guarded the same way. It used to drop the signed plan from the page
  // whatever the runner answered (a plan the runner still held could then be re-made and sent twice from two
  // pages) and left Send pressable while its request was out. Now: nothing else acts on the plan until the
  // runner answers, a non-confirmation keeps the plan and says so, and Send is back once it has answered.
  let releaseRefusal!: () => void;
  const refusalHeld = new Promise<void>((r) => (releaseRefusal = r));
  await page.route('**/api/transfer/discard', async (route) => {
    await refusalHeld;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'runner unavailable' }) });
  });
  const refused = page.waitForResponse((r) => r.url().endsWith('/api/transfer/discard'));
  await page.getByTestId('review-discard').click();
  for (const id of ['move-clear', 'send', 'review-discard', 'send-handoff']) await expect(page.getByTestId(id)).toBeDisabled();
  releaseRefusal();
  await refused;
  await expect(page.getByTestId('app-error')).toContainText('Not discarded: the runner did not confirm it discarded this transfer');
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
  await expect(page.getByTestId('signed')).toBeVisible();
  await expect(page.getByTestId('send')).toBeEnabled();
  await expect(page.getByTestId('review-discard')).toBeEnabled();
  expect(wallet.sent.length).toBe(sentBefore);
  await page.unroute('**/api/transfer/discard');
  // Pressed again while the runner has already forgotten the plan (404, as after expiry or a restart; the
  // synthetic sidecar does discard it underneath): nothing is left to discard, so it clears, and the earlier
  // "Not cleared" goes with the old form. While the discard has not reached the runner yet, nothing else can
  // act on the plan: no second Clear, no Send, no Discard, no Terminal hand-off.
  let releaseDiscard!: () => void;
  const discardHeld = new Promise<void>((r) => (releaseDiscard = r));
  await page.route('**/api/transfer/discard', async (route) => {
    await discardHeld;
    const actual = await route.fetch();
    expect(actual.status()).toBe(200);
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unknown plan (discarded, or the sidecar restarted)' }) });
  });
  const discarded = page.waitForResponse((r) => r.url().endsWith('/api/transfer/discard'));
  await page.getByTestId('move-clear').click();
  for (const id of ['move-clear', 'send', 'review-discard', 'send-handoff']) await expect(page.getByTestId(id)).toBeDisabled();
  // Meanwhile the gas wallet changes: Move opens again with the typed draft kept. The old Clear's answer
  // belongs to nothing on screen any more — it neither empties that form nor puts an error on it.
  const otherPayer = '0x7b4c0d3e5f6a71829304b5c6d7e8f9a012b3c4d5';
  await wallet.switchAccount(otherPayer);
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft', { timeout: 60_000 });
  const kept = await page.getByTestId('move-amount').inputValue();
  expect(kept).not.toBe('');
  releaseDiscard();
  await discarded;
  await page.unroute('**/api/transfer/discard');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('move-amount')).toHaveValue(kept);
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  await wallet.switchAccount(world.gasWallet);
  // On a live form: Review the kept draft, and the runner has already forgotten that plan (404; the synthetic
  // sidecar does discard it underneath): nothing is left to discard, so Clear empties the form, no error.
  await expect(page.getByTestId('move-review')).toBeEnabled({ timeout: 60_000 });
  await page.getByTestId('move-review').click();
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'previewed', { timeout: 120_000 });
  await page.route('**/api/transfer/discard', async (route) => {
    const actual = await route.fetch();
    expect(actual.status()).toBe(200);
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unknown plan (discarded, or the sidecar restarted)' }) });
  });
  await page.getByTestId('move-clear').click();
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  await expect(page.getByTestId('move-amount')).toHaveValue('');
  await page.unroute('**/api/transfer/discard');
  await expect(page.getByTestId('app-error')).toHaveCount(0);
  expect(wallet.sent.length).toBe(sentBefore);
  await expect(page.getByTestId('move-to')).toHaveValue('');
  await expect(page.getByTestId('move-amount')).toHaveValue('');
  await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
  // A new request is a new copy state: nothing reads "copied" before anything was copied.
  await draft('0.5', 'USDT0');
  await expect(bm).toBeVisible({ timeout: 120_000 });
  await expect(status).toHaveCount(0);
  await page.getByTestId('move-clear').click();
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  expect(wallet.sent.length).toBe(sentBefore);
  // 390 px: the balance line, its button and Clear fit without sideways scrolling.
  const wide = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('move-amount').fill('0.5');
  await expect(page.getByTestId('move-clear')).toBeVisible();
  await expect(page.getByTestId('move-balance-refresh')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.setViewportSize(wide);
  await axeBoth(page, 'move-balance-fresh');
  await page.getByTestId('move-clear').click();
  await expect(page.getByTestId('move-amount')).toHaveValue('');

  // Stale answers across a new Check: a balance read asked before Check ran again — for the same account,
  // after an RPC re-check, or for another account — changes nothing when it answers late (made-up figures).
  const holdOneRead = async () => {
    let k = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let done!: () => void;
    const fulfilled = new Promise<void>((r) => (done = r));
    await page.route('**/api/diagnose', async (route) => {
      if (++k > 1) return route.fallback();
      const res = await route.fetch();
      const body = (await res.json()) as { block: string; balances: { tokens: Record<string, string | null> } };
      await held;
      const tokens = Object.fromEntries(Object.keys(body.balances.tokens).map((key) => [key, '999000000']));
      await route.fulfill({ response: res, json: { ...body, block: '1', balances: { ...body.balances, tokens } } });
      done();
    });
    await page.getByTestId('move-balance-refresh').click();
    await expect(bal).toHaveAttribute('data-state', 'reading');
    return { release, fulfilled };
  };
  const checkAgain = async (account: string) => {
    if (await page.getByTestId('check-edit').count()) await page.getByTestId('check-edit').click();
    await page.getByTestId('check-account').fill(account);
    await page.getByTestId('check-run').click();
    await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
    await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
    return { block: (await bal.getAttribute('data-block'))!, text: (await bal.textContent())! };
  };
  const lateAnswerIgnored = async (old: { release: () => void; fulfilled: Promise<void> }, now: { block: string; text: string }) => {
    old.release();
    await old.fulfilled;
    await page.waitForTimeout(300);
    await expect(bal).toHaveAttribute('data-block', now.block);
    await expect(bal).toHaveText(now.text);
    await page.unroute('**/api/diagnose');
  };
  // (a) Check again, same account.
  let old = await holdOneRead();
  await lateAnswerIgnored(old, await checkAgain(world.accounts.A.address));
  // (b) The RPC is checked again: what was read through it is void and Check opens again.
  old = await holdOneRead();
  await page.getByTestId('top-rpc').click();
  await page.getByTestId('rpc-check').click();
  await page.getByTestId('sheet-rpc-close').click();
  await expect(step('check')).toHaveAttribute('data-state', 'current', { timeout: 60_000 });
  await lateAnswerIgnored(old, await checkAgain(world.accounts.A.address));
  // (c) Another account (B, not deployed here) is checked, then account A again: A's read asked before both
  // answers last and changes nothing.
  old = await holdOneRead();
  await page.getByTestId('check-edit').click();
  await page.getByTestId('check-account').fill(world.accounts.B.address);
  const bAnswered = page.waitForResponse((r) => r.url().endsWith('/api/diagnose') && (r.request().postDataJSON() as { account?: string }).account === world.accounts.B.address, { timeout: 120_000 });
  await page.getByTestId('check-run').click();
  await bAnswered;
  await expect(page.getByTestId('check-busy')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('move')).toHaveCount(0);
  await lateAnswerIgnored(old, await checkAgain(world.accounts.A.address));

  // A Check answered by an RPC behind the block holding the last transfer is not the latest balances either.
  await page.route('**/api/diagnose', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...((await res.json()) as object), block: '1' } });
  });
  await page.getByTestId('check-edit').click();
  await page.getByTestId('check-run').click();
  await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(bal).toHaveAttribute('data-state', 'failed');
  await expect(bal).toContainText('the RPC answered at block 1, before block');
  await page.unroute('**/api/diagnose');
  await page.getByTestId('move-asset').selectOption({ label: 'USDT0' });
  await page.getByTestId('move-amount').fill('0.5');
  await page.getByTestId('move-to').fill(world.recipient);
  await page.getByTestId('move-to-again').fill(world.recipient);
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.getByTestId('move-balance-refresh').click();
  await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
  await expect(page.getByTestId('move-review')).toBeEnabled();
  await page.getByTestId('move-clear').click();
  await expect(page.getByTestId('move-amount')).toHaveValue('');
});

test('move nonce 1 (XPL): a rejected send leaves the signed plan; the second press sends it', async () => {
  const before = await balance(world.recipient);
  await draft('0.25', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('1', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  const sentBefore = wallet.sent.length;
  const records = () => page.evaluate(() => (JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as unknown[]).length);
  const recordsBefore = await records();
  wallet.next('reject');
  await confirmSend('0.25');
  await expect(page.getByTestId('send-rejected')).toBeVisible({ timeout: 60_000 });
  expect(wallet.sent.length).toBe(sentBefore);
  // Refused, nothing kept for it: Track does not call it "this transfer" (nor the earlier one "earlier").
  await expect(page.getByTestId('track-which')).toHaveCount(0);
  // The record written before the wallet was asked is taken back once the refusal is recorded: refused
  // sends never hold places in the 20-record list.
  await expect.poll(records).toBe(recordsBefore);
  // Refused again, and this time the sidecar's answer to the report is lost (as after an RPC switch, which
  // turns the plan unknown and refuses the report): the refusal alone takes the record back.
  await page.route('**/api/transfer/wallet-result', async (route) => {
    await route.fetch();
    await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'the plan is not waiting for a wallet result' }) });
  });
  wallet.next('reject');
  await confirmSend('0.25');
  await expect(page.getByTestId('app-error')).toBeVisible({ timeout: 60_000 });
  await page.unroute('**/api/transfer/wallet-result');
  expect(wallet.sent.length).toBe(sentBefore);
  await expect.poll(records).toBe(recordsBefore);
  await axeBoth(page, 'send-rejected');
  // PM-09: a send still with the payer after 20 s says so — never "fork simulation … nothing is sent" — and
  // Track is not "All final" because the earlier transfer is.
  let releaseSend!: () => void;
  const sendHeld = new Promise<void>((r) => (releaseSend = r));
  await page.route('**/api/transfer/send-request', async (route) => {
    const res = await route.fetch();
    await sendHeld;
    await route.fulfill({ response: res });
  });
  await confirmSend('0.25');
  const slow = page.getByTestId('send-sending-slow');
  await expect(slow).toBeVisible({ timeout: 40_000 });
  await expect(slow).toHaveAttribute('data-slow', 'send');
  await expect(slow).toContainText('Do not send it again');
  await expect(slow).not.toContainText(/simulation|nothing is sent/);
  // While the page waits for the payer's answer it must still record the hash it returns: no Clear, no Discard.
  await expect(page.getByTestId('move-clear')).toBeDisabled();
  await expect(page.getByTestId('review-discard')).toBeDisabled();
  await expect(page.getByTestId('step-word-track')).toHaveText('Following the chain');
  await page.getByTestId('lang-toggle').click();
  await expect(slow).toContainText('請不要再送一次');
  await expect(slow).not.toContainText(/模擬|不會送出/);
  await page.getByTestId('lang-toggle').click();
  // PM-07: this transfer lands but its inner call fails (the tracker's answer for nonce 1 is rewritten to
  // inner-failed; the chain itself is real). Move then offers "Clear and start over", not "Next transfer".
  // `laterBlock`: further below, the same op is reported in a later block (a shallow reorg).
  let laterBlock: string | null = null;
  // `replaced`: further below, the block holding the op is reported replaced (Track `reorged`).
  let replaced = false;
  // `refusedWithoutHash`: the RPC refuses the event search (synthetic). For nonce 1 a record without a tx
  // hash gets the tracker's refused answer, so only the hash the wallet returned lets Track verify it.
  let refusedWithoutHash = 0;
  // Track's polls that carry a nonce-1 hash wait here until the not-saved state has been checked.
  let releaseHashed!: () => void;
  const hashedHeld = new Promise<void>((r) => (releaseHashed = r));
  // The hashes Track's nonce-1 polls carried (the wallet's lead, kept in memory while storage refuses it).
  const hashedPolls: string[] = [];
  await page.route('**/api/track', async (route) => {
    const asked = route.request().postDataJSON() as { record?: { nonce?: string; txHash?: string | null } };
    if (asked.record?.nonce === '1' && asked.record.txHash) {
      hashedPolls.push(asked.record.txHash.toLowerCase());
      await hashedHeld;
    }
    const res = await route.fetch();
    const real = (await res.json()) as { state: string; block: string | null };
    const mine = asked.record?.nonce === '1';
    if (mine && !asked.record?.txHash) {
      refusedWithoutHash++;
      return route.fulfill({ response: res, json: { ...real, state: 'unknown', detail: 'the RPC refused the event search from block 1: if your wallet shows a transaction hash for this transfer, paste it; the search is retried', txHash: null, block: null, confirmations: null, receipt: null, scan: null } });
    }
    const failed = mine && (real.state === 'confirmed' || real.state === 'final');
    const out = failed ? { ...real, state: replaced ? 'reorged' : 'inner-failed' } : real;
    await route.fulfill({ response: res, json: mine && laterBlock && out.block ? { ...out, block: laterBlock } : out });
  });
  // The wallet broadcasts it but the runner's answer to its report is lost: the outcome is unknown, so Move
  // shows it as unknown (Track keeps it) and never offers Send or a signed-transfer Clear again.
  await page.route('**/api/transfer/wallet-result', async (route) => {
    await route.fetch();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'runner unavailable' }) });
  });
  // And the browser refuses every write that would add the wallet's hash to the nonce-1 record, until restored
  // below: Track must still get that hash for this visit, the page says it was not saved, and the save is tried
  // again on each poll rather than given up after one refusal.
  await page.evaluate(() => {
    const orig = Storage.prototype.setItem;
    const w = window as unknown as { __restoreSetItem?: () => void };
    w.__restoreSetItem = () => {
      Storage.prototype.setItem = orig;
    };
    Storage.prototype.setItem = function (k: string, v: string) {
      const hashed = k === 'cbpr.tracking.v1' && (JSON.parse(v) as { record: { nonce: string; txHash: string | null } }[]).some((x) => x.record.nonce === '1' && x.record.txHash);
      if (hashed) throw new DOMException('synthetic quota', 'QuotaExceededError');
      return orig.call(this, k, v);
    };
  });
  const reread = page.waitForRequest('**/api/diagnose', { timeout: 120_000 });
  releaseSend();
  await page.unroute('**/api/transfer/send-request');
  await expect(page.getByTestId('move-sent')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'unknown');
  // The wallet returned a hash: said so (not "lost contact"), never called confirmed, and kept in Track.
  await expect(page.getByTestId('move-sent-note')).toContainText('returned a transaction hash');
  await expect(page.getByTestId('move-sent-note')).toContainText('not confirmed yet');
  const walletHash = wallet.sent.at(-1)!.hash.toLowerCase();
  await expect(page.getByTestId('move-hash-not-saved')).toContainText(walletHash);
  const keptHash = () => page.evaluate(() => (JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as { record: { nonce: string; txHash: string | null } }[]).find((x) => x.record.nonce === '1')?.record.txHash ?? null);
  expect(await keptHash()).toBeNull();
  await page.getByTestId('lang-toggle').click();
  await expect(page.getByTestId('move-sent-note')).toContainText('錢包已回傳交易 hash');
  await expect(page.getByTestId('move-sent-note')).toContainText('尚未確認');
  await expect(page.getByTestId('move-hash-not-saved')).toContainText('沒有存下');
  await page.getByTestId('lang-toggle').click();
  // Track verifies the lead under the refused search and tries to keep the verified hash on each poll. Refused
  // for two polls or more: the polls carry the wallet's hash (never a hashless record), the row says the hash
  // was not kept, nothing is saved, and Move's own warning stays. Then storage works again: the next poll keeps
  // it, and both notices go, since their advice to paste after a reload no longer holds.
  releaseHashed();
  await expect.poll(() => hashedPolls.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  expect(new Set(hashedPolls)).toEqual(new Set([walletHash]));
  await expect(page.getByTestId('track-not-saved')).toBeVisible();
  expect(await keptHash()).toBeNull();
  await expect(page.getByTestId('move-hash-not-saved')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __restoreSetItem?: () => void }).__restoreSetItem?.());
  await expect.poll(keptHash, { timeout: 60_000 }).toBe(walletHash);
  await expect(page.getByTestId('move-hash-not-saved')).toHaveCount(0);
  await expect(page.getByTestId('track-not-saved')).toHaveCount(0);
  await expect(page.getByTestId('app-error')).toBeVisible();
  await expect(page.getByTestId('send')).toHaveCount(0);
  await expect(page.getByTestId('move-clear-signed')).toHaveCount(0);
  await page.unroute('**/api/transfer/wallet-result');
  // This transfer and the earlier one are told apart in Track.
  await expect(page.locator('[data-testid="track-row"][data-current="current"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.locator('[data-testid="track-row"][data-current="earlier"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="track-row"][data-current="earlier"]').getByTestId('track-which')).toHaveText('Earlier transfer');
  expect(wallet.sent.length).toBe(sentBefore + 1);
  expect(await records()).toBe(recordsBefore + 1);
  expect((await balance(world.recipient)) - before).toBe(250_000_000_000_000_000n);
  const mine = page.locator('[data-testid="track-row"][data-current="current"]');
  await expect(mine).toHaveAttribute('data-state', 'inner-failed', { timeout: 60_000 });
  // Verified from the kept hash under the refused search: the row shows that hash and asks for none.
  await expect(mine.getByTestId('track-tx')).toHaveText(walletHash);
  await expect(mine.getByTestId('track-paste-hash')).toHaveCount(0);
  // The synthetic refusal was in force: hashless nonce-1 polls (before the wallet answered) got it.
  expect(refusedWithoutHash).toBeGreaterThan(0);
  await expect(mine).not.toContainText('paste it');
  await expect(page.getByTestId('move-new')).toHaveAttribute('data-kind', 'clear');
  await expect(page.getByTestId('move-new')).toHaveText('Clear and start over');
  await expect(page.getByTestId('move-clear-note')).toHaveAttribute('data-why', 'failed');
  await reread;
  // Clearing keeps the Track record and opens a fresh form on the latest balances.
  const rowsBefore = await page.getByTestId('track-row').count();
  await page.getByTestId('move-new').click();
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  await expect(page.getByTestId('move-amount')).toHaveValue('');
  await expect(page.getByTestId('move-balance')).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
  await expect(page.getByTestId('track-row')).toHaveCount(rowsBefore);

  // PM-06 event orders. A Check is in flight while this transfer turns up in a later block and a read again
  // covers it; the Check answers last, from before that block: Move does not take it as the latest balances.
  const bal = page.getByTestId('move-balance');
  const trackOf1 = () => page.waitForResponse((r) => r.url().endsWith('/api/track') && (r.request().postDataJSON() as { record?: { nonce?: string } }).record?.nonce === '1', { timeout: 30_000 });
  let releaseCheck!: () => void;
  const checkHeld = new Promise<void>((r) => (releaseCheck = r));
  let k = 0;
  let checkRead = false;
  await page.route('**/api/diagnose', async (route) => {
    if (++k > 1) return route.fallback();
    const res = await route.fetch();
    checkRead = true;
    await checkHeld;
    await route.fulfill({ response: res });
  });
  await page.getByTestId('check-edit').click();
  await page.getByTestId('check-run').click();
  await expect.poll(() => checkRead, { timeout: 60_000 }).toBe(true);
  const h0 = BigInt(await chain<string>('eth_blockNumber', []));
  await chain('anvil_mine', ['0x5']);
  laterBlock = String(h0 + 2n);
  const autoRead = page.waitForResponse((r) => r.url().endsWith('/api/diagnose'), { timeout: 30_000 });
  await trackOf1();
  await autoRead;
  releaseCheck();
  await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(bal).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  await expect(bal).toContainText(`before block ${laterBlock}`);
  await page.getByTestId('move-asset').selectOption({ label: 'XPL' });
  await page.getByTestId('move-amount').fill('0.01');
  await page.getByTestId('move-to').fill(world.recipient);
  await page.getByTestId('move-to-again').fill(world.recipient);
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.getByTestId('move-balance-refresh').click();
  await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 60_000 });
  await expect(page.getByTestId('move-review')).toBeEnabled();
  // The same op reported in a later block again (a shallow reorg): read again on its own, no click.
  laterBlock = String(h0 + 7n);
  await chain('anvil_mine', ['0x5']);
  await trackOf1();
  await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 30_000 });
  await expect.poll(async () => BigInt((await bal.getAttribute('data-block'))!) >= h0 + 7n, { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId('move-review')).toBeEnabled();
  // Its block reported replaced: balances read after it may be from the replaced chain, so read again, no click.
  const readAfterReorg = page.waitForResponse((r) => r.url().endsWith('/api/diagnose'), { timeout: 30_000 });
  replaced = true;
  const reorgSeen = await trackOf1();
  expect(((await reorgSeen.json()) as { state: string }).state).toBe('reorged');
  await readAfterReorg;
  await expect(bal).toHaveAttribute('data-state', 'fresh', { timeout: 30_000 });
  replaced = false;
  laterBlock = null;
  await page.unroute('**/api/diagnose');
  await page.getByTestId('move-clear').click();
  await expect(page.getByTestId('move-amount')).toHaveValue('');
  await page.unroute('**/api/track');
});

test('move nonce 2: no hash from the wallet → shown as unknown, never failed; the tracker finds it', async () => {
  await draft('0.125', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('2', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  wallet.next('no-hash');
  // And the runner's answer to the wallet's "no hash" report is lost (503, as after an RPC switch): the outcome
  // is unknown either way, never a failure — Send is not offered again, the record stays, and the tracker still
  // finds the op on chain below. (The runner itself did record the report: only the page's copy of its answer is lost.)
  await page.route('**/api/transfer/wallet-result', async (route) => {
    await route.fetch();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'runner unavailable' }) });
  });
  // Tracking answers are held back until the storage refusal below is in place and the chain has moved
  // on, so the scan's cursor passes the block holding the UserOperation before the hash can be kept.
  let releaseTrack!: () => void;
  const trackHeld = new Promise<void>((r) => (releaseTrack = r));
  await page.route('**/api/track', async (route) => {
    await trackHeld;
    return route.fallback();
  });
  const recordsBefore = await page.evaluate(() => (JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as unknown[]).length);
  await confirmSend('0.125');
  await expect(page.getByTestId('move-sent')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'unknown');
  await expect(page.getByTestId('move-sent-note')).toContainText('lost contact with your wallet');
  await expect(page.getByTestId('app-error')).toBeVisible();
  await expect(page.getByTestId('send')).toHaveCount(0);
  await expect(page.getByTestId('move-clear-signed')).toHaveCount(0);
  expect(await page.evaluate(() => (JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as unknown[]).length)).toBe(recordsBefore + 1);
  await page.unroute('**/api/transfer/wallet-result');
  // PM-07: no answer yet for this transfer → "Clear and start over", saying the payer may still complete it.
  await expect(page.getByTestId('move-new')).toHaveAttribute('data-kind', 'clear');
  await expect(page.getByTestId('move-new')).toHaveText('Clear and start over');
  await expect(page.getByTestId('move-clear-note')).toHaveAttribute('data-why', 'pending');
  await expect(page.getByTestId('move-clear-note')).toContainText('nothing is sent again');
  // Regression: the browser refuses to save the hash the scan finds. The row still shows the verified
  // result (it used to stay on "loading" for good) and says the hash was not kept.
  await page.evaluate(() => {
    const w = window as unknown as { __setItem?: Storage['setItem'] };
    w.__setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'QuotaExceededError');
    };
  });
  await chain('anvil_mine', ['0x96']);
  releaseTrack();
  // The record has no tx hash; the event scan finds the UserOperation anyway.
  const rows = page.getByTestId('track-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute('data-state', /confirmed|final/, { timeout: 120_000 });
  await expect(rows.first().getByTestId('track-not-saved')).toBeVisible();
  // Regression: later polls (past the found block) keep the found hash, so the row stays verified instead
  // of falling back to "unknown" and stopping its save retries.
  await page.waitForTimeout(1_000);
  await page.waitForResponse('**/api/track', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(rows.first()).toHaveAttribute('data-state', /confirmed|final/);
  await expect(rows.first().getByTestId('track-not-saved')).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { __setItem?: Storage['setItem'] };
    if (w.__setItem) Storage.prototype.setItem = w.__setItem;
  });
  await page.unroute('**/api/track');
  // Storage works again: the row tries the save once more, keeps the hash, and the warning goes.
  await expect(page.getByTestId('track-not-saved')).toHaveCount(0, { timeout: 30_000 });
  await expect(rows.first()).toHaveAttribute('data-state', /confirmed|final/, { timeout: 60_000 });
  // The same-nonce assurance only once the tracker verified it (or the op is already found executed).
  await expect(page.getByTestId('move-gate')).toHaveAttribute('data-gate', /same-nonce|executed/, { timeout: 60_000 });
  await axeBoth(page, 'sent-unknown');
  await expect(page.locator('[data-testid="track-row"][data-state="reverted"], [data-testid="track-row"][data-state="inner-failed"]')).toHaveCount(0);
});

test('regression: the wallet leaving Plasma and coming back voids a signed plan; nothing is sent', async () => {
  await page.getByTestId('move-new').click();
  await draft('0.01', 'XPL');
  await expect(page.getByTestId('sign')).toBeVisible({ timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  await expect(page.getByTestId('send')).toBeVisible({ timeout: 60_000 });
  const sentBefore = wallet.sent.length;
  await wallet.setChain('0x1');
  await expect(page.getByTestId('wallet-switch')).toBeVisible();
  await wallet.setChain(null);
  await expect(page.getByTestId('wallet-connected')).toBeVisible();
  await expect(page.getByTestId('app-notice')).toBeVisible();
  await expect(page.getByTestId('send')).toHaveCount(0);
  await expect(page.getByTestId('signed')).toHaveCount(0);
  expect(wallet.sent.length).toBe(sentBefore);
});

test('refresh: tracking survives from storage with public fields only; plans do not', async () => {
  const stored = await page.evaluate(() => ({ keys: Object.keys(localStorage), text: localStorage.getItem('cbpr.tracking.v1') ?? '', session: sessionStorage.length }));
  expect(stored.keys).toEqual(['cbpr.tracking.v1']);
  expect(stored.session).toBe(0);
  for (const word of ['signature', 'assertion', 'clientDataJSON', 'authenticatorData', 'rpc']) expect(stored.text).not.toContain(word);
  // No full personal address at rest: the account, the gas wallet and the recipient are digests + short forms.
  for (const a of [world.accounts.A.address, world.gasWallet, world.recipient]) expect(stored.text.toLowerCase()).not.toContain(a.slice(2).toLowerCase());
  // The hashless send (nonce 2) was found by the event scan; its verified tx hash is now kept, so a
  // refresh checks that transaction directly instead of a scan whose cursor has moved past it.
  const records = (JSON.parse(stored.text) as Array<{ record: { nonce: string; txHash: string | null } }>).map((x) => x.record);
  expect(records.find((r) => r.nonce === '2')?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  await page.reload();
  await expect(page.getByTestId('track-row')).toHaveCount(3);
  await expect(page.locator('[data-testid="track-row"][data-state="final"], [data-testid="track-row"][data-state="confirmed"]')).toHaveCount(3, { timeout: 120_000 });
  expect(page.url()).toBe(`${SIDECAR}/recover`);
  await expect(step('check')).toHaveAttribute('data-state', 'current');
});

test('regression: a record whose saved hash is replaced by a verified one the browser refuses to keep → later polls keep the verified one', async () => {
  // The scan's answer is rewritten at the network boundary (what it means on chain is proven in
  // test/integration/transfer.test.ts, "the same handleOps sent twice…"): for each record, the tracker
  // reports the op executed by another transaction; asked again about the saved hash alone (the cursor has
  // passed that block), it answers "reverted".
  let armed!: () => void;
  const ready = new Promise<void>((r) => (armed = r));
  const other = (op: string) => `0xfeed${op.slice(6)}`;
  const asked = new Set<string>();
  await page.route('**/api/track', async (route) => {
    await ready;
    const sent = route.request().postDataJSON() as { record: { userOpHash: string; txHash: string | null } };
    const op = sent.record.userOpHash;
    const real = (await (await route.fetch()).json()) as Record<string, unknown>;
    const found = sent.record.txHash === other(op) || !asked.has(op);
    asked.add(op);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(found ? { ...real, state: 'final', txHash: other(op) } : { ...real, state: 'reverted', txHash: sent.record.txHash, receipt: null, scan: { cursor: '1', head: '1', complete: false } }) });
  });
  await page.reload();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'QuotaExceededError');
    };
  });
  armed();
  const rows = page.getByTestId('track-row');
  await expect(rows.first()).toHaveAttribute('data-state', 'final', { timeout: 60_000 });
  await expect(rows.first().getByTestId('track-not-saved')).toBeVisible();
  // Two more polls (one every 5 s while the hash is not kept): still the verified result, never "reverted".
  for (let i = 0; i < 2; i++) await page.waitForResponse('**/api/track', { timeout: 15_000 });
  await page.waitForTimeout(500);
  await expect(page.locator('[data-testid="track-row"][data-state="reverted"]')).toHaveCount(0);
  await expect(rows.first()).toHaveAttribute('data-state', 'final');
  await page.unroute('**/api/track');
  // Nothing was kept (storage refused every write): a reload is back to the saved records and real answers.
  await page.reload();
  await expect(page.locator('[data-testid="track-row"][data-state="final"], [data-testid="track-row"][data-state="confirmed"]')).toHaveCount(3, { timeout: 120_000 });
  await expect(step('check')).toHaveAttribute('data-state', 'current');
});

test('regression: the tracker stops answering after a success that is not final yet → the row no longer shows it as confirmed; it comes back when Track answers', async () => {
  // Answers are rewritten to "confirmed" (not final, so the rows keep asking); then the tracker fails.
  let failing = false;
  await page.route('**/api/track', async (route) => {
    if (failing) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic: the RPC did not answer' }) });
    const real = (await (await route.fetch()).json()) as Record<string, unknown>;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...real, state: 'confirmed' }) });
  });
  await page.reload();
  const row = page.getByTestId('track-row').first();
  await expect(row).toHaveAttribute('data-state', 'confirmed', { timeout: 60_000 });
  await expect(row.getByTestId('ladder')).toHaveCount(1);
  failing = true;
  await expect(row).toHaveAttribute('data-state', 'loading', { timeout: 15_000 });
  await expect(row.getByTestId('ladder')).toHaveCount(0);
  await expect(row.getByTestId('receipt')).toHaveCount(0);
  // Nor anywhere else: once every row has failed a poll, the AI report holds no "confirmed" either.
  await expect(page.locator('[data-testid="track-row"][data-state="confirmed"]')).toHaveCount(0, { timeout: 15_000 });
  await page.getByTestId('top-report').click();
  const tracked = (JSON.parse((await page.getByTestId('report-json').textContent())!) as { tracks: { state: string }[] }).tracks.map((x) => x.state);
  expect(tracked.length).toBe(3);
  expect(tracked).not.toContain('confirmed');
  await page.getByTestId('sheet-report-close').click();
  failing = false;
  await page.unroute('**/api/track');
  await expect(page.locator('[data-testid="track-row"][data-state="final"], [data-testid="track-row"][data-state="confirmed"]')).toHaveCount(3, { timeout: 120_000 });
});

test('storage refuses the pre-send record → the wallet is never asked; the signed plan stays sendable', async () => {
  await page.getByTestId('check-account').fill(world.accounts.A.address);
  await page.getByTestId('check-run').click();
  await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await draft('0.0625', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('3', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  // Site storage now refuses every write (quota / blocked): the tracking record cannot be kept.
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'QuotaExceededError');
    };
  });
  const asked = wallet.calls.filter((c) => c === 'eth_sendTransaction').length;
  await confirmSend('0.0625');
  await expect(page.getByTestId('app-error')).toContainText(/could not save the tracking record/);
  expect(wallet.calls.filter((c) => c === 'eth_sendTransaction').length).toBe(asked);
  await axeBoth(page, 'storage-error');
  await expect(page.getByTestId('send')).toBeEnabled({ timeout: 60_000 });
});

test('an unclaimed hand-off cancelled takes back only its own record; an earlier record for the same UserOperation stays', async () => {
  await page.reload();
  await page.getByTestId('check-account').fill(world.accounts.A.address);
  await page.getByTestId('check-run').click();
  await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  const records = () => page.evaluate(() => JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as { record: { userOpHash: string; nonce: string; txHash: string | null } }[]);
  const before = (await records()).length;
  const handOffAndCancel = async () => {
    await page.getByTestId('send-terminal').locator('summary').click();
    await page.getByTestId('send-handoff').click();
    await expect(page.getByTestId('handoff-code')).toBeVisible();
    await page.getByTestId('handoff-discard').click();
    await expect(page.getByTestId('handoff-code')).toHaveCount(0);
  };
  // No earlier record: the hand-off's own record goes with it.
  await draft('0.03125', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('3', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  await handOffAndCancel();
  expect((await records()).length).toBe(before);
  // Nothing was sent and nothing is kept for it: Track does not call it "this transfer" (nor others "earlier").
  await expect(page.getByTestId('track-which')).toHaveCount(0);
  // An earlier attempt already holds a record for this UserOperation (the same op prepared twice): it stays.
  await draft('0.03125', 'XPL');
  const userOpHash = (await page.getByTestId('sign').getAttribute('data-userop-hash'))!.toLowerCase();
  await signOnPage(world.accounts.A.passkey.seed);
  await page.evaluate((h) => {
    const list = JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as { record: Record<string, unknown> }[];
    const earlier = structuredClone(list[0]!);
    earlier.record = { ...earlier.record, userOpHash: h, nonce: '3', txHash: null };
    localStorage.setItem('cbpr.tracking.v1', JSON.stringify([earlier, ...list]));
  }, userOpHash);
  await handOffAndCancel();
  expect((await records()).filter((x) => x.record.userOpHash === userOpHash)).toHaveLength(1);
  // Not a real attempt: take it out again before the next test reloads.
  await page.evaluate((h) => {
    const list = JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as { record: { userOpHash: string } }[];
    localStorage.setItem('cbpr.tracking.v1', JSON.stringify(list.filter((x) => x.record.userOpHash !== h)));
  }, userOpHash);
  expect((await records()).length).toBe(before);
});

test('Terminal hand-off: no code without a kept record; a claimed code is never discarded with its record', async () => {
  await page.reload();
  await page.getByTestId('check-account').fill(world.accounts.A.address);
  await page.getByTestId('check-run').click();
  await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await draft('0.03125', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('3', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  await page.evaluate(() => {
    (window as unknown as { __setItem: unknown }).__setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'QuotaExceededError');
    };
  });
  await page.getByTestId('send-terminal').locator('summary').click();
  await page.getByTestId('send-handoff').click();
  await expect(page.getByTestId('app-error')).toContainText(/could not save the tracking record/);
  await expect(page.getByTestId('handoff-code')).toHaveCount(0);
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'discarded');

  await page.evaluate(() => void (Storage.prototype.setItem = (window as unknown as { __setItem: Storage['setItem'] }).__setItem));
  await draft('0.03125', 'XPL');
  const userOpHash = await page.getByTestId('sign').getAttribute('data-userop-hash');
  await signOnPage(world.accounts.A.passkey.seed);
  await page.getByTestId('send-terminal').locator('summary').click();
  await page.getByTestId('send-handoff').click();
  const code = (await page.getByTestId('handoff-code').textContent())!.trim();
  // The Terminal signer claims the code (its first call); the browser still shows the code.
  const claim = await fetch(`${SIDECAR}/signer/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cbpr-signer': '1' }, body: JSON.stringify({ code }) });
  expect(claim.status).toBe(200);
  claimed = (await claim.json()) as typeof claimed;
  await page.getByTestId('handoff-discard').click();
  // The sidecar says it was claimed: the op may be on chain, so the record stays and the plan shows as unknown.
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'unknown');
  expect(await page.evaluate(() => localStorage.getItem('cbpr.tracking.v1') ?? '')).toContain(userOpHash!.toLowerCase());
});

test('a new intent waits for earlier records; a preview answered after the draft changed is dropped; a review is voided when the earlier op runs', async () => {
  // The claimed hand-off (nonce 3) was never broadcast: unknown, nonce still 3 → the same-nonce note, verified.
  const handed = page.locator('[data-testid="track-row"][data-state="unknown"]');
  await expect(handed).toHaveCount(1, { timeout: 60_000 });
  // UX-03: an unknown row's ladder lights no rung and carries no success mark.
  await expect(handed.getByTestId('ladder')).toHaveAttribute('data-at', 'unknown');
  await expect(handed.getByTestId('ladder').locator('li[data-state="done"]')).toHaveCount(0);
  await expect(handed.getByTestId('ladder')).not.toContainText('✓');
  await handed.getByTestId('track-abandon').click();
  await expect(handed.getByTestId('track-gate')).toHaveAttribute('data-gate', 'same-nonce', { timeout: 60_000 });
  await expect(handed.getByTestId('track-separate')).toBeEnabled();

  // Until Track has answered for every earlier record of this wallet, no new intent opens.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/track', async (route) => {
    await held;
    await route.continue();
  });
  await page.reload();
  await page.getByTestId('check-account').fill(world.accounts.A.address);
  await page.getByTestId('check-run').click();
  await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  await expect(page.getByTestId('move-wait-earlier')).toBeVisible();
  await page.getByTestId('move-asset').selectOption({ label: 'XPL' });
  await page.getByTestId('move-amount').fill('0.01');
  await page.getByTestId('move-to').fill(world.recipient);
  await page.getByTestId('move-to-again').fill(world.recipient);
  await expect(page.getByTestId('move-review')).toBeDisabled();
  release();
  await page.unroute('**/api/track');
  await expect(page.getByTestId('move-wait-earlier')).toHaveCount(0, { timeout: 60_000 });

  // A preview still in flight when the amount is edited: its answer is not this draft's review.
  let releasePreview!: () => void;
  const previewHeld = new Promise<void>((r) => (releasePreview = r));
  await page.route('**/api/transfer/preview', async (route) => {
    await previewHeld;
    await route.continue();
  });
  const discarded = page.waitForRequest('**/api/transfer/discard', { timeout: 30_000 });
  await page.getByTestId('move-review').click();
  await expect(page.getByTestId('move-review')).toBeDisabled();
  await page.getByTestId('move-amount').fill('0.02');
  releasePreview();
  await discarded;
  await page.unroute('**/api/transfer/preview');
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  await expect(page.getByTestId('move-amount')).toHaveValue('0.02');
  await expect(page.getByTestId('sign')).toHaveCount(0);

  // The edited draft reviews as itself at nonce 3 — the abandoned op's nonce, which is still unused.
  await page.getByTestId('move-review').click();
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('3', { timeout: 120_000 });
  await expect(page.getByTestId('move').getByTestId('manifest')).toContainText('0.02');

  // Meanwhile the user's Terminal broadcasts the op it claimed: the earlier transfer runs at nonce 3.
  // The review on screen was built on an older picture of it, so it is discarded before signing. The user
  // had just pressed Clear on it, and that discard has not reached the runner yet: the voided plan releases
  // the form at once, and the Clear's late answer changes nothing.
  let releaseDiscard!: () => void;
  const discardHeld = new Promise<void>((r) => (releaseDiscard = r));
  await page.route('**/api/transfer/discard', async (route) => (await discardHeld, route.continue()));
  await page.getByTestId('move-clear').click();
  await expect(page.getByTestId('move-clear')).toBeDisabled();
  const o = claimed!.op;
  const op: UserOperationV06 = { sender: o.sender as `0x${string}`, nonce: BigInt(o.nonce!), initCode: o.initCode as `0x${string}`, callData: o.callData as `0x${string}`, callGasLimit: BigInt(o.callGasLimit!), verificationGasLimit: BigInt(o.verificationGasLimit!), preVerificationGas: BigInt(o.preVerificationGas!), maxFeePerGas: BigInt(o.maxFeePerGas!), maxPriorityFeePerGas: BigInt(o.maxPriorityFeePerGas!), paymasterAndData: o.paymasterAndData as `0x${string}`, signature: o.signature as `0x${string}` };
  const entryPoint = wallet.sent[wallet.sent.length - 1]!.to;
  const r = (await (await fetch(world.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction', params: [{ from: world.gasWallet, to: entryPoint, data: handleOpsData(op, claimed!.gasWallet), gas: '0x2dc6c0' }] }) })).json()) as { result?: string };
  expect(r.result).toMatch(/^0x[0-9a-f]{64}$/);
  const abandoned = page.locator('[data-testid="track-row"][data-abandoned="true"]');
  await expect(abandoned).toHaveAttribute('data-state', /confirmed|final/, { timeout: 120_000 });
  await expect(page.getByTestId('app-error')).toContainText('this review was discarded and will not be sent from here', { timeout: 60_000 });
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  await expect(page.getByTestId('sign')).toHaveCount(0);
  await expect(page.getByTestId('move-review')).toBeEnabled();
  await expect(page.getByTestId('move-clear')).toBeEnabled();
  const lateClear = page.waitForResponse((r) => r.url().endsWith('/api/transfer/discard'));
  releaseDiscard();
  await lateClear;
  await page.unroute('**/api/transfer/discard');
  await page.waitForTimeout(500);
  await expect(page.getByTestId('move-amount')).toHaveValue('0.02');
  await expect(page.getByTestId('app-error')).toContainText('this review was discarded and will not be sent from here');
  await expect(page.getByTestId('move-review')).toBeEnabled();
  await axeBoth(page, 'earlier-changed');

  // Reviewing again now reads nonce 4 and is a separate transfer, sent once.
  await page.getByTestId('move-review').click();
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('4', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  await confirmSend('0.02');
  await expect(page.getByTestId('move-sent')).toBeVisible({ timeout: 60_000 });
});

test('a preview whose nonce disagrees with an earlier record (its op ran, Track has not seen it yet) is refused', async () => {
  // A second Terminal hand-off at nonce 5, claimed and then abandoned: same-nonce, verified.
  await page.getByTestId('move-new').click();
  await draft('0.015', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('5', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  await page.getByTestId('send-terminal').locator('summary').click();
  await page.getByTestId('send-handoff').click();
  const code = (await page.getByTestId('handoff-code').textContent())!.trim();
  const claim = await fetch(`${SIDECAR}/signer/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cbpr-signer': '1' }, body: JSON.stringify({ code }) });
  expect(claim.status).toBe(200);
  const c = (await claim.json()) as NonNullable<typeof claimed>;
  await page.getByTestId('handoff-discard').click();
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'unknown');
  const handed = page.locator('[data-testid="track-row"][data-state="unknown"]');
  await expect(handed).toHaveCount(1, { timeout: 60_000 });
  await handed.getByTestId('track-abandon').click();
  await expect(handed.getByTestId('track-gate')).toHaveAttribute('data-gate', 'same-nonce', { timeout: 60_000 });

  // Track stops answering (its next request is held), then the claimed op runs at nonce 5.
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let seen!: () => void;
  const intercepted = new Promise<void>((r) => (seen = r));
  await page.route('**/api/track', async (route) => {
    seen();
    await held;
    await route.continue();
  });
  await intercepted;
  const o = c.op;
  const op: UserOperationV06 = { sender: o.sender as `0x${string}`, nonce: BigInt(o.nonce!), initCode: o.initCode as `0x${string}`, callData: o.callData as `0x${string}`, callGasLimit: BigInt(o.callGasLimit!), verificationGasLimit: BigInt(o.verificationGasLimit!), preVerificationGas: BigInt(o.preVerificationGas!), maxFeePerGas: BigInt(o.maxFeePerGas!), maxPriorityFeePerGas: BigInt(o.maxPriorityFeePerGas!), paymasterAndData: o.paymasterAndData as `0x${string}`, signature: o.signature as `0x${string}` };
  expect(op.nonce).toBe(5n);
  const entryPoint = wallet.sent[wallet.sent.length - 1]!.to;
  const r = (await (await fetch(world.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction', params: [{ from: world.gasWallet, to: entryPoint, data: handleOpsData(op, c.gasWallet), gas: '0x2dc6c0' }] }) })).json()) as { result?: string };
  expect(r.result).toMatch(/^0x[0-9a-f]{64}$/);

  // The gate still reads same-nonce at 5, but a new preview reads nonce 6: that plan is not accepted.
  await page.getByTestId('move-new').click();
  await expect(handed.getByTestId('track-gate')).toHaveAttribute('data-gate', 'same-nonce');
  const discarded = page.waitForRequest('**/api/transfer/discard', { timeout: 60_000 });
  await draft('0.0125', 'XPL');
  await discarded;
  await expect(page.getByTestId('app-error')).toContainText('this review was discarded and will not be sent from here', { timeout: 60_000 });
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  await expect(page.getByTestId('sign')).toHaveCount(0);

  // Once Track answers, the earlier op shows as run and the same draft reviews at nonce 6.
  release();
  await page.unroute('**/api/track');
  await expect(page.locator('[data-testid="track-row"][data-state="unknown"]')).toHaveCount(0, { timeout: 120_000 });
  await page.getByTestId('move-review').click();
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('6', { timeout: 120_000 });
});

test('a send request answered after its plan was voided never reaches the wallet', async () => {
  // A third Terminal hand-off at nonce 6, claimed and abandoned: same-nonce.
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('6');
  await signOnPage(world.accounts.A.passkey.seed);
  await page.getByTestId('send-terminal').locator('summary').click();
  await page.getByTestId('send-handoff').click();
  const code = (await page.getByTestId('handoff-code').textContent())!.trim();
  const claim = await fetch(`${SIDECAR}/signer/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cbpr-signer': '1' }, body: JSON.stringify({ code }) });
  expect(claim.status).toBe(200);
  const c = (await claim.json()) as NonNullable<typeof claimed>;
  await page.getByTestId('handoff-discard').click();
  const handed = page.locator('[data-testid="track-row"][data-state="unknown"]');
  await expect(handed).toHaveCount(1, { timeout: 60_000 });
  await handed.getByTestId('track-abandon').click();
  await expect(handed.getByTestId('track-gate')).toHaveAttribute('data-gate', 'same-nonce', { timeout: 60_000 });

  // A new intent at the same nonce 6, signed; its send request is answered by the sidecar but the answer
  // is held on the way back to the page.
  await page.getByTestId('move-new').click();
  await draft('0.011', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('6', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let answered!: () => void;
  const atSidecar = new Promise<void>((r) => (answered = r));
  await page.route('**/api/transfer/send-request', async (route) => {
    const res = await route.fetch();
    answered();
    await held;
    await route.fulfill({ response: res });
  });
  const walletAsks = wallet.sent.length;
  await confirmSend('0.011');
  await atSidecar;

  // Meanwhile the claimed op runs at nonce 6 and Track sees it: the plan on screen is voided.
  const o = c.op;
  const op: UserOperationV06 = { sender: o.sender as `0x${string}`, nonce: BigInt(o.nonce!), initCode: o.initCode as `0x${string}`, callData: o.callData as `0x${string}`, callGasLimit: BigInt(o.callGasLimit!), verificationGasLimit: BigInt(o.verificationGasLimit!), preVerificationGas: BigInt(o.preVerificationGas!), maxFeePerGas: BigInt(o.maxFeePerGas!), maxPriorityFeePerGas: BigInt(o.maxPriorityFeePerGas!), paymasterAndData: o.paymasterAndData as `0x${string}`, signature: o.signature as `0x${string}` };
  expect(op.nonce).toBe(6n);
  const entryPoint = wallet.sent[wallet.sent.length - 1]!.to;
  const r = (await (await fetch(world.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction', params: [{ from: world.gasWallet, to: entryPoint, data: handleOpsData(op, c.gasWallet), gas: '0x2dc6c0' }] }) })).json()) as { result?: string };
  expect(r.result).toMatch(/^0x[0-9a-f]{64}$/);
  await expect(page.locator('[data-testid="track-row"][data-state="unknown"]')).toHaveCount(0, { timeout: 120_000 });
  await expect(page.getByTestId('app-error')).toContainText('this review was discarded and will not be sent from here', { timeout: 60_000 });

  // The held answer arrives: the page tells the sidecar nothing was sent and discards; the wallet is never asked.
  const notSent = page.waitForRequest((q) => q.url().endsWith('/api/transfer/wallet-result') && (q.postDataJSON() as { outcome?: string }).outcome === 'rejected', { timeout: 30_000 });
  const discard = page.waitForRequest('**/api/transfer/discard', { timeout: 30_000 });
  release();
  await notSent;
  await discard;
  await page.unroute('**/api/transfer/send-request');
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  expect(wallet.sent.length).toBe(walletAsks);
  await expect(page.getByTestId('move-sent')).toHaveCount(0);
});

test('a send request answered after its step was left (a new transfer started from Track) never reaches the wallet', async () => {
  // A fourth hand-off at nonce 7, claimed and abandoned (never broadcast): its row offers a separate transfer.
  await draft('0.0107', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('7', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  await page.getByTestId('send-terminal').locator('summary').click();
  await page.getByTestId('send-handoff').click();
  const code = (await page.getByTestId('handoff-code').textContent())!.trim();
  const claim = await fetch(`${SIDECAR}/signer/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cbpr-signer': '1' }, body: JSON.stringify({ code }) });
  expect(claim.status).toBe(200);
  await page.getByTestId('handoff-discard').click();
  const handed = page.locator('[data-testid="track-row"][data-state="unknown"]');
  await expect(handed).toHaveCount(1, { timeout: 60_000 });
  await handed.getByTestId('track-abandon').click();
  await expect(handed.getByTestId('track-separate')).toBeEnabled({ timeout: 60_000 });

  // A new intent at the same nonce 7, signed.
  await page.getByTestId('move-new').click();
  await draft('0.0105', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('7', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let answered!: () => void;
  const atSidecar = new Promise<void>((r) => (answered = r));
  await page.route('**/api/transfer/send-request', async (route) => {
    const res = await route.fetch();
    answered();
    await held;
    await route.fulfill({ response: res });
  });
  const walletAsks = wallet.sent.length;
  await confirmSend('0.0105');
  await atSidecar;
  // The user starts a separate transfer from an earlier row: the Move step is replaced by a fresh one.
  await handed.getByTestId('track-separate').click();
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  const notSent = page.waitForRequest((q) => q.url().endsWith('/api/transfer/wallet-result') && (q.postDataJSON() as { outcome?: string }).outcome === 'rejected', { timeout: 30_000 });
  release();
  await notSent;
  await page.unroute('**/api/transfer/send-request');
  expect(wallet.sent.length).toBe(walletAsks);
  await expect(page.getByTestId('move-sent')).toHaveCount(0);
});

test("a step left while the wallet was still checking its account and chain never gets the transaction", async () => {
  // The nonce-7 hand-off row is still abandoned and unknown: a separate transfer can be started from it.
  const handed = page.locator('[data-testid="track-row"][data-state="unknown"]');
  await expect(handed.getByTestId('track-separate')).toBeEnabled({ timeout: 60_000 });
  await draft('0.0103', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('7', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  // The wallet's chain answer is held: the send is inside the adapter's pre-flight checks.
  const asksBefore = wallet.calls.filter((m) => m === 'eth_sendTransaction').length;
  const sentBefore = wallet.sent.length;
  const release = wallet.holdChainId();
  const callsBefore = wallet.calls.length;
  await confirmSend('0.0103');
  await expect.poll(() => wallet.calls.slice(callsBefore).includes('eth_chainId'), { timeout: 30_000 }).toBe(true);
  await handed.getByTestId('track-separate').click();
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  const notSent = page.waitForRequest((q) => q.url().endsWith('/api/transfer/wallet-result') && (q.postDataJSON() as { outcome?: string }).outcome === 'rejected', { timeout: 30_000 });
  release();
  await notSent;
  expect(wallet.calls.filter((m) => m === 'eth_sendTransaction').length).toBe(asksBefore);
  expect(wallet.sent.length).toBe(sentBefore);
});

test('an RPC re-check started while the wallet is still checking voids the send at once, even with the RPC sheet closed before it answers', async () => {
  await draft('0.0104', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('7', { timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  const asksBefore = wallet.calls.filter((m) => m === 'eth_sendTransaction').length;
  const sentBefore = wallet.sent.length;
  // The sidecar's answer to the re-check is held, and the sheet is closed before it arrives: the
  // invalidation must not wait for that answer, nor depend on the panel still being mounted.
  let releaseProbe!: () => void;
  const probeHeld = new Promise<void>((r) => (releaseProbe = r));
  await page.route('**/api/rpc/probe', async (route) => {
    await probeHeld;
    await route.continue();
  });
  const release = wallet.holdChainId();
  const callsBefore = wallet.calls.length;
  await confirmSend('0.0104');
  await expect.poll(() => wallet.calls.slice(callsBefore).includes('eth_chainId'), { timeout: 30_000 }).toBe(true);
  await page.getByTestId('top-rpc').click();
  await page.getByTestId('rpc-check').click();
  await page.getByTestId('sheet-rpc-close').click();
  const notSent = page.waitForRequest((q) => q.url().endsWith('/api/transfer/wallet-result') && (q.postDataJSON() as { outcome?: string }).outcome === 'rejected', { timeout: 30_000 });
  release();
  await notSent;
  expect(wallet.calls.filter((m) => m === 'eth_sendTransaction').length).toBe(asksBefore);
  expect(wallet.sent.length).toBe(sentBefore);
  await expect(page.getByTestId('app-notice')).toContainText('Anything your wallet already sent is not undone');
  // The held answer still reaches the app after the sheet closed: the RPC chip reflects the re-check.
  const probed = page.waitForResponse((r) => r.url().endsWith('/api/rpc/probe'), { timeout: 60_000 });
  releaseProbe();
  await probed;
  await page.unroute('**/api/rpc/probe');
  // Regression: what was read through the old endpoint is void too — Check opens again with the account
  // kept, and Move waits for a fresh check instead of using the old balances and deployment state.
  await expect(page.locator('li[data-step="check"]')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('check-account')).toHaveValue(new RegExp(`^${world.accounts.A.address}$`, 'i'));
  await expect(page.getByTestId('move')).toHaveCount(0);
  // The old diagnosis is not shown (no "ready" verdict or balances from the old endpoint), nor reported.
  await expect(page.getByTestId('diagnosis')).toHaveCount(0);
  await page.getByTestId('top-report').click();
  expect((JSON.parse((await page.getByTestId('report-json').textContent())!) as { diagnosis: unknown }).diagnosis).toBeNull();
  await page.getByTestId('sheet-report-close').click();
  await expect(page.getByTestId('move-sent')).toHaveCount(0);
  // Regression: a check still in flight when the endpoint changes is dropped when it answers.
  let releaseDiag!: () => void;
  const diagHeld = new Promise<void>((r) => (releaseDiag = r));
  await page.route('**/api/diagnose', async (route) => {
    await diagHeld;
    await route.continue();
  });
  await page.getByTestId('check-run').click();
  await page.getByTestId('top-rpc').click();
  // The endpoint change has fully landed (its answer applied) before the held check answers.
  const switched = page.waitForResponse('**/api/rpc/probe', { timeout: 60_000 });
  await page.getByTestId('rpc-check').click();
  await switched;
  await page.waitForTimeout(300);
  await page.getByTestId('sheet-rpc-close').click();
  const answered = page.waitForResponse('**/api/diagnose', { timeout: 60_000 });
  releaseDiag();
  // The sidecar answers it (a real diagnosis): the page is what must not use it.
  expect((await answered).status()).toBe(200);
  await page.unroute('**/api/diagnose');
  await page.waitForTimeout(500);
  await expect(page.locator('li[data-step="check"]')).toHaveAttribute('data-state', 'current');
  await expect(page.getByTestId('move')).toHaveCount(0);
  // UX-1: the dropped check proved nothing, so the RPC-changed warning is still the loud one — and the
  // receipts already on Track do not demote it on their own.
  await expect(page.getByTestId('rpc-changed')).toBeVisible();
  await expect(page.locator('[data-testid="track-row"] [data-testid="receipt"]').first()).toBeVisible();
  // A check that fails through the new endpoint proves nothing either.
  await page.route('**/api/diagnose', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'the RPC did not answer' }) }));
  const failed = page.waitForResponse('**/api/diagnose', { timeout: 30_000 });
  await page.getByTestId('check-run').click();
  expect((await failed).status()).toBe(502);
  await page.unroute('**/api/diagnose');
  await expect(page.getByTestId('move')).toHaveCount(0);
  await expect(page.getByTestId('rpc-changed')).toBeVisible();
  await expect(page.getByTestId('rpc-changed-note')).toHaveCount(0);
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('move')).toBeVisible({ timeout: 120_000 });
  // A check that succeeded through the new endpoint makes the warning old news: one quiet, timed line stays.
  await expect(page.getByTestId('rpc-changed')).toHaveCount(0);
  await expect(page.getByTestId('rpc-changed-note')).toContainText('The RPC endpoint changed at');
  // Successful receipts below do not sit under a stale warning.
  await expect(page.locator('[data-testid="track-row"][data-state="final"]').first()).toBeVisible({ timeout: 120_000 });
  // A later endpoint change is news again: the loud warning comes back, the quiet line goes.
  await page.getByTestId('top-rpc').click();
  const again = page.waitForResponse('**/api/rpc/probe', { timeout: 60_000 });
  await page.getByTestId('rpc-check').click();
  await again;
  await page.getByTestId('sheet-rpc-close').click();
  await expect(page.getByTestId('rpc-changed')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('rpc-changed-note')).toHaveCount(0);
  await expect(page.getByTestId('move')).toHaveCount(0);
  // Leave the page as later tests expect it: checked through the current endpoint.
  await page.getByTestId('check-run').click();
  await expect(page.getByTestId('move')).toBeVisible({ timeout: 120_000 });
});

/** A JSON-RPC call straight to the synthetic testchain (test-side control of the chain, never the page). */
async function chain<T>(method: string, params: unknown[]): Promise<T> {
  const r = (await (await fetch(world.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result: T; error?: { message: string } };
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

test('M4-3 states: a failed signed simulation and a raised network fee, then each Track failure state, are axe clean in both languages', async () => {
  // Real chain states first. The source wallet is emptied before signing, so the exact signed
  // simulation fails at the live block (nothing can be sent); its balance comes back and a re-check passes.
  await draft('0.0101', 'XPL');
  await expect(page.getByTestId('move').getByTestId('manifest').getByTestId('manifest-nonce')).toHaveText('7', { timeout: 120_000 });
  const A = world.accounts.A.address;
  const funds = await balance(A);
  await chain('anvil_setBalance', [A, '0x0']);
  const sign = page.getByTestId('sign');
  const hash = (await sign.getAttribute('data-userop-hash')) as `0x${string}`;
  await page.getByTestId('sign-assertion').fill(buildAssertion({ challenge: hexToBytes(hash), kind: 'userop', key: syntheticKey(world.accounts.A.passkey.seed) }).json);
  await page.getByTestId('sign-submit').click();
  await expect(page.getByTestId('sign-sim-failed')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'sim-failed');
  await expect(page.getByTestId('send')).toHaveCount(0);
  await axeBoth(page, 'sim-failed');
  await chain('anvil_setBalance', [A, '0x' + funds.toString(16)]);
  await page.getByTestId('sign-resim').click();
  await expect(page.getByTestId('signed')).toBeVisible({ timeout: 120_000 });

  // The network base fee jumps after the review: the send request issues nothing, the wallet is not asked,
  // and the page shows the new cap to confirm again.
  const base = BigInt((await chain<{ baseFeePerGas: string }>('eth_getBlockByNumber', ['latest', false])).baseFeePerGas);
  await chain('anvil_setNextBlockBaseFeePerGas', ['0x' + (base * 1000n + 10n ** 11n).toString(16)]);
  await chain('evm_mine', []);
  const asks = wallet.calls.filter((m) => m === 'eth_sendTransaction').length;
  await confirmSend('0.0101');
  await expect(page.getByTestId('send-fee-raised')).toBeVisible({ timeout: 120_000 });
  expect(wallet.calls.filter((m) => m === 'eth_sendTransaction').length).toBe(asks);
  await axeBoth(page, 'fee-raised');
  await chain('anvil_setNextBlockBaseFeePerGas', ['0x' + base.toString(16)]);
  await chain('evm_mine', []);
  // Discarded while the runner has already forgotten the plan (404, as after expiry or a restart; the synthetic
  // sidecar does discard it underneath): nothing is left to discard, so the page clears it, no error.
  await page.route('**/api/transfer/discard', async (route) => {
    const actual = await route.fetch();
    expect(actual.status()).toBe(200);
    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'unknown plan (discarded, or the sidecar restarted)' }) });
  });
  await page.getByTestId('review-discard').click();
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  await page.unroute('**/api/transfer/discard');
  await expect(page.getByTestId('app-error')).toHaveCount(0);

  // Track's failure states. What each one means on chain is proven against the testchain in
  // test/integration/transfer.test.ts and test/unit/server/track-bundle.test.ts; here only how the page
  // renders them is checked, so the tracker's real answer is rewritten at the network boundary.
  const rows = page.getByTestId('track-row');
  for (const state of ['reorged', 'reverted', 'inner-failed', 'mismatch'] as const) {
    await page.route('**/api/track', async (route) => {
      const sentHash = (route.request().postDataJSON() as { record: { txHash: string | null } }).record.txHash;
      const real = (await (await route.fetch()).json()) as Record<string, unknown>;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...real, state, detail: `${state} (rendering check)`, txHash: sentHash, confirmations: state === 'reorged' ? null : real.confirmations, receipt: null, scan: null }) });
    });
    await page.reload();
    await expect(rows.first()).toHaveAttribute('data-state', state, { timeout: 60_000 });
    await expect(rows.and(page.locator(`[data-state="${state}"]`))).toHaveCount(await rows.count());
    if (state === 'mismatch') await expect(rows.first().getByTestId('track-drop-hash')).toBeVisible();
    await axeBoth(page, `track-${state}`);
    await page.unroute('**/api/track');
  }
  await page.reload();
  await expect(rows.first()).not.toHaveAttribute('data-state', /^(reorged|reverted|inner-failed|mismatch|loading)$/, { timeout: 60_000 });
});

test('a Track row is removable only once its answer is settled: an outer revert whose op may still run elsewhere keeps its row', async () => {
  const rows = page.getByTestId('track-row');
  // Rendering check (the answer is rewritten at the network boundary): a revert buried at the finality
  // depth with the account's nonce past the op — settled only when the event scan is also complete, and
  // only when the nonce moved at the finality depth too (`deep`): one used only near the head can be reorged back.
  for (const [complete, deep] of [[false, true], [true, false], [true, true]] as const) {
    await page.route('**/api/track', async (route) => {
      const rec = (route.request().postDataJSON() as { record: { txHash: string | null; nonce: string } }).record;
      const real = (await (await route.fetch()).json()) as Record<string, unknown>;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...real, state: 'reverted', detail: 'reverted (rendering check)', txHash: rec.txHash, receipt: null, confirmations: '100', nonceNow: String(BigInt(rec.nonce) + 1n), nonceFinal: String(BigInt(rec.nonce) + (deep ? 1n : 0n)), scan: { cursor: '1', head: '1', complete } }) });
    });
    await page.reload();
    await expect(rows.first()).toHaveAttribute('data-state', 'reverted', { timeout: 60_000 });
    await expect(rows.getByTestId('track-remove')).toHaveCount(complete && deep ? await rows.count() : 0);
    // UX-1 Track word: a settled failure needs attention; one that may still change stays "Following the chain".
    await expect(page.getByTestId('step-word-track')).toHaveText(complete && deep ? 'Needs attention' : 'Following the chain');
    await page.unroute('**/api/track');
  }
  // Superseded: unknown, no event in a complete scan, and the nonce used by another operation — removable
  // only once that nonce use sits at the finality depth.
  for (const deep of [false, true]) {
    await page.route('**/api/track', async (route) => {
      const rec = (route.request().postDataJSON() as { record: { txHash: string | null; nonce: string } }).record;
      const real = (await (await route.fetch()).json()) as Record<string, unknown>;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ...real, state: 'unknown', detail: 'superseded (rendering check)', txHash: rec.txHash, receipt: null, block: null, confirmations: null, nonceNow: String(BigInt(rec.nonce) + 1n), nonceFinal: String(BigInt(rec.nonce) + (deep ? 1n : 0n)), scan: { cursor: '1', head: '1', complete: true } }) });
    });
    await page.reload();
    await expect(rows.first()).toHaveAttribute('data-state', 'unknown', { timeout: 60_000 });
    await expect(rows.getByTestId('track-remove')).toHaveCount(deep ? await rows.count() : 0);
    await page.unroute('**/api/track');
  }
  // Every poll fails before any answer: a record without a tx hash still offers the paste entry.
  const hashless = await page.evaluate(() => (JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as { record: { txHash: string | null } }[]).filter((x) => x.record.txHash === null).length);
  expect(hashless).toBeGreaterThan(0);
  await page.route('**/api/track', (route) => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'the RPC did not answer' }) }));
  await page.reload();
  await expect(page.getByTestId('track-error-paste')).toHaveCount(hashless, { timeout: 60_000 });
  await axeBoth(page, 'track-error-paste');
  // Regression: storage has room for the record as it is but not for it with a hash (a write may only
  // shrink the list). Pasting a hash leaves the open record in place and says the change was not kept
  // (it used to remove the record first, so the row and its next-intent gate disappeared).
  const stored = () => page.evaluate(() => localStorage.getItem('cbpr.tracking.v1') ?? '');
  const before = await stored();
  const rowsBefore = await rows.count();
  await page.evaluate(() => {
    const w = window as unknown as { __setItem?: Storage['setItem'] };
    const real = (w.__setItem = Storage.prototype.setItem);
    Storage.prototype.setItem = function (k: string, v: string) {
      if (k === 'cbpr.tracking.v1' && v.length > (localStorage.getItem(k) ?? '').length) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    };
  });
  const paste = page.getByTestId('track-error-paste').first();
  await paste.getByTestId('track-paste-hash').fill(`0x${'ab'.repeat(32)}`);
  await paste.getByTestId('track-use-hash').click();
  await expect(page.getByTestId('track-paste-not-saved')).toBeVisible();
  await expect(paste.getByTestId('track-paste-hash')).toHaveValue(`0x${'ab'.repeat(32)}`);
  expect([await stored(), await rows.count()]).toEqual([before, rowsBefore]);
  await page.evaluate(() => {
    const w = window as unknown as { __setItem?: Storage['setItem'] };
    if (w.__setItem) Storage.prototype.setItem = w.__setItem;
  });
  await page.unroute('**/api/track');
  await page.reload();
  await expect(rows.first()).not.toHaveAttribute('data-state', /^(reverted|loading)$/, { timeout: 60_000 });
});

test('a deploy step left while the wallet was still checking its chain never gets the transaction', async () => {
  const D = world.accounts.D;
  /** Checks D from its owners + factory nonce and waits for its one remaining deploy step (the account). */
  const checkD = async (opts: { stopAtReplan?: boolean } = {}) => {
    if (await page.getByTestId('check-edit').isVisible()) await page.getByTestId('check-edit').click();
    await page.getByTestId('check-account').fill(D.address);
    const details = page.getByTestId('check-evidence-toggle').locator('xpath=..');
    if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await page.getByTestId('check-evidence-toggle').click();
    await page.getByTestId('check-calldata').fill('');
    await page.getByTestId('check-owners').fill(D.owners.join('\n'));
    await page.getByTestId('check-nonce').fill(D.nonce);
    await page.getByTestId('check-run').click();
    await expect(step('deploy')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
    if (await page.getByTestId('wallet-connect').isVisible()) await page.getByTestId('wallet-connect').click();
    const send = page.getByTestId('deploy-send');
    // A record of an earlier attempt still in flight is resumed as "not sure": the user plans again explicitly.
    const plan = page.getByTestId('deploy-plan');
    const replan = page.getByTestId('deploy-replan');
    await expect
      .poll(
        async () => {
          if ((await send.isVisible()) && (await send.isEnabled())) return true;
          if (opts.stopAtReplan && (await replan.isVisible()) && (await replan.isEnabled())) return true;
          if (await replan.isVisible()) await replan.click();
          else if ((await plan.isVisible()) && (await plan.isEnabled())) await plan.click();
          return false;
        },
        { timeout: 120_000, intervals: [250] },
      )
      .toBe(true);
    if (opts.stopAtReplan && (await replan.isVisible())) return 'replan';
    // Infrastructure is already on chain (deployed in the first flow): only D's own account step is left.
    const [done, total] = (await page.getByTestId('deploy').getAttribute('data-progress'))!.split('/').map(Number);
    expect(total! - done!).toBe(1);
    return `${done}/${total}`;
  };
  const progress = await checkD();
  const asks = wallet.calls.filter((m) => m === 'eth_sendTransaction').length;
  const sent = wallet.sent.length;
  // The wallet's chain answer is held: the send is inside the adapter's pre-flight checks.
  const release = wallet.holdChainId();
  const callsBefore = wallet.calls.length;
  await page.getByTestId('deploy-send').click();
  await page.getByTestId('deploy-send-confirm').click();
  await expect.poll(() => wallet.calls.slice(callsBefore).includes('eth_chainId'), { timeout: 60_000 }).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('cbpr.deploy.v1'))).not.toBeNull();
  // The user goes back to the check: the deploy step is gone from the page.
  await page.getByTestId('check-edit').click();
  await expect(page.getByTestId('deploy')).toHaveCount(0);
  release();
  // The step was given up before the wallet was asked: its in-flight record is cleared, nothing is sent.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cbpr.deploy.v1')), { timeout: 30_000 }).toBeNull();
  expect(wallet.calls.filter((m) => m === 'eth_sendTransaction').length).toBe(asks);
  expect(wallet.sent.length).toBe(sent);
  // Checking D again offers the same, still-needed step.
  expect(await checkD()).toBe(progress);

  // An older wallet request answered late never replaces a newer attempt's state. Attempt A waits in the
  // wallet; the user switches the gas wallet (the same step stays on the page and shows A as "not sure"),
  // plans again explicitly and confirms attempt B. When A is finally declined, B is still the one waiting:
  // its record stays and its step does not become sendable again.
  const G2 = '0x6a3b9c2d4e5f60718293a4b5c6d7e8f901a2b3c4';
  await chain('anvil_setBalance', [G2, '0x56bc75e2d63100000']);
  wallet.next('defer');
  await page.getByTestId('deploy-send').click();
  await page.getByTestId('deploy-send-confirm').click();
  await expect.poll(() => wallet.deferred(), { timeout: 60_000 }).toBe(1);
  const recordA = await page.evaluate(() => localStorage.getItem('cbpr.deploy.v1'));
  expect(recordA).not.toBeNull();
  await wallet.switchAccount(G2);
  await expect(page.getByTestId('deploy-replan')).toBeEnabled({ timeout: 120_000 });
  await page.getByTestId('deploy-replan').click();
  await expect(page.getByTestId('deploy-send')).toBeEnabled({ timeout: 120_000 });
  wallet.next('defer');
  await page.getByTestId('deploy-send').click();
  await page.getByTestId('deploy-send-confirm').click();
  await expect.poll(() => wallet.deferred(), { timeout: 60_000 }).toBe(2);
  const recordB2 = await page.evaluate(() => localStorage.getItem('cbpr.deploy.v1'));
  expect(recordB2).not.toBe(recordA);
  wallet.answerDeferred('reject'); // A, the older request
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => localStorage.getItem('cbpr.deploy.v1'))).toBe(recordB2);
  await expect(page.getByTestId('deploy-send')).toBeDisabled();
  // B is declined too; back on the first gas wallet the step is offered as before. Nothing was broadcast.
  wallet.answerDeferred('reject');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('cbpr.deploy.v1')), { timeout: 30_000 }).toBeNull();
  await wallet.switchAccount(world.gasWallet);
  expect(wallet.sent.length).toBe(sent);
  expect(await checkD()).toBe(progress);

  // An older attempt answered late must not touch a newer one's record. Attempt A is held in its chain
  // check; the user leaves, checks D again and confirms attempt B, which reaches the wallet (broadcast, no
  // answer yet). Back on the step, A's record is resumed as "not sure" and the user plans again explicitly.
  // When A's chain answer finally arrives, A is cancelled — and B's record stays.
  const releaseA = wallet.holdChainId({ once: true });
  const callsA = wallet.calls.length;
  await page.getByTestId('deploy-send').click();
  await page.getByTestId('deploy-send-confirm').click();
  await expect.poll(() => wallet.calls.slice(callsA).includes('eth_chainId'), { timeout: 60_000 }).toBe(true);
  await page.getByTestId('check-edit').click();
  await expect(page.getByTestId('deploy')).toHaveCount(0);
  expect(await checkD({ stopAtReplan: true })).toBe('replan');
  // "Plan step N again" cannot run twice at once: while its plan is on the way the button is disabled, so a
  // second press cannot start a re-plan whose late answer would reset a newer attempt.
  let plans = 0;
  let releasePlan!: () => void;
  const planHeld = new Promise<void>((r) => (releasePlan = r));
  await page.route('**/api/deploy/plan', async (route) => {
    plans += 1;
    await planHeld;
    await route.fulfill({ response: await route.fetch() });
  });
  await page.getByTestId('deploy-replan').click();
  await expect.poll(() => plans).toBe(1);
  await expect(page.getByTestId('deploy-replan')).toBeDisabled();
  await page.getByTestId('deploy-replan').click({ force: true });
  await page.waitForTimeout(300);
  expect(plans).toBe(1);
  releasePlan();
  await expect(page.getByTestId('deploy-send')).toBeEnabled({ timeout: 120_000 });
  await page.unroute('**/api/deploy/plan');
  expect(plans).toBe(1);
  wallet.next('hold');
  await page.getByTestId('deploy-send').click();
  await page.getByTestId('deploy-send-confirm').click();
  await expect.poll(() => wallet.sent.length, { timeout: 60_000 }).toBe(sent + 1);
  const recordB = await page.evaluate(() => localStorage.getItem('cbpr.deploy.v1'));
  expect(recordB).not.toBeNull();
  const answered = wallet.calls.length;
  releaseA();
  // A's pre-flight finishes (it asks for nothing more), then A is cancelled; give it time to act.
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => localStorage.getItem('cbpr.deploy.v1'))).toBe(recordB);
  expect(wallet.calls.slice(answered).filter((m) => m === 'eth_sendTransaction')).toEqual([]);
  expect(wallet.sent.length).toBe(sent + 1);
});

test('without a browser wallet, a transfer is prepared for the Terminal signer: hand-off only, never sent from the page', async ({ browser }) => {
  // A second page with no injected wallet at all (no window.ethereum).
  const mainPage = page;
  const bare = await browser.newContext();
  page = await bare.newPage();
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4175\/).*/, (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  try {
    await page.goto(`${SIDECAR}/recover`);
    await page.getByTestId('check-account').fill(world.accounts.A.address);
    await page.getByTestId('check-run').click();
    await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
    await expect(page.getByTestId('move-need-wallet')).toBeVisible();
    // No payer yet: nothing can be reviewed.
    await page.getByTestId('move-asset').selectOption({ label: 'XPL' });
    await page.getByTestId('move-amount').fill('0.0105');
    await page.getByTestId('move-to').fill(world.recipient);
    await page.getByTestId('move-to-again').fill(world.recipient);
    await expect(page.getByTestId('move-review')).toBeDisabled();
    // The Terminal signer's public gas-wallet address (what `npm run signer -- status` prints).
    await page.getByTestId('move-terminal-payer').fill(world.gasWallet);
    // The draft with the Terminal payer field, before Review unmounts it (M4-3: every state, both languages).
    await expect(page.getByTestId('move-terminal-payer')).toBeVisible();
    await axeBoth(page, 'terminal-payer-draft');
    await expect(page.getByTestId('move-terminal-payer')).toHaveValue(world.gasWallet);
    await page.getByTestId('move-review').click();
    await signOnPage(world.accounts.A.passkey.seed);
    // Sending from this page needs a connected wallet: only the hand-off is offered.
    await expect(page.getByTestId('send')).toBeDisabled();
    await page.getByTestId('send-terminal').locator('summary').click();
    await page.getByTestId('send-handoff').click();
    await expect(page.getByTestId('handoff-code')).toHaveText(/\S/);
    await axeBoth(page, 'terminal-handoff-no-wallet');
    // Not claimed: discarding it leaves nothing sent, and the page is back to a fresh draft.
    await page.getByTestId('handoff-discard').click();
    await expect(page.getByTestId('handoff-code')).toHaveCount(0);
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft', { timeout: 30_000 });
  } finally {
    await bare.close();
    page = mainPage;
  }
});

/**
 * A fresh page (no earlier records, its own mock wallet, so the unknown record it leaves gates no later test) on
 * which a send was requested and the runner issued it (its plan is now sending), but the page never saw the
 * answer: the signed plan stays, with no row in Track and no "this transfer". `page` is the new page until the
 * caller restores it.
 */
async function lostSendAnswer(own: BrowserContext) {
  page = await own.newPage();
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4175\/).*/, (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const w = await installMockWallet(page, world);
  await page.goto(`${SIDECAR}/recover`);
  await page.getByTestId('check-account').fill(world.accounts.A.address);
  await page.getByTestId('check-run').click();
  await expect(step('move')).toHaveAttribute('data-state', 'current', { timeout: 120_000 });
  // The wallet area renders after the step opens: wait for either state before deciding whether to connect.
  const connect = page.getByTestId('wallet-connect');
  await expect(connect.or(page.getByTestId('wallet-connected'))).toBeVisible();
  if (await connect.isVisible()) await connect.click();
  await expect(page.getByTestId('wallet-connected')).toHaveAttribute('data-account', world.gasWallet);
  await draft('0.0105', 'XPL');
  await expect(page.getByTestId('sign')).toBeVisible({ timeout: 120_000 });
  const op = (await page.getByTestId('sign').getAttribute('data-userop-hash'))!.toLowerCase();
  await signOnPage(world.accounts.A.passkey.seed);
  const asks = () => w.calls.filter((m) => m === 'eth_sendTransaction').length;
  const asksBefore = asks();

  await page.route('**/api/transfer/send-request', async (route) => {
    const real = await route.fetch();
    expect(real.status()).toBe(200);
    const issued = (await real.json()) as { plan: { state: string }; tx: unknown };
    expect(issued.plan.state).toBe('sending');
    expect(issued.tx).toBeTruthy();
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic lost response' }) });
  });
  try {
    await confirmSend('0.0105');
    await expect(page.getByTestId('app-error')).toContainText('synthetic lost response');
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    await expect(page.getByTestId('review-discard')).toBeEnabled();
    await expect(page.getByTestId('track-row')).toHaveCount(0);
  } finally {
    await page.unroute('**/api/transfer/send-request');
  }
  return { w, op, asks, asksBefore };
}

/** The runner answered unknown for `op`: Move says so and offers no Send; Track has the row as this transfer; the record is kept. */
async function expectTrackedUnknown(op: string, w: MockWallet, asks: () => number, asksBefore: number) {
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'unknown');
  await expect(page.getByTestId('move-sent-note')).toBeVisible();
  await expect(page.getByTestId('send')).toHaveCount(0);
  expect(asks()).toBe(asksBefore);
  expect(w.sent).toHaveLength(0);
  const row = page.locator(`[data-testid="track-row"][data-userop-hash="${op}"]`);
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('data-current', 'current');
  await expect.poll(() => page.evaluate((h) => (JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as { record: { userOpHash: string; txHash: string | null } }[]).find((x) => x.record.userOpHash === h)?.record.txHash, op)).toBeNull();
  return row;
}

test('a send request whose answer the page lost → Discard says unknown and tracks it: the record is kept, this transfer in Track, and survives a reload', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, op, asks, asksBefore } = await lostSendAnswer(own);

    // Discard: the runner knows a send was requested, so it answers unknown with the record — tracked, not dropped.
    const answered = page.waitForResponse('**/api/transfer/discard');
    await page.getByTestId('review-discard').click();
    expect(((await (await answered).json()) as { state: string }).state).toBe('unknown');
    const row = await expectTrackedUnknown(op, w, asks, asksBefore);

    // The record is what survives: after a reload, Track still has the row.
    await page.reload();
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    expect(w.sent).toHaveLength(0);
  } finally {
    await own.close();
    page = mainPage;
  }
});

test('a send request whose answer the page lost → Clear and start over reads the runner\'s unknown like Discard: tracked, no new form over it', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, op, asks, asksBefore } = await lostSendAnswer(own);
    const answered = page.waitForResponse('**/api/transfer/discard');
    await page.getByTestId('move-clear').click();
    expect(((await (await answered).json()) as { state: string }).state).toBe('unknown');
    await expectTrackedUnknown(op, w, asks, asksBefore);
    // No fresh form: the transfer that may have left is what the step shows, with "Clear and start over" for later.
    await expect(page.getByTestId('move-review')).toHaveCount(0);
    await expect(page.getByTestId('move-new')).toHaveAttribute('data-kind', 'clear');
  } finally {
    await own.close();
    page = mainPage;
  }
});

// Both ways of ending a signed plan ask the runner; neither ends anything while the runner does not answer.
const endings = [
  { action: 'review-discard', label: 'Discard', said: 'Not discarded' },
  { action: 'move-clear', label: 'Clear and start over', said: 'Not cleared' },
] as const;

for (const { action, label, said } of endings) test(`a send request whose answer the page lost, then ${label} cannot reach the runner → the plan stays (not voided), the runner is said lost; once it answers again, ${label} gets unknown and tracks it`, async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, op, asks, asksBefore } = await lostSendAnswer(own);

    // The runner process does not answer the discard at all (network layer).
    await page.route('**/api/transfer/discard', (r) => r.abort('connectionrefused'));
    await page.getByTestId(action).click();
    await expect(page.getByTestId('app-error')).toContainText(said);
    await expect(page.getByTestId('app-error')).toContainText('stopped answering');
    await expect(page.getByTestId('caps-lost')).toBeVisible();
    await expect(page.getByTestId('no-sidecar')).toContainText('stopped answering');
    // Still this plan, on screen, with both buttons to press again; nothing kept yet and the wallet never asked.
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    await expect(page.getByTestId('review-discard')).toBeEnabled();
    await expect(page.getByTestId('move-clear')).toBeEnabled();
    await expect(page.getByTestId('track-row')).toHaveCount(0);
    expect(asks()).toBe(asksBefore);

    // The same runner answers again: connected in place, the plan still there, and its answer is unknown.
    await page.unroute('**/api/transfer/discard');
    await page.getByTestId('caps-retry').click();
    await expect(page.getByTestId('no-sidecar')).toHaveCount(0);
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    const answered = page.waitForResponse('**/api/transfer/discard');
    await page.getByTestId(action).click();
    expect(((await (await answered).json()) as { state: string }).state).toBe('unknown');
    await expectTrackedUnknown(op, w, asks, asksBefore);
    // Neither opens a new form over a transfer that may have left.
    await expect(page.getByTestId('move-review')).toHaveCount(0);
    await expect(page.getByTestId('move-new')).toHaveAttribute('data-kind', 'clear');
  } finally {
    await own.close();
    page = mainPage;
  }
});

test('a send request whose answer the page lost, the browser refusing to save → Clear and start over reads unknown, keeps the transfer on screen, and says the record was not saved — never that nothing was sent', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, op, asks, asksBefore } = await lostSendAnswer(own);
    // Every write of the tracking list is refused until restored below.
    await page.evaluate(() => {
      const orig = Storage.prototype.setItem;
      const win = window as unknown as { __restoreSetItem?: () => void };
      win.__restoreSetItem = () => {
        Storage.prototype.setItem = orig;
      };
      Storage.prototype.setItem = function (k: string, v: string) {
        if (k === 'cbpr.tracking.v1') throw new DOMException('synthetic quota', 'QuotaExceededError');
        return orig.call(this, k, v);
      };
    });
    const answered = page.waitForResponse('**/api/transfer/discard');
    await page.getByTestId('move-clear').click();
    expect(((await (await answered).json()) as { state: string }).state).toBe('unknown');
    // The transfer stays on screen as unknown with no Send and no new form; the wallet was never asked.
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'unknown');
    await expect(page.getByTestId('move-sent-note')).toBeVisible();
    await expect(page.getByTestId('send')).toHaveCount(0);
    await expect(page.getByTestId('move-review')).toHaveCount(0);
    expect(asks()).toBe(asksBefore);
    expect(w.sent).toHaveLength(0);
    // The refusal is about this transfer's record, and says it may still complete — not the pre-send words.
    const error = page.getByTestId('app-error');
    await expect(error).toContainText('could not save this transfer');
    await expect(error).toContainText('The transfer may still complete');
    await expect(error).toContainText('do not send it again');
    await expect(error).not.toContainText('nothing was sent');
    expect(await page.evaluate((h) => (JSON.parse(localStorage.getItem('cbpr.tracking.v1') ?? '[]') as { record: { userOpHash: string } }[]).some((x) => x.record.userOpHash === h), op)).toBe(false);
    await page.evaluate(() => (window as unknown as { __restoreSetItem?: () => void }).__restoreSetItem?.());
  } finally {
    await own.close();
    page = mainPage;
  }
});

/**
 * On a fresh page (`lostSendAnswer`): the earlier transfer's Discard reads unknown and is tracked with a same-nonce
 * gate (nothing left the wallet), and a new 0.0106 XPL transfer next to it is signed with Send open. The hold tests
 * below start from here.
 */
async function signedNextToUnknown(own: BrowserContext) {
  const { w, op, asks, asksBefore } = await lostSendAnswer(own);
  const first = page.waitForResponse('**/api/transfer/discard');
  await page.getByTestId('review-discard').click();
  expect(((await (await first).json()) as { state: string }).state).toBe('unknown');
  await expectTrackedUnknown(op, w, asks, asksBefore);
  await page.getByTestId('move-new').click();
  await expect(page.getByTestId('move-wait-earlier')).toHaveCount(0);
  await draft('0.0106', 'XPL');
  await expect(page.getByTestId('sign')).toBeVisible({ timeout: 120_000 });
  await signOnPage(world.accounts.A.passkey.seed);
  await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
  await expect(page.getByTestId('send')).toBeEnabled();
  await expect(page.getByTestId('move-gate-held')).toHaveCount(0);
  return { w, asks, asksBefore };
}

/** Track alone fails (an HTTP error, so the runner is not said lost and still takes every other request). */
const trackerDown = (r: Route) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic tracker outage' }) });

test('an earlier transfer whose Track answer the runner stops giving → a signed plan next to it is held, not voided: no Send or hand-off, the plan stays; once the runner answers again the hold lifts, and Discard still ends it', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, asks, asksBefore } = await signedNextToUnknown(own);

    // The runner stops answering (network layer): the earlier record's next Track poll fails, so what is known
    // about it is no longer readable. The plan is held — not sent, not handed off, not voided.
    await page.route('**/api/**', (r) => r.abort('connectionrefused'));
    await page.getByTestId('review-discard').click();
    await expect(page.getByTestId('app-error')).toContainText('Not discarded');
    await expect(page.getByTestId('move-gate-held')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('move-gate-held')).toContainText('cannot be checked right now');
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    await expect(page.getByTestId('send')).toBeDisabled();
    await expect(page.getByTestId('send-handoff')).toBeDisabled();
    await expect(page.getByTestId('review-discard')).toBeEnabled();
    expect(asks()).toBe(asksBefore);

    // The runner answers again: the earlier record reads as it did when the plan was built, so the hold lifts
    // and Send is open again; Discard then ends the plan as usual.
    await page.unroute('**/api/**');
    await page.getByTestId('caps-retry').click();
    await expect(page.getByTestId('no-sidecar')).toHaveCount(0);
    await expect(page.getByTestId('move-gate-held')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    await expect(page.getByTestId('send')).toBeEnabled();
    const ended = page.waitForResponse('**/api/transfer/discard');
    await page.getByTestId('review-discard').click();
    expect(((await (await ended).json()) as { state: string }).state).toBe('discarded');
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
    expect(w.sent).toHaveLength(0);
  } finally {
    await own.close();
    page = mainPage;
  }
});

test('the confirmation sheet already open when an earlier record becomes unreadable → the hold disables its Send button too; it is enabled again once the record reads', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, asks, asksBefore } = await signedNextToUnknown(own);
    await page.getByTestId('send').click();
    const sheet = page.getByTestId('send-sheet');
    await expect(sheet).toBeVisible();
    await sheet.getByTestId('send-typed').fill('0.0106');
    await expect(sheet.getByTestId('send-confirm')).toBeEnabled();

    // Track alone fails: the earlier record reads unknown while the runner would still take a send request.
    await page.route('**/api/track', trackerDown);
    await expect(page.getByTestId('move-gate-held')).toBeVisible({ timeout: 30_000 });
    await expect(sheet.getByTestId('send-confirm')).toBeDisabled();
    await expect(page.getByTestId('caps-lost')).toHaveCount(0);
    expect(asks()).toBe(asksBefore);

    // The record reads again: the hold lifts in place, the sheet's button with it.
    await page.unroute('**/api/track');
    await expect(page.getByTestId('move-gate-held')).toHaveCount(0, { timeout: 30_000 });
    await expect(sheet.getByTestId('send-confirm')).toBeEnabled();
    await sheet.getByTestId('send-sheet-close').click();
    await expect(sheet).toBeHidden();
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    expect(asks()).toBe(asksBefore);
    expect(w.sent).toHaveLength(0);
  } finally {
    await own.close();
    page = mainPage;
  }
});

test('a Send already under way (the runner issued it, the wallet still checking its chain) when an earlier record becomes unreadable → given up before the wallet is asked, the plan kept and the runner told nothing was sent; once the record reads, Send is open and Discard ends the plan as discarded', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, asks, asksBefore } = await signedNextToUnknown(own);
    // The wallet's chain answer is held: the send is inside the adapter's pre-flight checks when the hold begins.
    // Were the wallet asked after all, it would refuse rather than broadcast on the shared chain.
    const release = w.holdChainId();
    w.next('reject');
    const callsBefore = w.calls.length;
    await confirmSend('0.0106');
    await expect.poll(() => w.calls.slice(callsBefore).includes('eth_chainId'), { timeout: 30_000 }).toBe(true);
    await page.route('**/api/track', trackerDown);
    await expect(page.getByTestId('move-gate-held')).toBeVisible({ timeout: 30_000 });
    // Released: the wallet is not asked; the runner hears that nothing was sent; the plan stays signed.
    const notSent = page.waitForRequest((q) => q.url().endsWith('/api/transfer/wallet-result') && (q.postDataJSON() as { outcome?: string }).outcome === 'rejected', { timeout: 30_000 });
    release();
    await notSent;
    await expect(page.getByTestId('send-sending')).toHaveCount(0);
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    await expect(page.getByTestId('move-gate-held')).toBeVisible();
    expect(asks()).toBe(asksBefore);
    expect(w.sent).toHaveLength(0);
    // Only the earlier record is in Track: the record this attempt made was taken back.
    await expect(page.getByTestId('track-row')).toHaveCount(1);

    await page.unroute('**/api/track');
    await expect(page.getByTestId('move-gate-held')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('send')).toBeEnabled();
    // The runner knows nothing was sent, so its answer to Discard is discarded — not unknown.
    const ended = page.waitForResponse('**/api/transfer/discard');
    await page.getByTestId('review-discard').click();
    expect(((await (await ended).json()) as { state: string }).state).toBe('discarded');
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
    expect(asks()).toBe(asksBefore);
  } finally {
    await own.close();
    page = mainPage;
  }
});

test('a Send given up under the hold whose "nothing was sent" the runner took but whose answer never reached the page → the plan stays signed and held; when the hold lifts the runner is told again and answers the same signed plan (not a refusal), so Send goes on', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, asks, asksBefore } = await signedNextToUnknown(own);
    const release = w.holdChainId();
    w.next('reject');
    const callsBefore = w.calls.length;
    await confirmSend('0.0106');
    await expect.poll(() => w.calls.slice(callsBefore).includes('eth_chainId'), { timeout: 30_000 }).toBe(true);
    await page.route('**/api/track', trackerDown);
    await expect(page.getByTestId('move-gate-held')).toBeVisible({ timeout: 30_000 });
    // The runner takes the report (on its side the plan is signed again); the answer is lost on the way back.
    const taken: string[] = [];
    await page.route('**/api/transfer/wallet-result', async (r) => {
      const real = await r.fetch();
      taken.push(`${real.status()} ${((await real.json()) as { state?: string }).state}`);
      return r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic: the answer was lost' }) });
    });
    release();
    await expect.poll(() => taken, { timeout: 30_000 }).toEqual(['200 signed']);
    await expect(page.getByTestId('send-sending')).toHaveCount(0);
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    await expect(page.getByTestId('move-gate-held')).toBeVisible();
    expect(asks()).toBe(asksBefore);
    expect(w.sent).toHaveLength(0);
    await page.unroute('**/api/transfer/wallet-result');

    // The hold lifts: the page tells the runner again, and the runner — which already put the plan back — answers
    // the same signed plan instead of refusing an answer it has already given once.
    const again = page.waitForResponse('**/api/transfer/wallet-result', { timeout: 30_000 });
    await page.unroute('**/api/track');
    const res = await again;
    expect([res.status(), ((await res.json()) as { state: string }).state]).toEqual([200, 'signed']);
    await expect(page.getByTestId('move-gate-held')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('send')).toBeEnabled();
    // Send goes on from here: this time the wallet is asked, once (and declines — nothing sent, the plan kept).
    expect(asks()).toBe(asksBefore);
    w.next('reject');
    await confirmSend('0.0106');
    await expect(page.getByTestId('send-rejected')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    expect(asks()).toBe(asksBefore + 1);
    expect(w.sent).toHaveLength(0);
    const ended = page.waitForResponse('**/api/transfer/discard');
    await page.getByTestId('review-discard').click();
    expect(((await (await ended).json()) as { state: string }).state).toBe('discarded');
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
  } finally {
    await own.close();
    page = mainPage;
  }
});

test('a Send already under way when the whole runner stops answering → given up before the wallet is asked, the plan kept; the runner hears nothing was sent once it answers again, and Discard then ends the plan as discarded', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, asks, asksBefore } = await signedNextToUnknown(own);
    const release = w.holdChainId();
    w.next('reject');
    const callsBefore = w.calls.length;
    await confirmSend('0.0106');
    await expect.poll(() => w.calls.slice(callsBefore).includes('eth_chainId'), { timeout: 30_000 }).toBe(true);
    // The runner stops (network layer): the earlier record's poll fails and the hold begins while the wallet is still checking.
    const walletResults: string[] = [];
    await page.route('**/api/**', (r) => {
      if (r.request().url().endsWith('/api/transfer/wallet-result')) walletResults.push('aborted');
      return r.abort('connectionrefused');
    });
    await expect(page.getByTestId('move-gate-held')).toBeVisible({ timeout: 30_000 });
    // Released: the wallet is not asked; "nothing was sent" cannot reach the runner yet; the plan stays signed.
    release();
    await expect.poll(() => walletResults, { timeout: 30_000 }).toEqual(['aborted']);
    await expect(page.getByTestId('send-sending')).toHaveCount(0);
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    await expect(page.getByTestId('caps-lost')).toBeVisible();
    expect(asks()).toBe(asksBefore);
    expect(w.sent).toHaveLength(0);

    // The runner answers again: the hold lifts and the page reports the give-up before anything else is asked.
    await page.unroute('**/api/**');
    const reported = page.waitForResponse((r) => r.url().endsWith('/api/transfer/wallet-result') && r.status() === 200, { timeout: 30_000 });
    await page.getByTestId('caps-retry').click();
    await reported;
    await expect(page.getByTestId('move-gate-held')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    await expect(page.getByTestId('send')).toBeEnabled();
    const ended = page.waitForResponse('**/api/transfer/discard');
    await page.getByTestId('review-discard').click();
    expect(((await (await ended).json()) as { state: string }).state).toBe('discarded');
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
    expect(asks()).toBe(asksBefore);
    expect(w.sent).toHaveLength(0);
  } finally {
    await own.close();
    page = mainPage;
  }
});

test('Discard pressed while the "nothing was sent" report the lifted hold made is still unanswered → Discard waits for that one answer (no second report), then ends the plan as discarded; the answer arriving never brings the plan back', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  try {
    const { w, asks, asksBefore } = await signedNextToUnknown(own);
    // As in the test above: a give-up under the hold the runner did not hear, because it was not answering.
    const release = w.holdChainId();
    w.next('reject');
    const callsBefore = w.calls.length;
    await confirmSend('0.0106');
    await expect.poll(() => w.calls.slice(callsBefore).includes('eth_chainId'), { timeout: 30_000 }).toBe(true);
    const aborted: string[] = [];
    await page.route('**/api/**', (r) => {
      if (r.request().url().endsWith('/api/transfer/wallet-result')) aborted.push('aborted');
      return r.abort('connectionrefused');
    });
    await expect(page.getByTestId('move-gate-held')).toBeVisible({ timeout: 30_000 });
    release();
    await expect.poll(() => aborted, { timeout: 30_000 }).toEqual(['aborted']);
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    await page.unroute('**/api/**');

    // The runner answers again. It takes the report the lifted hold now makes (the plan is signed again there),
    // but that answer is held on its way back to the page.
    let releaseAnswer!: () => void;
    const answerHeld = new Promise<void>((r) => (releaseAnswer = r));
    const reports: number[] = [];
    await page.route('**/api/transfer/wallet-result', async (r) => {
      const response = await r.fetch();
      reports.push(response.status());
      if (reports.length === 1) await answerHeld;
      await r.fulfill({ response });
    });
    await page.getByTestId('caps-retry').click();
    await expect.poll(() => reports, { timeout: 30_000 }).toEqual([200]);
    await expect(page.getByTestId('move-gate-held')).toHaveCount(0, { timeout: 30_000 });
    // Discard while that answer is still out: it waits for it instead of reporting again (a second report would
    // be refused, and a Discard that went ahead would be undone by the first answer landing after it).
    await page.getByTestId('review-discard').click();
    await expect(page.getByTestId('review-discard')).toBeDisabled();
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
    expect(reports).toEqual([200]);
    const ended = page.waitForResponse('**/api/transfer/discard', { timeout: 30_000 });
    releaseAnswer();
    expect(((await (await ended).json()) as { state: string }).state).toBe('discarded');
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
    // Settled: one report, answered before Discard asked anything; nothing left to land.
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
    await expect(page.getByTestId('send')).toHaveCount(0);
    expect(reports).toEqual([200]);
    expect(asks()).toBe(asksBefore);
    expect(w.sent).toHaveLength(0);
  } finally {
    await own.close();
    page = mainPage;
  }
});

/**
 * On `signedNextToUnknown`'s page: a hand-off code the runner has issued whose answer is held on its way back,
 * and — before it arrives — the earlier record stops reading, so the page is in hold. `releaseCode` lets the
 * answer through (safe to call twice).
 */
async function handoffAnsweredUnderHold(own: BrowserContext) {
  const { w, asks, asksBefore } = await signedNextToUnknown(own);
  let releaseCode!: () => void;
  const codeHeld = new Promise<void>((r) => (releaseCode = r));
  let issued!: () => void;
  const codeIssued = new Promise<void>((r) => (issued = r));
  await page.route('**/api/transfer/handoff', async (r) => {
    const response = await r.fetch();
    expect(response.status()).toBe(200);
    issued();
    await codeHeld;
    await r.fulfill({ response });
  });
  await page.getByTestId('send-terminal').locator('summary').click();
  await page.getByTestId('send-handoff').click();
  await codeIssued;
  await page.route('**/api/track', trackerDown);
  await expect(page.getByTestId('move-gate-held')).toBeVisible({ timeout: 30_000 });
  return { w, asks, asksBefore, releaseCode };
}

test('a hand-off code being created when an earlier record becomes unreadable → the code is never shown: the hand-off is discarded on the runner (unclaimed, nothing sent), the page says so, and only the earlier record stays in Track', async ({ browser }) => {
  const mainPage = page;
  const own = await browser.newContext();
  let release = () => {};
  try {
    const { w, asks, asksBefore, releaseCode } = await handoffAnsweredUnderHold(own);
    release = releaseCode;
    const ended = page.waitForResponse('**/api/transfer/discard', { timeout: 30_000 });
    releaseCode();
    expect(((await (await ended).json()) as { state: string }).state).toBe('discarded');
    await expect(page.getByTestId('handoff-code')).toHaveCount(0);
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'discarded');
    await expect(page.getByTestId('app-error')).toContainText('the code is not shown');
    await expect(page.getByTestId('app-error')).toContainText('was discarded, nothing was sent');
    await expect(page.getByTestId('move-handoff-cancel')).toHaveCount(0);
    await expect(page.getByTestId('track-row')).toHaveCount(1);
    expect(asks()).toBe(asksBefore);
    expect(w.sent).toHaveLength(0);
    // The record reads again: the form is there to review and sign again; the runner holds nothing for this plan.
    await page.unroute('**/api/track');
    await expect(page.getByTestId('move-wait-earlier')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'discarded');
    await expect(page.getByTestId('handoff-code')).toHaveCount(0);
  } finally {
    release();
    await own.close();
    page = mainPage;
  }
});

const discardFailures: { label: string; said: string; fail: (r: Route) => Promise<void> }[] = [
  { label: 'the connection refused', said: 'stopped answering', fail: (r) => r.abort('connectionrefused') },
  { label: 'a 503', said: 'synthetic discard outage', fail: (r) => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'synthetic discard outage' }) }) },
];
for (const { label, said, fail } of discardFailures)
  test(`the discard of a hand-off made as a hold began fails (${label}) → the plan stays and the code stays hidden: the page says the runner did not confirm, Send and the hand-off wait; Discard asks again and only the runner's discarded ends the plan`, async ({ browser }) => {
    const mainPage = page;
    const own = await browser.newContext();
    let release = () => {};
    try {
      const { w, asks, asksBefore, releaseCode } = await handoffAnsweredUnderHold(own);
      release = releaseCode;
      await page.route('**/api/transfer/discard', fail);
      const asked = page.waitForRequest((q) => q.url().endsWith('/api/transfer/discard'), { timeout: 30_000 });
      releaseCode();
      await asked;
      // Not confirmed: nothing is claimed discarded; the plan and its retry path stay, Send and a new hand-off wait.
      await expect(page.getByTestId('move-handoff-cancel')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('handoff-code')).toHaveCount(0);
      await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
      await expect(page.getByTestId('app-error')).toContainText('did not confirm it discarded');
      await expect(page.getByTestId('app-error')).toContainText(said);
      await expect(page.getByTestId('app-error')).not.toContainText('was discarded');
      await expect(page.getByTestId('review-discard')).toBeEnabled();
      await expect(page.getByTestId('send')).toBeDisabled();
      await expect(page.getByTestId('send-handoff')).toBeDisabled();
      await expect(page.getByTestId('track-row')).toHaveCount(1);
      expect(asks()).toBe(asksBefore);
      expect(w.sent).toHaveLength(0);
      // The earlier record reads again: the hold lifts, but Send still waits for the runner's word on this plan.
      await page.unroute('**/api/track');
      await expect(page.getByTestId('move-gate-held')).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByTestId('move-handoff-cancel')).toBeVisible();
      await expect(page.getByTestId('send')).toBeDisabled();
      await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'signed');
      // Discard asks the same runner again; its discarded (the unclaimed hand-off) ends the plan.
      await page.unroute('**/api/transfer/discard');
      const ended = page.waitForResponse('**/api/transfer/discard', { timeout: 30_000 });
      await page.getByTestId('review-discard').click();
      expect(((await (await ended).json()) as { state: string }).state).toBe('discarded');
      await expect(page.getByTestId('move')).toHaveAttribute('data-plan-state', 'draft');
      await expect(page.getByTestId('move-handoff-cancel')).toHaveCount(0);
      await expect(page.getByTestId('track-row')).toHaveCount(1);
      expect(asks()).toBe(asksBefore);
      expect(w.sent).toHaveLength(0);
    } finally {
      release();
      await own.close();
      page = mainPage;
    }
  });
