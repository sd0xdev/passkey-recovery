// The balances Move offers come from Check's diagnosis; after a transfer of this wallet lands, or when a new
// transfer starts, they are read again (PM-06, design 6-recovery-atlas §10.7). Pure decisions only: Tool owns
// the request and applies an answer only when `answerApplies` says it is still the one asked for.
import type { StoredTrack } from './trackingStore';
import type { TrackResult } from './types';

/** `fresh`: the read on screen is current; `reading`: a read again is in flight; `failed`: it did not answer. */
export type BalanceState = 'fresh' | 'reading' | 'failed';

export interface BalanceRead {
  state: BalanceState;
  /** Why the last read again failed (shown with a retry); null otherwise. */
  error: string | null;
}

/** States in which the op is in a block: success or failure, the account's nonce (and maybe its balances) moved. */
const INCLUDED: ReadonlySet<TrackResult['state']> = new Set(['confirmed', 'final', 'inner-failed', 'reverted']);

/**
 * Records of this account (by sender digest) whose latest answer puts the op in a block later than the block the
 * balances on screen were read at, and whose landing in that block has not triggered a read yet (`seen` holds
 * `record@block`): each one asks for one read. The same op turning up in another block (a shallow reorg) asks again.
 * A block holding one of them reported replaced (`reorged`, key `record@reorged:block`) asks for one read too,
 * whatever the read's block: balances read on the replaced chain are not the canonical ones.
 */
export function landedAfter(tracks: ReadonlyArray<StoredTrack>, results: Readonly<Record<string, TrackResult>>, senderHash: string | null, readAt: string | null, seen: ReadonlySet<string>): string[] {
  if (!senderHash || readAt === null) return [];
  const at = BigInt(readAt);
  const out: string[] = [];
  for (const s of tracks) {
    if (s.record.senderHash !== senderHash) continue;
    const key = `${s.record.userOpHash}:${s.record.txHash ?? ''}`;
    const r = results[key];
    if (!r || r.block === null) continue;
    if (r.state === 'reorged') {
      const replaced = `${key}@reorged:${r.block}`;
      if (!seen.has(replaced)) out.push(replaced);
      continue;
    }
    if (!INCLUDED.has(r.state)) continue;
    const landed = `${key}@${r.block}`;
    if (!seen.has(landed) && BigInt(r.block) > at) out.push(landed);
  }
  return out;
}

/**
 * The latest block holding an op of this account (by sender digest): a read again older than it may predate the
 * account's last transfer, so it is not taken as the latest balances. Null when no op of it is in a block.
 */
export function coverBlock(tracks: ReadonlyArray<StoredTrack>, results: Readonly<Record<string, TrackResult>>, senderHash: string | null): string | null {
  if (!senderHash) return null;
  let top: bigint | null = null;
  for (const s of tracks) {
    if (s.record.senderHash !== senderHash) continue;
    const r = results[`${s.record.userOpHash}:${s.record.txHash ?? ''}`];
    if (!r || !INCLUDED.has(r.state) || r.block === null) continue;
    const b = BigInt(r.block);
    if (top === null || b > top) top = b;
  }
  return top === null ? null : top.toString();
}

/**
 * What Move is shown: a "fresh" read that is older than the latest block holding an op of this account is not the
 * latest balances, whichever answer came last (a Check or a read again in flight while Track saw the op land).
 * Derived on every render, so no order of answers can leave it marked fresh.
 */
export function shownBalanceRead(read: BalanceRead, readAt: string | null, cover: string | null, behind: (got: string, need: string) => string): BalanceRead {
  if (read.state !== 'fresh' || readAt === null || cover === null || BigInt(readAt) >= BigInt(cover)) return read;
  return { state: 'failed', error: behind(readAt, cover) };
}

/** What a read again was asked for; it is applied only if all of it is still what the page shows. */
export interface BalanceAsk {
  seq: number;
  epoch: number | null;
  conn: number;
  account: string;
}

export function answerApplies(asked: BalanceAsk, now: BalanceAsk): boolean {
  return asked.seq === now.seq && asked.epoch === now.epoch && asked.conn === now.conn && asked.account.toLowerCase() === now.account.toLowerCase();
}

/**
 * The amount typed is more than the fresh balance: Review is blocked. Unparseable or empty amounts are not "over"
 * (the form's own checks and the runner's preview answer for them).
 */
export function overBalance(amount: string, decimals: number, balance: bigint | null): boolean {
  if (balance === null) return false;
  const m = /^(\d+)(?:\.(\d*))?$/.exec(amount.trim());
  if (!m) return false;
  const frac = m[2] ?? '';
  if (frac.length > decimals) return false;
  const units = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  return units > balance;
}
