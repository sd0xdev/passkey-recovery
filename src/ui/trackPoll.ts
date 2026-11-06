// When a Track row may stop asking the chain (tech spec §3.7). Only an answer that can no longer change
// ends the polling: `final`; an inner failure buried at the finality depth (the op ran, its nonce is
// used); or an outer revert at that depth once the account's nonce has moved past the op's — before
// that, the same signed op can still be executed by another transaction — and the nonce must have moved at
// the finality depth too, since a nonce used only in shallow blocks can be reorged back. A shallower failure can still
// be reorged away, so it keeps being tracked. A revert also waits for the event search past it to be
// complete: an unfinished scan may still find the same op executed by another transaction.
import type { TrackResult } from './types';

export function trackSettled(r: Pick<TrackResult, 'state' | 'confirmations' | 'finalityDepth' | 'nonceFinal' | 'scan'>, opNonce: string): boolean {
  if (r.state === 'final') return true;
  // Superseded: no event for this op in a complete scan, and another operation used its nonce at the
  // finality depth — it can never execute; the row may stop and be removed.
  if (r.state === 'unknown') return r.scan !== null && r.scan.complete && r.nonceFinal !== null && BigInt(r.nonceFinal) > BigInt(opNonce);
  if (r.state !== 'reverted' && r.state !== 'inner-failed') return false;
  const deep = r.confirmations !== null && BigInt(r.confirmations) >= BigInt(r.finalityDepth);
  if (r.state === 'inner-failed') return deep;
  return deep && r.nonceFinal !== null && BigInt(r.nonceFinal) > BigInt(opNonce) && r.scan !== null && r.scan.complete;
}

/**
 * Whether a new transfer intent may open next to this earlier record (architecture §5, "before a new
 * intent"): `same-nonce` — the account's nonce is still the op's, so a new op takes the same nonce and at
 * most one of the two executes; `executed` — the op's UserOperationEvent was found (show its result; only
 * an explicit separate transfer, never a "retry"); `nonce-used` — the nonce moved on and a complete scan
 * found no event, so the old op can never execute; `unknown` — no answer yet, the nonce is unreadable, or
 * the nonce moved on while the scan is incomplete: the old op's fate is not known and nothing new opens.
 */
export type IntentGate = 'same-nonce' | 'executed' | 'nonce-used' | 'unknown';

export function newIntentGate(r: Pick<TrackResult, 'state' | 'nonceNow' | 'scan'> | undefined, opNonce: string): IntentGate {
  if (!r) return 'unknown';
  if (r.state === 'confirmed' || r.state === 'final' || r.state === 'inner-failed') return 'executed';
  if (r.nonceNow === null) return 'unknown';
  const now = BigInt(r.nonceNow);
  const op = BigInt(opNonce);
  if (now === op) return 'same-nonce';
  if (now > op && r.scan !== null && r.scan.complete) return 'nonce-used';
  return 'unknown';
}

/**
 * Whether a plan's nonce agrees with every earlier record's gate: next to a `same-nonce` record the new op
 * must take that very nonce (else the earlier op already moved it and the gate is stale); next to an
 * `executed` or `nonce-used` record it must be past the record's nonce; an `unknown` record agrees with
 * nothing. A disagreement means the picture the gate was decided on is out of date.
 */
export function nonceAgrees(planNonce: string, earlier: ReadonlyArray<readonly [IntentGate, string]>): boolean {
  const n = BigInt(planNonce);
  return earlier.every(([g, op]) => (g === 'same-nonce' ? n === BigInt(op) : g === 'unknown' ? false : n > BigInt(op)));
}

/**
 * Whether the earlier records' gates differ from the ones a plan was built on only by some of them having
 * become unreadable (`unknown`: the runner or the chain not answering, so a Track answer was dropped). That is
 * not a change in what is known about them — the plan is held, not voided, until they read again; a gate that
 * moved to another verified state, or a record gone or added, is a real change.
 */
export function gatesOnlyUnreadable(then: ReadonlyArray<readonly [string, IntentGate]>, now: ReadonlyArray<readonly [string, IntentGate]>): boolean {
  if (then.length !== now.length) return false;
  const was = new Map(then);
  return now.every(([h, g]) => was.has(h) && (g === was.get(h) || g === 'unknown'));
}

/** The note each gate shows next to an earlier transfer; the same-nonce assurance only when it is verified. */
export const GATE_NOTE = {
  'same-nonce': 'abandoned.sameNonce',
  executed: 'abandoned.alreadyRan',
  'nonce-used': 'abandoned.nonceUsed',
  unknown: 'abandoned.waiting',
} as const;

// UserOperations this page is handing to the wallet (or the runner's signer) right now. Their record is
// saved before the request goes out, so a Track poll may already read "unknown" with no hash: that is the
// send still under way, not something the user must act on. Memory only: a reload forgets it.
const sending = new Map<string, number>();

/** Marks a send of this UserOperation as under way; the returned function ends it (once). */
export function beginSending(userOpHash: string): () => void {
  const h = userOpHash.toLowerCase();
  sending.set(h, (sending.get(h) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const n = (sending.get(h) ?? 1) - 1;
    if (n > 0) sending.set(h, n);
    else sending.delete(h);
  };
}

/** True while a send of this UserOperation started by this page has not been answered yet. */
export function isSending(userOpHash: string): boolean {
  return sending.has(userOpHash.toLowerCase());
}

/**
 * Whether a new Track answer changes nothing a gate, the report or the balance read again (PM-06) reads. The
 * block counts: a shallow reorg can move the same transaction to a later block with the same state and depth.
 */
export function sameTrackAnswer(o: TrackResult, r: TrackResult): boolean {
  return o.state === r.state && o.block === r.block && o.confirmations === r.confirmations && o.nonceNow === r.nonceNow && o.nonceFinal === r.nonceFinal && o.scan?.complete === r.scan?.complete && o.detail === r.detail;
}
