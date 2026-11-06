// The helper shown by the proof sheet of the built page (sidecar bundle, 4175, SYNTHETIC testchain), run through Chromium's real DevTools command-line API
// (CDP Runtime.evaluate with includeCommandLineAPI + replMode, as the Console panel evaluates input).
// SYNTHETIC: navigator.credentials.get is a test stub whose Promise stays pending until the test
// settles it with a throwaway-key assertion, and `location` is bound to a stand-in object so the exact
// helper text passes its origin guard without loading any Coinbase page or touching a real Passkey.
// copy() hands its argument to the DevTools client via Runtime.inspectRequested (copyToClipboard);
// the OS clipboard write that the real DevTools frontend then performs is outside this test.
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { base64urlToBytes } from '../../src/crypto/bytes';
import { buildHelper, HELPER_VERSION } from '../../src/webauthn/helper';
import { E2E_PROVIDER, type E2eWorld } from '../support/e2e-constants';
import { legacyHelperSourceV1 } from '../fixtures/legacyHelper';
import { buildAssertion, syntheticKey } from '../fixtures/synthetic';

interface Inspected { hints: Record<string, unknown>; type: string; value: unknown }

const external: string[] = [];
test.beforeEach(async ({ page }) => {
  external.length = 0;
  await page.route(/^(?!http:\/\/127\.0\.0\.1:4175\/).*/, (route) => {
    external.push(route.request().url());
    return route.abort('blockedbyclient');
  });
});
test.afterEach(() => expect(external).toEqual([]));

/** Wallet A checked from its creation evidence on the testchain sidecar, then the proof sheet's helper. */
async function setup(page: Page) {
  const world = (await (await fetch(`${E2E_PROVIDER}/world`)).json()) as E2eWorld;
  const A = world.accounts.A;
  await page.goto('http://127.0.0.1:4175/recover');
  await page.getByTestId('check-account').fill(A.address);
  await page.getByTestId('check-evidence-toggle').click();
  await page.getByTestId('check-owners').fill(A.owners.join('\n'));
  await page.getByTestId('check-nonce').fill(A.nonce);
  await page.getByTestId('check-run').click();
  await page.getByTestId('summary-prove').click({ timeout: 120_000 });
  await page.getByTestId('proof-start').click();
  const challenge = (await page.getByTestId('proof-challenge').textContent())!.trim();
  await page.getByTestId('proof-advanced').locator('summary').click();
  const helperSource = (await page.getByTestId('proof-helper').textContent())!;
  // A wrong-key assertion, so the page's verdict below can only be "signature mismatch".
  const a = buildAssertion({ challenge: base64urlToBytes(challenge), key: syntheticKey(0x7e) });
  // Synthetic credential stub: records each call and resolves only when __cbprSettle() is called.
  await page.evaluate((f) => {
    const buf = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (x) => x.charCodeAt(0)).buffer;
    const w = window as unknown as Record<string, unknown>;
    w.__cbprCalls = [];
    w.__cbprLoc = { origin: 'https://keys.coinbase.com' };
    w.__cbprNav = {
      credentials: {
        get: (o: { publicKey: { challenge: Uint8Array; rpId: string } }) =>
          new Promise((resolve) => {
            (w.__cbprCalls as unknown[]).push({ rpId: o.publicKey.rpId, challenge: Array.from(new Uint8Array(o.publicKey.challenge)) });
            w.__cbprSettle = () =>
              resolve({
                rawId: buf(f.credentialId!),
                response: { authenticatorData: buf(f.authenticatorData!), clientDataJSON: buf(f.clientDataJSON!), signature: buf(f.signature!), userHandle: null },
              });
          }),
      },
    };
  }, a.fields);
  const cdp = await page.context().newCDPSession(page);
  const inspected: Inspected[] = [];
  const consoleCalls: string[] = [];
  cdp.on('Runtime.inspectRequested', (e) => inspected.push({ hints: e.hints, type: e.object.type, value: e.object.value }));
  cdp.on('Runtime.consoleAPICalled', (e) => consoleCalls.push(e.type));
  await cdp.send('Runtime.enable');
  return { cdp, helperSource, challenge, inspected, consoleCalls };
}

