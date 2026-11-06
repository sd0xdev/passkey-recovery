// Verifies a proof-of-control assertion against the owner the user chose: the public key read from
// the chain at session.subject.ownerIndex (passed in by the caller; never a built-in key).
import type { Hex } from 'viem';
import { hexToBytes } from '../crypto/bytes';
import { AssertionFormatError, parseAssertionJson } from '../webauthn/assertion';
import { verifyAssertion, type Check } from '../webauthn/verify';
import type { ProofSession } from './challenge';

export type ProofStatus = 'valid' | 'expired' | 'mismatch' | 'format-error';

export type ProofCheck = Check | { id: 'owner-index' | 'owner-kind'; ok: boolean; detail: string };

export interface ProofOutcome {
  status: ProofStatus;
  checks: ProofCheck[];
  expiry: { ok: boolean; detail: string };
}

/** The on-chain owner at the session's ownerIndex: a 64-byte P-256 key (x ‖ y). */
export interface ProofOwner {
  index: number;
  publicKey: Hex;
}

export function verifyProof(session: ProofSession, assertionJson: string, owner: ProofOwner, now: Date = new Date()): ProofOutcome {
  const t = now.getTime();
  const inWindow = t >= session.issuedAt.getTime() && t <= session.expiresAt.getTime();
  const expiry = {
    ok: inWindow,
    detail: inWindow
      ? `within ${session.issuedAt.toISOString()} – ${session.expiresAt.toISOString()}`
      : `outside ${session.issuedAt.toISOString()} – ${session.expiresAt.toISOString()} (now ${now.toISOString()})`,
  };
  if (owner.index !== session.subject.ownerIndex) {
    return { status: 'mismatch', checks: [{ id: 'owner-index', ok: false, detail: `the statement names owner ${session.subject.ownerIndex}, the key given is owner ${owner.index}` }], expiry };
  }
  const key = hexToBytes(owner.publicKey);
  if (key.length !== 64) return { status: 'mismatch', checks: [{ id: 'owner-kind', ok: false, detail: `owner ${owner.index} is not a Passkey (P-256) owner` }], expiry };

  let parsed;
  try {
    parsed = parseAssertionJson(assertionJson, 'proof');
  } catch (e) {
    const detail = e instanceof AssertionFormatError ? e.message : 'unreadable input';
    return { status: 'format-error', checks: [{ id: 'format', ok: false, detail }], expiry };
  }

  const r = verifyAssertion(parsed, {
    expectedChallenge: session.challenge,
    publicKeyXY: key,
    rpId: session.subject.rpId,
    origin: session.subject.origin,
    requireUV: true,
    ownerIndex: owner.index,
  });
  const status: ProofStatus = !r.formatOk ? 'format-error' : !r.allOk ? 'mismatch' : !inWindow ? 'expired' : 'valid';
  return { status, checks: r.checks, expiry };
}
