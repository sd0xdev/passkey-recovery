// Passkey Recovery bridge — service worker (ADR-002). Permissions: activeTab, scripting, storage; no host
// permissions, no nativeMessaging. State lives in chrome.storage.session (memory only, cleared when the browser
// closes, unreadable from page or content scripts). Nothing here logs: a challenge or assertion is never
// written to the console, to disk, or anywhere a page can read it. The state machine is extension/bridge.js.
import { createBridge } from './bridge.js';
import { BridgeError, hexToBase64url, RP_ID, RP_ORIGIN, SIGN_PATH } from './protocol.js';

const bridge = createBridge({
  store: chrome.storage.session,
  notify: async (text, title) => {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setTitle({ title });
  },
});

// ---- the local app ------------------------------------------------------------------------------------------
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  bridge.handle(msg, sender).then(reply, (e) => reply({ ok: false, error: e instanceof BridgeError ? e.message : 'bridge error' }));
  return true;
});

// ---- the toolbar click on keys.coinbase.com -----------------------------------------------------------------
/** Runs in the ISOLATED world of the top frame of https://keys.coinbase.com/connect: page scripts cannot patch it. */
function signInPage(challengeB64u, kind, code, rpId, rpOrigin, signPath) {
  if (location.origin !== rpOrigin || location.pathname !== signPath || window.top !== window) return { ok: false, error: 'not the keys.coinbase.com sign-in page' };
  const ask = `Passkey Recovery by sd0x\n\nSign request ${code} with your passkey?\n\nContinue only if your local Passkey Recovery page shows the same code.`;
  if (!window.confirm(ask)) return { ok: false, error: 'cancelled on keys.coinbase.com' };
  const e = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const challenge = Uint8Array.from(atob(challengeB64u.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((challengeB64u.length + 3) % 4)), (c) => c.charCodeAt(0));
  return navigator.credentials.get({ publicKey: { challenge, rpId, userVerification: 'required', timeout: 120000 } }).then(
    (k) => {
      const r = k.response;
      return { ok: true, json: JSON.stringify({ format: 'cbpr-assertion-v1', kind, rpId, origin: location.origin, credentialId: e(k.rawId), authenticatorData: e(r.authenticatorData), clientDataJSON: e(r.clientDataJSON), signature: e(r.signature), userHandle: r.userHandle ? e(r.userHandle) : null }) };
    },
    (err) => ({ ok: false, error: `the passkey did not sign (${String(err && err.name ? err.name : 'error')})` }),
  );
}

chrome.action.onClicked.addListener((tab) =>
  bridge.click(tab.url, async (pending) => {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: 'ISOLATED',
      func: signInPage,
      args: [hexToBase64url(pending.challenge), pending.kind, pending.code, RP_ID, RP_ORIGIN, SIGN_PATH],
    });
    return inj && inj.frameId === 0 ? inj.result : null;
  }),
);
