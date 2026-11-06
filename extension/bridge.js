// Passkey Recovery bridge, state machine (ADR-002). Pure apart from the injected store / clock / signer, so the
// service worker (extension/sw.js) and the unit tests run the same code. No chrome.* here.
//
// One pairing at a time, in three states: `pending` (paired, not yet clicked), `inflight` (the toolbar click
// spent the pairing and the passkey prompt is open) and `result` (signed or failed, waiting for the app to
// collect it once). Every read-modify-write of that state runs under one lock, so two messages or two clicks
// cannot both see the same pairing or the same result. The passkey prompt itself runs outside the lock; when
// it returns, its result is kept only if that same request is still the in-flight one (not cancelled, not
// replaced by a newer pairing, not expired).
import { BridgeError, checkAssertionBinding, isSignPage, PAIR_TTL_MS, parseRequest, pairingCode, RESULT_TTL_MS, RP_ORIGIN, senderAllowed, SIGN_PATH } from './protocol.js';

/** How long a click may keep a request in flight (the in-page prompt times out after 2 minutes). */
export const INFLIGHT_TTL_MS = 3 * 60_000;

/**
 * @typedef {{ get(keys: string[]): Promise<Record<string, any>>, set(items: Record<string, any>): Promise<void> }} Store
 * @typedef {{ requestId: string, kind: 'proof' | 'userop', challenge: string, code: string, created: number }} Pending
 * @typedef {{ ok: boolean, json?: string, error?: string } | null | undefined} SignOutcome
 */

/**
 * @param {{ store: Store, now?: () => number, notify?: (badge: string, title: string) => Promise<void> | void }} deps
 */
export function createBridge({ store, now = Date.now, notify = () => {} }) {
  let chain = Promise.resolve();
  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  const locked = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };

  async function load() {
    const { pending = null, inflight = null, result = null } = await store.get(['pending', 'inflight', 'result']);
    const t = now();
    return {
      /** @type {Pending | null} */ pending: pending && t - pending.created <= PAIR_TTL_MS ? pending : null,
      /** @type {{ requestId: string, since: number } | null} */ inflight: inflight && t - inflight.since <= INFLIGHT_TTL_MS ? inflight : null,
      result: result && t - result.at <= RESULT_TTL_MS ? result : null,
    };
  }

  /**
   * A message from the local app. Throws BridgeError for anything refused.
   * @param {unknown} msg
   * @param {{ origin?: string, url?: string, frameId?: number } | undefined} sender
   */
  function handle(msg, sender) {
    if (!senderAllowed(sender)) return Promise.reject(new BridgeError('only the local Passkey Recovery page may use this extension'));
    let req;
    try {
      req = parseRequest(msg);
    } catch (e) {
      return Promise.reject(e);
    }
    const r = req;
    return locked(async () => {
      const { pending, inflight, result } = await load();
      if (r.type === 'pair') {
        // A new pairing replaces any earlier pairing, any request still in flight and any uncollected result.
        const code = await pairingCode(r.requestId, r.challenge);
        await store.set({ pending: { requestId: r.requestId, kind: r.kind, challenge: r.challenge, code, created: now() }, inflight: null, result: null });
        await notify('1', `Passkey Recovery: request ${code} waiting — open ${RP_ORIGIN}${SIGN_PATH} and click here`);
        return { ok: true, code };
      }
      const mine = (/** @type {{ requestId: string } | null} */ x) => x?.requestId === r.requestId;
      if (r.type === 'cancel') {
        if (mine(pending) || mine(inflight) || mine(result)) {
          await store.set({ pending: null, inflight: null, result: null });
          await notify('', 'Passkey Recovery');
        }
        return { ok: true };
      }
      // result: handed over exactly once, then gone.
      if (mine(result)) {
        await store.set({ result: null });
        return result.error ? { ok: false, error: result.error } : { ok: true, assertion: result.assertion };
      }
      if (mine(pending) || mine(inflight)) return { ok: true, waiting: true };
      return { ok: false, error: 'no such request (expired, replaced, or already collected)' };
    });
  }

  /**
   * The toolbar click. `sign` runs the in-page passkey prompt for the spent pairing and resolves with its
   * outcome; it is called at most once per pairing.
   * @param {string | undefined} url the clicked tab's URL
   * @param {(p: Pending) => Promise<SignOutcome>} sign
   * @returns {Promise<'wrong-page' | 'nothing' | 'stored' | 'dropped'>}
   */
  async function click(url, sign) {
    if (!isSignPage(url)) {
      await notify('!', `Passkey Recovery: open ${RP_ORIGIN}${SIGN_PATH} first, then click here`);
      return 'wrong-page';
    }
    const p = await locked(async () => {
      const { pending } = await load();
      if (!pending) return null;
      // One-time: this pairing is spent whatever happens next.
      await store.set({ pending: null, inflight: { requestId: pending.requestId, since: now() } });
      return pending;
    });
    if (!p) {
      await notify('', 'Passkey Recovery: nothing to sign — start from your local Passkey Recovery page');
      return 'nothing';
    }
    /** @type {{ assertion?: string, error?: string }} */
    let out;
    try {
      const r = await sign(p);
      if (!r || !r.ok || typeof r.json !== 'string') out = { error: (r && r.error) || 'nothing came back from keys.coinbase.com' };
      else {
        checkAssertionBinding(r.json, p);
        out = { assertion: r.json };
      }
    } catch (e) {
      out = { error: e instanceof BridgeError ? e.message : 'could not run on this page' };
    }
    const kept = await locked(async () => {
      const { inflight } = await load();
      if (inflight?.requestId !== p.requestId) return false; // cancelled, replaced or expired meanwhile
      await store.set({ inflight: null, result: { requestId: p.requestId, at: now(), ...out } });
      return true;
    });
    if (!kept) {
      await notify('', 'Passkey Recovery: that request was cancelled or replaced; nothing was kept');
      return 'dropped';
    }
    await notify(out.error ? '!' : '✓', out.error ? `Passkey Recovery: ${out.error}` : 'Passkey Recovery: signed — return to your local page');
    return 'stored';
  }

  return { handle, click };
}
