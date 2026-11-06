// Generates the reviewable helper the user runs on https://keys.coinbase.com (tech spec §3.3).
// The helper only calls navigator.credentials.get; it has no network, storage or cookie access. The
// assertion is authorization data, so it is never logged: it goes to the clipboard through the
// DevTools console utility copy(), and the helper fails closed before signing if copy() is missing.
// Chrome only exposes the command-line utilities while the console's own synchronous evaluation runs,
// so after `await navigator.credentials.get` the name `copy` no longer resolves. The helper therefore
// takes its reference to copy() in the synchronous preflight and calls that reference after the await.
import { sha256 } from '@noble/hashes/sha2.js';
import { SUPPORTED } from '../config/registry';
const { id: RP_ID, origin: RP_ORIGIN } = SUPPORTED[0]!.rp;
import { bytesToBase64url, bytesToHex, utf8 } from '../crypto/bytes';
import type { AssertionKind } from './assertion';

/** Shown in the helper's return string so a stale pasted helper (v1, without the fix) is recognisable. */
export const HELPER_VERSION = 'cbpr-helper-v2';

export interface Helper {
  source: string;
  sha256Hex: string;
}

export function buildHelper(challenge: Uint8Array, kind: AssertionKind): Helper {
  if (challenge.length !== 32) throw new Error('challenge must be 32 bytes');
  const c = bytesToBase64url(challenge);
  const source = `(async () => {
  if (location.origin !== "${RP_ORIGIN}") throw new Error("Run only on ${RP_ORIGIN}");
  const cp = typeof copy === "function" ? copy : null; if (!cp) throw new Error("DevTools copy() unavailable; stop here");
  const d = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (x) => x.charCodeAt(0));
  const e = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const k = await navigator.credentials.get({ publicKey: { challenge: d("${c}"), rpId: "${RP_ID}", userVerification: "required", timeout: 120000 } });
  const r = k.response;
  cp(JSON.stringify({ format: "cbpr-assertion-v1", kind: "${kind}", rpId: "${RP_ID}", origin: location.origin, credentialId: e(k.rawId), authenticatorData: e(r.authenticatorData), clientDataJSON: e(r.clientDataJSON), signature: e(r.signature), userHandle: r.userHandle ? e(r.userHandle) : null }));
  return "${HELPER_VERSION}: assertion copied to clipboard (not printed)";
})()`;
  return { source, sha256Hex: bytesToHex(sha256(utf8(source))).slice(2) };
}