// Evaluate like the Console panel; the returned Promise handle is awaited separately so the test can
// observe it pending while the "Passkey prompt" is open.
async function consoleEvaluate(cdp: CDPSession, expression: string) {
  const r = await cdp.send('Runtime.evaluate', { expression, includeCommandLineAPI: true, replMode: true, objectGroup: 'console' });
  expect(r.exceptionDetails).toBeUndefined();
  return r.result.objectId!;
}

const asKeysTab = (source: string) => `((location, navigator) => ${source})(window.__cbprLoc, window.__cbprNav)`;

async function settleAndAwait(page: Page, cdp: CDPSession, promiseObjectId: string) {
  const awaited = cdp.send('Runtime.awaitPromise', { promiseObjectId, returnByValue: true });
  let finished = false;
  void awaited.then(() => (finished = true));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __cbprCalls: unknown[] }).__cbprCalls.length)).toBe(1);
  await page.waitForTimeout(200);
  expect(finished).toBe(false); // still waiting on the authenticator
  await page.evaluate(() => (window as unknown as { __cbprSettle: () => void }).__cbprSettle());
  return awaited;
}

test('v2 helper from the bundle copies the assertion after a pending Passkey prompt, prints nothing', async ({ page }) => {
  const { cdp, helperSource, challenge, inspected, consoleCalls } = await setup(page);
  expect(helperSource).toContain(`"${HELPER_VERSION}: assertion copied to clipboard (not printed)"`);
  // The page shows exactly the bundled helper for its own challenge, with its hash.
  const bundled = buildHelper(base64urlToBytes(challenge), 'proof');
  expect(helperSource).toBe(bundled.source);
  await expect(page.getByTestId('proof-helper-sha256')).toContainText(bundled.sha256Hex);
  await expect(page.getByTestId('proof-advanced')).toContainText('https://keys.coinbase.com/connect');
  const handle = await consoleEvaluate(cdp, asKeysTab(helperSource));
  const out = await settleAndAwait(page, cdp, handle);
  expect(out.exceptionDetails).toBeUndefined();
  expect(out.result.value).toBe(`${HELPER_VERSION}: assertion copied to clipboard (not printed)`);
  expect(inspected).toHaveLength(1);
  expect(inspected[0]!.hints).toMatchObject({ copyToClipboard: true });
  expect(inspected[0]!.type).toBe('string');
  expect(consoleCalls).toEqual([]);
  // The copied text is exactly what the import box expects: a wrong fixture key → mismatch on signature only.
  await page.getByTestId('proof-input').fill(inspected[0]!.value as string);
  await page.getByTestId('proof-verify').click();
  const result = page.getByTestId('proof-result');
  await expect(result).toHaveAttribute('data-status', 'mismatch');
  await expect(result.locator('li[data-ok="false"]')).toHaveCount(1);
  await expect(result.locator('li[data-ok="false"]')).toHaveAttribute('data-check', 'signature');
});

test('regression: the v1 helper throws "copy is not defined" in real DevTools after the prompt resolves', async ({ page }) => {
  const { cdp, challenge, inspected, consoleCalls } = await setup(page);
  const handle = await consoleEvaluate(cdp, asKeysTab(legacyHelperSourceV1(base64urlToBytes(challenge), 'proof')));
  const out = await settleAndAwait(page, cdp, handle);
  expect(out.exceptionDetails?.exception?.description ?? '').toMatch(/^ReferenceError: copy is not defined/);
  expect(inspected).toEqual([]);
  expect(consoleCalls).toEqual([]);
});

test('on the real page origin the helper refuses before any credential request', async ({ page }) => {
  const { cdp, helperSource } = await setup(page);
  await page.evaluate(() => {
    const w = window as unknown as { __cbprRealCalls: number };
    w.__cbprRealCalls = 0;
    navigator.credentials.get = () => {
      w.__cbprRealCalls += 1;
      return Promise.reject(new Error('stub'));
    };
  });
  const handle = await consoleEvaluate(cdp, helperSource);
  const out = await cdp.send('Runtime.awaitPromise', { promiseObjectId: handle, returnByValue: true });
  expect(out.exceptionDetails?.exception?.description ?? '').toContain('Run only on https://keys.coinbase.com');
  expect(await page.evaluate(() => (window as unknown as { __cbprRealCalls: number }).__cbprRealCalls)).toBe(0);
});
