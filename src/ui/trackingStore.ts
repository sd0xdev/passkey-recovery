// Tracking records kept across a refresh (M4): the ONLY module in src/ that touches Web Storage (source
// scan enforces this). A record is what the sidecar's stateless tracker needs to find a sent transfer
// again — public chain data only. It never holds a signature, an assertion, a signed UserOp or an RPC
// URL: writes and reads both pass the same allowlist, and anything else in storage is dropped. No full
// personal address is kept either (architecture §6.3): the sender, recipient and gas wallet are stored as
// digests plus short forms; a record written before that rule is migrated on read and rewritten at once.
import { getAddress, type Address, type Hex } from 'viem';
import { addressDigest, addressShort } from '../transfer/intent';

const KEY = 'cbpr.tracking.v1';
const MAX = 20;

export interface TrackingRecord {
  format: 'cbpr-track-v1';
  chainId: number;
  deploymentId: string;
  entryPoint: Address;
  userOpHash: Hex;
  senderHash: Hex;
  senderShort: string;
  nonce: string;
  intent: { chainId: number; deploymentId: string; recipientHash: Hex; recipientShort: string; asset: 'native' | Address; amount: string };
  gasWalletHash: Hex;
  gasWalletNonce: string | null;
  inputHash: Hex | null;
  txHash: Hex | null;
  fromBlock: string;
}

export interface StoredTrack {
  record: TrackingRecord;
  symbol: string;
  decimals: number;
  savedAt: number;
  /** The user gave up on an unknown send; it is still tracked in case it went out. */
  abandoned: boolean;
  /** Where the next event scan starts (so a refresh does not rescan the whole history); null = fromBlock. */
  scanCursor: string | null;
}

const H32 = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const UINT = /^(0|[1-9][0-9]{0,77})$/;

const addr = (v: unknown): Address => {
  if (typeof v !== 'string' || !ADDR.test(v)) throw new Error('address');
  return getAddress(v.toLowerCase());
};
const h32 = (v: unknown): Hex => {
  if (typeof v !== 'string' || !H32.test(v)) throw new Error('hash');
  return v.toLowerCase() as Hex;
};
const uint = (v: unknown): string => {
  if (typeof v !== 'string' || !UINT.test(v)) throw new Error('uint');
  return v;
};
const str = (v: unknown, max = 64): string => {
  if (typeof v !== 'string' || !v || v.length > max || !/^[\w.@-]+$/.test(v)) throw new Error('string');
  return v;
};
const SHORT = /^0x[0-9a-fA-F]{6}…[0-9a-fA-F]{6}$/;
const short = (v: unknown): string => {
  if (typeof v !== 'string' || !SHORT.test(v)) throw new Error('short');
  return v;
};
/** An address as stored: digest + short form. A legacy full address is migrated, never kept. */
const digestOf = (full: unknown, hash: unknown, shortForm: unknown) =>
  hash === undefined && full !== undefined ? { hash: addressDigest(addr(full)), short: addressShort(addr(full)) } : { hash: h32(hash), short: short(shortForm) };
const int = (v: unknown, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) throw new Error('int');
  return v;
};

/** Rebuilds a record from the allowlisted fields only; throws on anything malformed. */
export function cleanRecord(raw: unknown): TrackingRecord {
  if (typeof raw !== 'object' || raw === null) throw new Error('record');
  const r = raw as Record<string, unknown>;
  const i = r.intent as Record<string, unknown> | null;
  if (r.format !== 'cbpr-track-v1' || typeof i !== 'object' || i === null) throw new Error('format');
  const sender = digestOf(r.sender, r.senderHash, r.senderShort);
  const recipient = digestOf(i.recipient, i.recipientHash, i.recipientShort);
  return {
    format: 'cbpr-track-v1',
    chainId: int(r.chainId, 2 ** 40),
    deploymentId: str(r.deploymentId),
    entryPoint: addr(r.entryPoint),
    userOpHash: h32(r.userOpHash),
    senderHash: sender.hash,
    senderShort: sender.short,
    nonce: uint(r.nonce),
    intent: { chainId: int(i.chainId, 2 ** 40), deploymentId: str(i.deploymentId), recipientHash: recipient.hash, recipientShort: recipient.short, asset: i.asset === 'native' ? 'native' : addr(i.asset), amount: uint(i.amount) },
    gasWalletHash: r.gasWalletHash === undefined && r.gasWallet !== undefined ? addressDigest(addr(r.gasWallet)) : h32(r.gasWalletHash),
    gasWalletNonce: r.gasWalletNonce === null ? null : uint(r.gasWalletNonce),
    inputHash: r.inputHash === null ? null : h32(r.inputHash),
    txHash: r.txHash === null ? null : h32(r.txHash),
    fromBlock: uint(r.fromBlock),
  };
}

