// Every code the native signer or the File key can answer with, and every field shape, has copy in both
// languages: the gas sheet builds these keys at run time, and a missing key must never reach t().
import { describe, expect, it } from 'vitest';
import { FIELD_SHAPES, Op1pError, type OpErrorKind } from '../../../server/runner/op1p';
import { ManifestError, type ManifestErrorKind } from '../../../server/runner/gasManifest';
import { StoreError } from '../../../server/runner/store';
import { KeystoreSourceError, type KeystoreSourceErrorKind } from '../../../server/runner/keystoreSource';
import { KeystoreV3Error } from '../../../src/wallet/keystoreV3';
import { ApiError } from '../../../src/ui/api';
import { gasErrorKey } from '../../../src/ui/gas/GasPanel';
import { refusalText } from '../../../src/ui/gas/payer';
import { SIGN_REFUSALS } from '../../../src/config/signerApi';
import { hasMessage, MESSAGES } from '../../../src/ui/i18n';

const OP: OpErrorKind[] = ['missing', 'unavailable', 'locked', 'denied', 'cancelled', 'not-found', 'account', 'timeout', 'failed', 'link', 'field', 'field-password', 'changed'];
const FILE: KeystoreV3Error['code'][] = ['malformed', 'unsupported', 'wrong-password', 'weak-password', 'address-mismatch'];
const STORE: StoreError['kind'][] = ['unsafe-dir', 'exists', 'not-found', 'malformed', 'io'];
const MANIFEST: ManifestErrorKind[] = ['missing', 'malformed', 'chain', 'keystore', 'changed', 'link', 'password-field', 'wrong-password', 'address', 'stale'];
const KEYSTORE: KeystoreSourceErrorKind[] = ['path', 'missing', 'symlink', 'not-file', 'permissions', 'size', 'format', 'password-field', 'wrong-password', 'manifest-changed', 'manifest-address', 'changed'];

describe('gas sheet copy', () => {
  it('every field shape the runner reports has EN and 繁中 copy', () => {
    expect(FIELD_SHAPES.filter((s) => !hasMessage(`gas.op.shape.${s}`))).toEqual([]);
  });
  it('every op / file / store / manifest / keystore error kind the signer answers with has EN and 繁中 copy', () => {
    const codes = [...OP.map((k) => `op-${k}`), ...FILE.map((c) => `file-${c}`), ...STORE.map((k) => `store-${k}`), ...MANIFEST.map((k) => `manifest-${k}`), ...KEYSTORE.map((k) => `keystore-${k}`)];
    expect(codes.filter((c) => !hasMessage(`gas.err.${c}`))).toEqual([]);
    // The classes the test lists are the classes the code throws (a new kind needs copy and this list).
    expect(new Op1pError('field', 'x').kind).toBe('field');
    expect(new StoreError('io', 'x').kind).toBe('io');
    expect(new ManifestError('address', 'x').kind).toBe('address');
    expect(new KeystoreSourceError('symlink', 'x').kind).toBe('symlink');
  });
  it('a known code → its key; an unknown code (a newer runner) → the runner’s own message, never a missing key', () => {
    expect(gasErrorKey(new ApiError(400, 'bad field', 'http', 'op-field'))).toEqual({ key: 'gas.err.op-field' });
    expect(gasErrorKey(new ApiError(400, 'not that item', 'http', 'manifest-link'))).toEqual({ key: 'gas.err.manifest-link' });
    expect(gasErrorKey(new ApiError(400, 'a link', 'http', 'keystore-symlink'))).toEqual({ key: 'gas.err.keystore-symlink' });
    expect(gasErrorKey(new ApiError(409, 'changed', 'http', 'keystore-manifest-changed'))).toEqual({ key: 'gas.err.keystore-manifest-changed' });
    expect(gasErrorKey(new ApiError(409, 'a new kind of refusal', 'http', 'op-brand-new'))).toEqual({ raw: 'a new kind of refusal' });
    expect(gasErrorKey(new KeystoreV3Error('nope', 'wrong-password'))).toEqual({ key: 'gas.err.file-wrong-password' });
    expect(gasErrorKey(Object.assign(new Error('odd'), { code: 'never-seen' }))).toEqual({ raw: 'odd' });
  });
});

