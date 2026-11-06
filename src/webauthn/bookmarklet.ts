// The no-extension Passkey path (ADR-004): one static bookmarklet the user saves once, then clicks on
// https://keys.coinbase.com (the Passkey page). Unlike the DevTools helper it is the same code for every request — so its
// SHA-256 can be checked once — and what the user pastes on the Coinbase page is a request CODE (data:
// kind + 32-byte challenge), never code. It calls navigator.credentials.get only; no network, storage or
// cookies (keys.coinbase.com's CSP connect-src blocks loopback anyway, spike S1). The assertion goes to the
// clipboard; if the browser refuses clipboard access it is shown once in a prompt for the user to copy.
// It is never logged, and nothing is kept in the page after it returns.
import { sha256 } from '@noble/hashes/sha2.js';
import { SUPPORTED } from '../config/registry';
import { base64urlToBytes, bytesToBase64url, bytesToHex, utf8 } from '../crypto/bytes';
import type { AssertionKind } from './assertion';

const { id: RP_ID, origin: RP_ORIGIN } = SUPPORTED[0]!.rp;
export const BOOKMARKLET_VERSION = 'cbpr-bookmarklet-v1';
const CODE = /^cbpr1:(proof|userop):([A-Za-z0-9_-]{43})$/;

/** What the user copies from this page and pastes into the bookmarklet's prompt on keys.coinbase.com. */
export function requestCode(challenge: Uint8Array, kind: AssertionKind): string {
  if (challenge.length !== 32) throw new Error('challenge must be 32 bytes');
  return `cbpr1:${kind}:${bytesToBase64url(challenge)}`;
}

/** The inverse, for tests and for the page to re-check what it shows. */
export function parseRequestCode(code: string): { kind: AssertionKind; challenge: Uint8Array } | null {
  const m = CODE.exec(code.trim());
  if (!m) return null;
  try {
    const challenge = base64urlToBytes(m[2]!);
    return challenge.length === 32 ? { kind: m[1] as AssertionKind, challenge } : null;
  } catch {
    return null;
  }
}

export const BOOKMARKLET_SOURCE = `(async()=>{const T="Passkey Recovery (${BOOKMARKLET_VERSION})";try{
if(location.origin!=="${RP_ORIGIN}"){alert(T+": open ${RP_ORIGIN} first, then click this bookmark there.");return;}
const q=prompt(T+"\\nPaste the request code from the Passkey Recovery page:");if(q===null)return;
const m=/^cbpr1:(proof|userop):([A-Za-z0-9_-]{43})$/.exec(q.trim());if(!m){alert(T+": that is not a request code. Copy it again from the Passkey Recovery page.");return;}
const d=(s)=>Uint8Array.from(atob(s.replace(/-/g,"+").replace(/_/g,"/")+"===".slice((s.length+3)%4)),(x)=>x.charCodeAt(0));
const e=(b)=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"");
const c=d(m[2]);if(c.length!==32){alert(T+": damaged request code.");return;}
const k=await navigator.credentials.get({publicKey:{challenge:c,rpId:"${RP_ID}",userVerification:"required",timeout:120000}});const r=k.response;
const o=JSON.stringify({format:"cbpr-assertion-v1",kind:m[1],rpId:"${RP_ID}",origin:location.origin,credentialId:e(k.rawId),authenticatorData:e(r.authenticatorData),clientDataJSON:e(r.clientDataJSON),signature:e(r.signature),userHandle:r.userHandle?e(r.userHandle):null});
let ok=false;try{await navigator.clipboard.writeText(o);ok=true;}catch(x){}
if(ok)alert(T+": signed. The result is on your clipboard - paste it into the Passkey Recovery page.");
else prompt(T+": signed. Copy this result and paste it into the Passkey Recovery page:",o);
}catch(x){alert(T+": "+(x&&x.name?x.name:"error")+" - nothing was signed.");}})();void 0`;

/** The bookmark's URL. Every character outside a conservative set is percent-encoded. */
export const BOOKMARKLET_URL = `javascript:${encodeURIComponent(BOOKMARKLET_SOURCE.replace(/\n/g, ''))}`;
export const BOOKMARKLET_SHA256 = bytesToHex(sha256(utf8(BOOKMARKLET_URL))).slice(2);
