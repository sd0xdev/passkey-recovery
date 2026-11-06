// The home page's "Who holds what" (the boundary map's "This page" region, bound.site.d) must agree with the Security page on where a gas key can be: a keystore created
// or opened in the page puts its key in this tab's memory, and the tool stays mounted when the reader goes back Home, so
// "this page holds no key" is false. The runner's main process really does hold none (the native signer is its own
// process), so the same words stay true there.
import { describe, expect, it } from 'vitest';
import { SITE_EN, SITE_ZH } from '../../../src/ui/site/copy-site';

describe('site copy: who holds a key', () => {
  it('EN "This page" names the tab memory, as the Security page does, and never denies holding a key', () => {
    expect(SITE_EN['sec.keys.body']).toContain('this tab’s memory');
    expect(SITE_EN['bound.site.d']).toContain('this tab’s memory');
    expect(SITE_EN['bound.site.d']).not.toMatch(/holds no key/i);
    // A keystore created in the page puts its key there as much as one opened there.
    for (const k of ['bound.site.d', 'sec.keys.body'] as const) expect(SITE_EN[k], k).toMatch(/created? or open(ed)? a keystore|keystore you created or opened/);
  });

  it('繁中「這個頁面」names the tab memory, as the Security page does, and never denies holding a key', () => {
    expect(SITE_ZH['sec.keys.body']).toContain('分頁的記憶體');
    expect(SITE_ZH['bound.site.d']).toContain('分頁的記憶體');
    expect(SITE_ZH['bound.site.d']).not.toContain('不持有任何私鑰');
    for (const k of ['bound.site.d', 'sec.keys.body'] as const) expect(SITE_ZH[k], k).toContain('建立或開啟');
  });

  it('How it works: the native signer starts with the runner (unless switched off) and holds a key only once one is set up and unlocked', () => {
    expect(SITE_EN['how.signer.body']).toContain('--no-native-signer');
    expect(SITE_EN['how.signer.body']).toMatch(/holds no key until you set up a native gas way and unlock it/);
    expect(SITE_EN['how.signer.body']).not.toMatch(/only when you choose/i);
    expect(SITE_ZH['how.signer.body']).toContain('--no-native-signer');
    expect(SITE_ZH['how.signer.body']).toContain('在你設定並解鎖 native gas 方式之前，它不持有任何私鑰');
    expect(SITE_ZH['how.signer.body']).not.toContain('只有在你選擇');
  });

  it('the runner, which holds no key, still says so in both languages', () => {
    expect(SITE_EN['bound.runner.d']).toMatch(/holds no key/i);
    expect(SITE_ZH['bound.runner.d']).toContain('不持有任何私鑰');
  });
});

// COPY-1 (6-recovery-atlas.md §7, PM findings 1–2): no unconditional "it will move" promise anywhere on the
// site, and the passkey is kept by its provider (possibly synced), scoped to keys.coinbase.com — not "with Coinbase".
describe('site copy: no guarantee, and where the passkey lives', () => {
  const GUARANTEE_EN = /can still move them|will (always )?(get|move) (your|them)|guarantee/i;
  const GUARANTEE_ZH = /仍然轉得出來|一定轉得出|一定能|保證/;

  it('regression: no EN string promises the funds can be moved', () => {
    for (const [k, v] of Object.entries(SITE_EN)) expect(v, k).not.toMatch(GUARANTEE_EN);
  });

  it('regression: no 繁中 string promises the funds can be moved', () => {
    for (const [k, v] of Object.entries(SITE_ZH)) expect(v, k).not.toMatch(GUARANTEE_ZH);
  });

  it('the home title and subtitle are conditional: a wallet may not be ready; placed only if needed and compatible', () => {
    expect(SITE_EN['home.title']).toBe('Your address is there. Your wallet may not be ready.');
    expect(SITE_ZH['home.title']).toBe('地址還在，錢包可能尚未就緒。');
    expect(SITE_EN['home.sub']).toContain('only if it is needed and compatible');
    expect(SITE_ZH['home.sub']).toContain('只在需要且相容時');
  });

  it('regression: the passkey is the provider’s (may sync) and signs only for keys.coinbase.com, in both languages', () => {
    expect(SITE_EN['how.passkey']).not.toMatch(/stays with Coinbase/i);
    expect(SITE_ZH['how.passkey']).not.toContain('留在 Coinbase');
    for (const k of ['how.passkey.body', 'bound.keys.d'] as const) {
      expect(SITE_EN[k], k).toMatch(/passkey provider/);
      expect(SITE_EN[k], k).toMatch(/sync/);
      expect(SITE_EN[k], k).toContain('only for keys.coinbase.com');
      expect(SITE_ZH[k], k).toContain('Passkey 提供者');
      expect(SITE_ZH[k], k).toContain('同步');
      expect(SITE_ZH[k], k).toContain('只能為 keys.coinbase.com');
    }
  });
});

describe('site copy: the FAQ on keys', () => {
  // An account can have other owners besides the passkey (an address owner, say): the answer names the passkey this
  // flow uses, never that the passkey alone signs for the wallet.
  it('EN names the Passkey this recovery flow uses, without an exclusive-owner claim', () => {
    expect(SITE_EN['faq.keys.a']).toContain('This recovery flow signs for the wallet you recover with your Passkey');
    expect(SITE_EN['faq.keys.a']).not.toMatch(/passkey alone/i);
    expect(SITE_EN['faq.keys.a']).toContain('gas wallet’s keystore password');
  });
  it('繁中 names the Passkey this recovery flow uses, without an exclusive-owner claim', () => {
    expect(SITE_ZH['faq.keys.a']).toContain('這個救援流程用你的 Passkey 為你要救援的錢包簽署');
    expect(SITE_ZH['faq.keys.a']).not.toMatch(/只由它的 Passkey/);
    expect(SITE_ZH['faq.keys.a']).toContain('gas 錢包的 keystore 密碼');
  });
});