describe('runtime compatibility and sign refusals (request 2026-11-01-gas-runtime-ux)', () => {
  const both = (k: string) => [MESSAGES.en[k as keyof (typeof MESSAGES)['en']], MESSAGES['zh-Hant-TW'][k as keyof (typeof MESSAGES)['en']]];
  it('KSS-06: every sign refusal code has EN and 繁中 copy and is translated by the gas sheet', () => {
    expect(SIGN_REFUSALS.filter((c) => !hasMessage(`gas.err.${c}`))).toEqual([]);
    for (const c of SIGN_REFUSALS) expect(gasErrorKey(new ApiError(409, 'native signer: refused', 'http', c))).toEqual({ key: `gas.err.${c}` });
    // The three sign-time keystore reasons say nothing was sent and what to do.
    for (const c of ['keystore-stale', 'keystore-key-changed']) expect(both(`gas.err.${c}`).map((t = '') => /nothing was sent|沒有送出任何東西/.test(t))).toEqual([true, true]);
  });
  it('the refusal text is the code’s copy, else the runner’s reason', () => {
    const t = (k: string) => `T(${k})`;
    expect(refusalText(t as never, { reason: 'raw', reasonCode: 'keystore-stale' })).toBe('T(gas.err.keystore-stale)');
    expect(refusalText(t as never, { reason: 'raw' })).toBe('raw');
  });
  it('an older runner: the 404 class and both guidance texts in EN and 繁中 name the restart (local) or update and pair (website)', () => {
    expect(gasErrorKey(new ApiError(404, 'unknown endpoint', 'http', 'runner-outdated'))).toEqual({ key: 'gas.err.runner-outdated' });
    // The local guidance names the runner (npm run runner / npm exec … passkey-recovery), never npm start: that
    // starts the old sidecar, which has no native signer.
    for (const k of ['gas.compat.runner-older.local', 'gas.compat.unknown.local', 'gas.err.runner-outdated'])
      expect(both(k).map((t = '') => /npm run runner/.test(t) && /npm exec … passkey-recovery/.test(t) && !/npm start/.test(t) && /reload|重新整理/.test(t))).toEqual([true, true]);
    // A newer runner serves the page it loaded at start: the guidance restarts it, not only a reload.
    expect(both('gas.compat.runner-newer.local').map((t = '') => /Ctrl\+C/.test(t) && /npm run build/.test(t) && /npm run runner/.test(t) && !/npm start/.test(t))).toEqual([true, true]);
    expect(both('gas.compat.runner-older.hosted').map((t = '') => /pair|配對/.test(t))).toEqual([true, true]);
    for (const k of ['gas.compat.runner-newer.local', 'gas.compat.runner-newer.hosted', 'gas.compat.recheck', 'gas.compat.versions', 'gas.err.runner-outdated']) expect(both(k).every(Boolean)).toBe(true);
    expect(`${MESSAGES.en['gas.err.runner-outdated']}${MESSAGES['zh-Hant-TW']['gas.err.runner-outdated']}`).not.toMatch(/unknown endpoint|password|密碼/);
  });
  it('the path field’s hints speak of paths only: never “not a key”', () => {
    for (const k of ['gas.ks.pathShape.file-path', 'gas.ks.pathShape.empty', 'gas.ks.pathShape.other']) {
      const [en, zh] = both(k);
      expect([en, zh].every(Boolean)).toBe(true);
      expect(`${en}${zh}`).not.toMatch(/key|私鑰/);
    }
  });
  it('every mode and source option, stage and state word has EN and 繁中 copy', () => {
    const keys = ['wallet', 'browser-file', 'native-op', 'native-keystore', 'native-file'].flatMap((m) => [`gas.opt.${m}`, `gas.opt.${m}.line`]);
    keys.push('gas.opt.chosen', 'gas.opt.runner', 'gas.opt.needsRunner.runner', 'gas.opt.needsRunner.website', 'gas.opt.needsRunner.preview', 'gas.opt.updateRunner', 'gas.ks.tech', 'gas.stage.label');
    for (const s of ['source', 'item', 'item.file', 'item.manifest', 'fields', 'open', 'confirm', 'done', 'input', 'queued', 'working', 'next', 'waiting', 'failed']) keys.push(`gas.stage.${s}`);
    expect(keys.filter((k) => !both(k).every(Boolean))).toEqual([]);
  });
  it('the “working” lines of the keystore form never ask for 1Password approval (PM-01b)', () => {
    for (const k of ['gas.ks.finding', 'gas.ks.readback'] as const) {
      const [en, zh] = both(k);
      expect([en, zh].every(Boolean)).toBe(true);
      expect(`${en}`).not.toMatch(/approve/i);
      expect(`${zh}`).not.toMatch(/核准/);
    }
    expect(MESSAGES.en['gas.op.waiting']).toMatch(/Approve the request in the 1Password app/); // the waiting line does
  });
  it('a request waiting, unsent, for the signer says it is not sent yet and asks nothing of 1Password; a failed leave lock says the key may still be unlocked (EN + 繁中)', () => {
    for (const k of ['gas.queued', 'gas.queued.button', 'gas.stage.queued', 'gas.leave.failed', 'gas.leave.retry'] as const) expect(both(k).every(Boolean), k).toBe(true);
    expect(MESSAGES.en['gas.queued']).toMatch(/sent after that; nothing is asked of 1Password yet/);
    expect(MESSAGES['zh-Hant-TW']['gas.queued']).toContain('之後才會送出你的請求；目前還不會向 1Password 要求任何東西');
    for (const k of ['gas.queued', 'gas.queued.button', 'gas.stage.queued'] as const) {
      expect(MESSAGES.en[k]).not.toMatch(/approve/i);
      expect(MESSAGES['zh-Hant-TW'][k]).not.toMatch(/核准/);
    }
    expect(MESSAGES.en['gas.leave.failed']).toMatch(/may still be unlocked there/);
    expect(MESSAGES['zh-Hant-TW']['gas.leave.failed']).toContain('可能仍在那裡解鎖著');
    expect(both('gas.leave.retry')).toEqual(['Lock it again', '再鎖一次']);
  });
});

