// Passkey Recovery bridge, protocol v1 (ADR-002). Pure functions shared by the extension service worker
// (extension/sw.js) and the unit tests; the page side is src/bridge/client.ts. No chrome.* here.
//
// Flow: the local app (exactly http://127.0.0.1:4173, top frame) sends one `pair` request carrying a 32-byte
// challenge; the extension answers with a short pairing code. The user opens https://keys.coinbase.com/connect,
// clicks the toolbar button, and confirms the same code there; the passkey signs that challenge on the real
// origin. The extension checks the assertion is bound to that challenge and origin, holds it in memory only,
// and hands it to the app exactly once.

export const BRIDGE_VERSION = 1;
export const APP_ORIGIN = 'http://127.0.0.1:4173';
export const RP_ID = 'keys.coinbase.com';
export const RP_ORIGIN = 'https://keys.coinbase.com';
export const SIGN_PATH = '/connect';
/** A pairing not used within this window is dropped. */
export const PAIR_TTL_MS = 5 * 60_000;
/** A signed result not collected by the app within this window is dropped. */
export const RESULT_TTL_MS = 2 * 60_000;
export const KINDS = /** @type {const} */ (['proof', 'userop']);

const HEX32 = /^0x[0-9a-f]{64}$/;
const REQUEST_ID = /^[0-9a-f]{32}$/;
const B64U = /^[A-Za-z0-9_-]+$/;
const ASSERTION_KEYS = ['format', 'kind', 'rpId', 'origin', 'credentialId', 'authenticatorData', 'clientDataJSON', 'signature', 'userHandle'];
const MAX_ASSERTION_CHARS = 16_384;

export class BridgeError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'BridgeError';
  }
}

/**
 * Only the local app's top frame may talk to the extension (externally_connectable narrows it to the same
 * origin; this re-checks it, the frame and the URL shape).
 * @param {{ origin?: string, url?: string, frameId?: number } | undefined} sender
 */
export function senderAllowed(sender) {
  if (!sender || sender.origin !== APP_ORIGIN) return false;
  if (sender.frameId !== undefined && sender.frameId !== 0) return false;
  try {
    return new URL(sender.url ?? '').origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Strict request parser: exact key set per type, nothing else accepted.
 * @param {unknown} msg
 * @returns {{ type: 'pair', requestId: string, kind: 'proof' | 'userop', challenge: string } | { type: 'result' | 'cancel', requestId: string }}
 */
export function parseRequest(msg) {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) throw new BridgeError('request must be an object');
  const m = /** @type {Record<string, unknown>} */ (msg);
  if (m.v !== BRIDGE_VERSION) throw new BridgeError(`unsupported protocol version (this extension speaks v${BRIDGE_VERSION})`);
  const keys = Object.keys(m).sort().join(',');
  if (typeof m.requestId !== 'string' || !REQUEST_ID.test(m.requestId)) throw new BridgeError('requestId must be 32 lowercase hex characters');
  if (m.type === 'pair') {
    if (keys !== 'challenge,kind,requestId,type,v') throw new BridgeError('pair: unexpected fields');
    if (typeof m.kind !== 'string' || !KINDS.includes(/** @type {any} */ (m.kind))) throw new BridgeError('pair: kind must be proof or userop');
    if (typeof m.challenge !== 'string' || !HEX32.test(m.challenge)) throw new BridgeError('pair: challenge must be 32 bytes of lowercase 0x-hex');
    return { type: 'pair', requestId: m.requestId, kind: /** @type {'proof' | 'userop'} */ (m.kind), challenge: m.challenge };
  }
  if (m.type === 'result' || m.type === 'cancel') {
    if (keys !== 'requestId,type,v') throw new BridgeError(`${m.type}: unexpected fields`);
    return { type: m.type, requestId: m.requestId };
  }
  throw new BridgeError('unknown request type');
}

const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'; // no 0/O, 1/I/L

/**
 * Pairing code shown on both sides: 8 characters from SHA-256 over the request id and challenge.
 * @param {string} requestId
 * @param {string} challenge
 */
export async function pairingCode(requestId, challenge) {
  const data = new TextEncoder().encode(`cbpr-bridge-v1|${requestId}|${challenge}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[h[i] % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/**
 * The toolbar click signs only on the exact sign-in page, in the top frame.
 * @param {string | undefined} url
 */
export function isSignPage(url) {
  try {
    const u = new URL(url ?? '');
    return u.origin === RP_ORIGIN && u.pathname === SIGN_PATH;
  } catch {
    return false;
  }
}

/** @param {string} hex 0x-prefixed */
export function hexToBase64url(hex) {
  let bin = '';
  for (let i = 2; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} s */
function base64urlToText(s) {
  if (!B64U.test(s)) throw new BridgeError('clientDataJSON is not base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/**
 * Before the extension keeps an assertion it checks it answers THIS pairing: format, kind, rpId, and in
 * clientDataJSON the type, the exact origin (no cross-origin / top-origin) and the challenge. Signature
 * validity against owner[0] is checked by the app, as for a pasted assertion.
 * @param {string} json cbpr-assertion-v1 text
 * @param {{ kind: string, challenge: string }} pending
 */
export function checkAssertionBinding(json, pending) {
  if (typeof json !== 'string' || json.length > MAX_ASSERTION_CHARS) throw new BridgeError('assertion missing or too large');
  /** @type {Record<string, unknown>} */
  let a;
  try {
    a = JSON.parse(json);
  } catch {
    throw new BridgeError('assertion is not JSON');
  }
  if (typeof a !== 'object' || a === null || Object.keys(a).sort().join(',') !== [...ASSERTION_KEYS].sort().join(',')) throw new BridgeError('assertion fields differ from cbpr-assertion-v1');
  if (a.format !== 'cbpr-assertion-v1' || a.kind !== pending.kind || a.rpId !== RP_ID || a.origin !== RP_ORIGIN) throw new BridgeError('assertion format, kind, rpId or origin is wrong');
  /** @type {Record<string, unknown>} */
  let cd;
  try {
    cd = JSON.parse(base64urlToText(String(a.clientDataJSON)));
  } catch {
    throw new BridgeError('clientDataJSON is not readable');
  }
  if (cd.type !== 'webauthn.get') throw new BridgeError('clientDataJSON.type is not webauthn.get');
  if (cd.origin !== RP_ORIGIN) throw new BridgeError('clientDataJSON.origin is not https://keys.coinbase.com');
  if (cd.crossOrigin === true || cd.topOrigin !== undefined) throw new BridgeError('the passkey was used from inside another site (cross-origin)');
  if (cd.challenge !== hexToBase64url(pending.challenge)) throw new BridgeError('the passkey signed a different challenge than the one paired');
  return true;
}