function cleanStored(raw: unknown): StoredTrack {
  if (typeof raw !== 'object' || raw === null) throw new Error('entry');
  const s = raw as Record<string, unknown>;
  return { record: cleanRecord(s.record), symbol: str(s.symbol, 16), decimals: int(s.decimals, 36), savedAt: int(s.savedAt, 2 ** 53), abandoned: s.abandoned === true, scanCursor: s.scanCursor === undefined || s.scanCursor === null ? null : uint(s.scanCursor) };
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadTracks(): StoredTrack[] {
  const s = storage();
  const text = s?.getItem(KEY);
  if (!text) return [];
  try {
    const arr = JSON.parse(text) as unknown;
    if (!Array.isArray(arr)) return [];
    const out: StoredTrack[] = [];
    for (const x of arr) {
      try {
        out.push(cleanStored(x));
      } catch {
        // A malformed or foreign entry is dropped, never repaired.
      }
    }
    const list = out.slice(0, MAX);
    // Whatever was stored differently from its clean form (a legacy full recipient, a foreign field) is
    // rewritten now, so it does not linger at rest until the next put.
    const clean = JSON.stringify(list);
    if (clean !== text) save(list);
    return list;
  } catch {
    return [];
  }
}

function save(list: StoredTrack[]): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(list.slice(0, MAX).map(cleanStored)));
  } catch {
    // Quota or a blocked store: callers that need the write check it with isStored().
  }
}

/**
 * Adds or replaces a record; newest first. One record per UserOperation: the record stored before the
 * wallet is asked (no tx hash yet) is replaced when the hash arrives — a UserOperation is never resent,
 * so a second outer transaction for the same userOpHash is not a separate transfer.
 */
export function putTrack(t: StoredTrack): StoredTrack[] {
  const clean = cleanStored(t);
  // A full list is never trimmed to make room: the oldest record may be a transfer whose outcome is still
  // open (and the gate for the next intent). The new record is simply not kept — the caller sees that via
  // isStored() and does not ask the wallet; the user removes settled rows in Track first.
  if (trackListFull(clean.record.userOpHash)) return loadTracks();
  const list = [clean, ...loadTracks().filter((x) => x.record.userOpHash !== clean.record.userOpHash)];
  save(list);
  return loadTracks();
}

/** True when a record for a new UserOperation cannot be added without dropping an existing one. */
export function trackListFull(userOpHash: Hex): boolean {
  const list = loadTracks();
  return list.length >= MAX && !list.some((x) => x.record.userOpHash === userOpHash.toLowerCase());
}

/** True only when this exact record reads back from storage (a send may go ahead only after this). */
export function isStored(t: StoredTrack, list: StoredTrack[] = loadTracks()): boolean {
  const want = JSON.stringify(cleanStored(t).record);
  return list.some((x) => JSON.stringify(x.record) === want);
}

/** Saves where the next event scan starts, in place (no reordering). */
export function setScanCursor(userOpHash: Hex, txHash: Hex | null, cursor: string | null): void {
  const list = loadTracks();
  const hit = list.find((x) => x.record.userOpHash === userOpHash.toLowerCase() && x.record.txHash === (txHash?.toLowerCase() ?? null));
  if (!hit || hit.scanCursor === cursor) return;
  hit.scanCursor = cursor;
  save(list);
}

/**
 * Removes exactly this record and only while it is still the pre-send record (no tx hash): used when the
 * wallet refused or was never asked, so a refused send does not hold one of the list's places for good.
 * A record that has since gained a hash, or was replaced, is left alone.
 */
