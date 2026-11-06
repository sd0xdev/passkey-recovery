// The v1 helper template exactly as shipped before the copy()-lifetime fix (SYNTHETIC use only). It
// looked `copy` up by name after `await navigator.credentials.get`; real Chrome then throws
// "ReferenceError: copy is not defined". Kept so the regression tests prove the old shape fails.
import { SUPPORTED } from '../../src/config/registry';
const { id: RP_ID, origin: RP_ORIGIN } = SUPPORTED[0]!.rp;
import { bytesToBase64url } from '../../src/crypto/bytes';

export function legacyHelperSourceV1(challenge: Uint8Array, kind: 'proof' | 'userop'): string {
  const c = bytesToBase64url(challenge);
  return `(async () => {
  if (location.origin !== "${RP_ORIGIN}") throw new Error("Run only on ${RP_ORIGIN}");
  if (typeof copy !== "function") throw new Error("DevTools copy() unavailable; stop here");
  const d = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (x) => x.charCodeAt(0));
  const e = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const k = await navigator.credentials.get({ publicKey: { challenge: d("${c}"), rpId: "${RP_ID}", userVerification: "required", timeout: 120000 } });
  const r = k.response;
  copy(JSON.stringify({ format: "cbpr-assertion-v1", kind: "${kind}", rpId: "${RP_ID}", origin: location.origin, credentialId: e(k.rawId), authenticatorData: e(r.authenticatorData), clientDataJSON: e(r.clientDataJSON), signature: e(r.signature), userHandle: r.userHandle ? e(r.userHandle) : null }));
  return "cbpr: assertion copied to clipboard (not printed)";
})()`;
}