describe('roles and where things run (GAS-01, NX-04)', () => {
  const both = (k: Parameters<typeof hasMessage>[0] & keyof (typeof MESSAGES)['en']) => [MESSAGES.en[k], MESSAGES['zh-Hant-TW'][k]];
  it('the gas wallet is named as the fee payer, never as the recovered source account', () => {
    expect(both('deploy.payer')).toEqual(['Gas wallet (pays the fee)', 'Gas 錢包（支付手續費）']);
    expect(both('gas.lead').every((s) => /never holds or moves the recovered funds|從不持有或轉移被救回的資金/.test(s))).toBe(true);
    expect(MESSAGES.en['review.from']).not.toMatch(/gas/i);
  });
  it('the pairing sheet says what the runner needs: Node 24 + npm, no extension, no global install, first-run download, local simulation', () => {
    const [en, zh] = both('pair.prereq');
    for (const re of [/Node\.js 24/, /npm/, /no browser extension/, /nothing installed globally/, /first run downloads/, /simulation/, /this computer/]) expect(en).toMatch(re);
    for (const re of [/Node\.js 24/, /npm/, /不需要瀏覽器擴充功能/, /不做全域安裝/, /第一次執行會/, /模擬/, /這台電腦/]) expect(zh).toMatch(re);
    expect(`${en}${zh}`).not.toMatch(/\bnpx\b/);
    expect(`${MESSAGES.en['gas.err.no-runner']}${MESSAGES['zh-Hant-TW']['gas.err.no-runner']}`).not.toMatch(/\bnpx\b/);
  });
  it('a picked keystore goes only to the runner’s signer on this computer; nothing is copied, uploaded or written', () => {
    const [en, zh] = both('gas.ks.pickHelp');
    for (const re of [/only to the runner’s signer on this computer/, /not to a website/, /No copy is kept/, /nothing is written to disk/]) expect(en).toMatch(re);
    for (const re of [/只會傳給這台電腦上 runner 的簽署程序/, /不會傳給任何網站/, /不會留下副本/, /不會寫入磁碟/]) expect(zh).toMatch(re);
    const [mEn, mZh] = both('gas.mode.native-keystore.help');
    expect([mEn, mZh].map((t = "") => /never uploaded to a website|不會上傳到任何網站/.test(t))).toEqual([true, true]);
    expect([mEn, mZh].map((t = "") => /only to the signer on this computer|只會傳給這台電腦上的 signer/.test(t))).toEqual([true, true]);
    expect(`${mEn}${mZh}`).not.toMatch(/not copied|不會被複製/);
  });
  it('the page says it cannot see a picked file’s location (it never invents a path)', () => {
    const [en, zh] = both('gas.ks.picked');
    expect([en, zh].map((t = "") => /\{name\}/.test(t) && !/\{path\}/.test(t))).toEqual([true, true]);
    expect(en).toMatch(/cannot see where this file is/);
    expect(zh).toMatch(/無法得知這個檔案在你電腦上的位置/);
  });
  it('a file picked in another tab, and a runner that locked it in the background, are each said in EN and 繁中', () => {
    const [en, zh] = both('gas.err.keystore-other-tab');
    expect([en, zh].map((t = '') => /another tab|另一個分頁/.test(t))).toEqual([true, true]);
    const [cEn, cZh] = both('gas.chipLost');
    expect([cEn, cZh].map((t = '') => /\{mode\}/.test(t) && /locked|已鎖定/.test(t))).toEqual([true, true]);
  });
});