export function removeTrackIf(own: StoredTrack): StoredTrack[] {
  const want = JSON.stringify(cleanStored(own).record);
  if (cleanStored(own).record.txHash !== null) return loadTracks();
  save(loadTracks().filter((x) => JSON.stringify(x.record) !== want));
  return loadTracks();
}

export function removeTrack(userOpHash: Hex, txHash: Hex | null): StoredTrack[] {
  save(loadTracks().filter((x) => !(x.record.userOpHash === userOpHash.toLowerCase() && x.record.txHash === (txHash?.toLowerCase() ?? null))));
  return loadTracks();
}

// ---- Deployment sends (tech spec §3.4) ----------------------------------------------------------------
// One record per wallet being deployed, written BEFORE the wallet is asked and updated when the hash
// arrives, so a reload while a step is in flight resumes tracking that step instead of offering it again.
// Addresses are stored only as digests: the page matches them against the account it is checking and the
// connected gas wallet. Cleared when the step is verified, the wallet refused, or the user re-plans.
const DEPLOY_KEY = 'cbpr.deploy.v1';

export interface DeployRecord {
  format: 'cbpr-deploy-v1';
  chainId: number;
  deploymentId: string;
  accountHash: Hex;
  gasWalletHash: Hex;
  key: string;
  txHash: Hex | null;
  savedAt: number;
}

export function cleanDeploy(raw: unknown): DeployRecord {
  if (typeof raw !== 'object' || raw === null) throw new Error('record');
  const r = raw as Record<string, unknown>;
  if (r.format !== 'cbpr-deploy-v1') throw new Error('format');
  return {
    format: 'cbpr-deploy-v1',
    chainId: int(r.chainId, 2 ** 40),
    deploymentId: str(r.deploymentId),
    accountHash: h32(r.accountHash),
    gasWalletHash: h32(r.gasWalletHash),
    key: str(r.key, 32),
    txHash: r.txHash === null ? null : h32(r.txHash),
    savedAt: int(r.savedAt, 2 ** 53),
  };
}

function loadDeploys(): DeployRecord[] {
  try {
    const arr = JSON.parse(storage()?.getItem(DEPLOY_KEY) ?? '[]') as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.flatMap((x) => {
      try {
        return [cleanDeploy(x)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

const sameWallet = (r: DeployRecord, chainId: number, deploymentId: string, accountHash: Hex) => r.chainId === chainId && r.deploymentId === deploymentId && r.accountHash === accountHash.toLowerCase();

/** The in-flight deployment send for this account, if any. */
export function getDeploy(chainId: number, deploymentId: string, accountHash: Hex): DeployRecord | null {
  return loadDeploys().find((r) => sameWallet(r, chainId, deploymentId, accountHash)) ?? null;
}

/** Stores (or replaces) the one in-flight deployment send for its account; true only if it reads back. */
export function putDeploy(rec: DeployRecord): boolean {
  const clean = cleanDeploy(rec);
  const rest = loadDeploys().filter((r) => !sameWallet(r, clean.chainId, clean.deploymentId, clean.accountHash));
  try {
    storage()?.setItem(DEPLOY_KEY, JSON.stringify([clean, ...rest].slice(0, MAX)));
  } catch {
    return false; // quota or a blocked store: report it, never pretend it was kept
  }
  return JSON.stringify(getDeploy(clean.chainId, clean.deploymentId, clean.accountHash)) === JSON.stringify(clean);
}

/**
 * Forgets `own` only while it is still the stored record: a later attempt for the same account (which
 * replaced it) keeps its record when an older attempt is cancelled or answered late.
 */
export function clearDeployIf(own: DeployRecord): void {
  const cur = getDeploy(own.chainId, own.deploymentId, own.accountHash);
  if (cur && JSON.stringify(cur) === JSON.stringify(cleanDeploy(own))) clearDeploy(own.chainId, own.deploymentId, own.accountHash);
}

/** Forgets this account's in-flight send; the key itself goes when nothing is in flight. */
export function clearDeploy(chainId: number, deploymentId: string, accountHash: Hex): void {
  const rest = loadDeploys().filter((r) => !sameWallet(r, chainId, deploymentId, accountHash));
  if (rest.length) storage()?.setItem(DEPLOY_KEY, JSON.stringify(rest));
  else storage()?.removeItem(DEPLOY_KEY);
}
