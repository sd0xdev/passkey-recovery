// Tracking records survive a refresh, and only allowlisted public fields ever reach storage — on write
// and again on read (a tampered or foreign entry is dropped, never repaired).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { addressDigest, addressShort, recipientDigest, recipientShort } from '../../../src/transfer/intent';
import { cleanDeploy, cleanRecord, clearDeploy, clearDeployIf, getDeploy, isStored, trackListFull, loadTracks, putDeploy, putTrack, removeTrack, removeTrackIf, setScanCursor, type DeployRecord, type StoredTrack, type TrackingRecord } from '../../../src/ui/trackingStore';

class MemStorage {
  m = new Map<string, string>();
  getItem = (k: string) => this.m.get(k) ?? null;
  setItem = (k: string, v: string) => void this.m.set(k, v);
  removeItem = (k: string) => void this.m.delete(k);
}
let mem: MemStorage;
beforeEach(() => {
  mem = new MemStorage();
  (globalThis as { localStorage?: unknown }).localStorage = mem;
});
afterEach(() => delete (globalThis as { localStorage?: unknown }).localStorage);

const A = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as Address;
const R = '0x00000000000000000000000000000000000Ab1e5' as Address;
const G = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const record = (n: number, tx: Hex | null = null): TrackingRecord => ({
  format: 'cbpr-track-v1',
  chainId: 9745,
  deploymentId: 'coinbase-smart-wallet-v1.1-plasma',
  entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
  userOpHash: ('0x' + n.toString(16).padStart(64, '0')) as Hex,
  senderHash: addressDigest(A),
  senderShort: addressShort(A),
  nonce: String(n),
  intent: { chainId: 9745, deploymentId: 'coinbase-smart-wallet-v1.1-plasma', recipientHash: recipientDigest(R), recipientShort: recipientShort(R), asset: 'native', amount: '1000000000000000000' },
  gasWalletHash: addressDigest(G),
  gasWalletNonce: '4',
  inputHash: null,
  txHash: tx,
  fromBlock: '120',
});
const stored = (n: number, tx: Hex | null = null): StoredTrack => ({ record: record(n, tx), symbol: 'XPL', decimals: 18, savedAt: 1_700_000_000_000 + n, abandoned: false, scanCursor: null });

describe('trackingStore', () => {
  it('put → load round-trips newest first; one key only', () => {
    putTrack(stored(1));
    const list = putTrack(stored(2));
    expect(list.map((s) => s.record.nonce)).toEqual(['2', '1']);
    expect([...mem.m.keys()]).toEqual(['cbpr.tracking.v1']);
  });

  it('signature / assertion / signed op / RPC fields on input are not written', () => {
    const dirty = { ...stored(3), signature: '0xdead', assertion: '{"format":"cbpr-assertion-v1"}', record: { ...record(3), signature: '0xbeef', op: { signature: '0x01' }, rpcUrl: 'http://127.0.0.1:1/x' } } as unknown as StoredTrack;
    putTrack(dirty);
    const raw = mem.m.get('cbpr.tracking.v1')!;
    for (const word of ['signature', 'assertion', 'rpcUrl', '0xdead', '0xbeef', '127.0.0.1']) expect(raw).not.toContain(word);
    expect(loadTracks()[0]!.record.nonce).toBe('3');
  });

  it('a tampered entry in storage is dropped on read; the valid neighbour stays', () => {
    putTrack(stored(4));
    const arr = JSON.parse(mem.m.get('cbpr.tracking.v1')!) as unknown[];
    arr.push({ ...stored(5), record: { ...record(5), userOpHash: '0x12' } }, 'junk', null);
    mem.m.set('cbpr.tracking.v1', JSON.stringify(arr));
    expect(loadTracks().map((s) => s.record.nonce)).toEqual(['4']);
    mem.m.set('cbpr.tracking.v1', '{not json');
    expect(loadTracks()).toEqual([]);
  });

  it('cleanRecord refuses malformed values (both directions on the same validator)', () => {
    expect(cleanRecord(record(6)).nonce).toBe('6');
    expect(() => cleanRecord({ ...record(6), nonce: '-1' })).toThrow();
    expect(() => cleanRecord({ ...record(6), senderHash: 'vitalik.eth' })).toThrow();
    expect(() => cleanRecord({ ...record(6), format: 'cbpr-track-v0' })).toThrow();
    expect(() => cleanRecord({ ...record(6), intent: { ...record(6).intent, amount: '1.5' } })).toThrow();
  });

  it('no full sender, recipient or gas wallet at rest; a legacy full-address record is migrated and rewritten on read', () => {
    putTrack(stored(9));
    const fulls = [A, R, G].map((x) => x.slice(2).toLowerCase());
    const raw = () => mem.m.get('cbpr.tracking.v1')!.toLowerCase();
    for (const f of fulls) expect(raw()).not.toContain(f);
    expect(loadTracks()[0]!.record.intent).toMatchObject({ recipientHash: recipientDigest(R), recipientShort: '0x000000…0aB1E5' });
    // A record written before the rule (full sender / source / recipient / gas wallet).
    const { senderHash: _a, senderShort: _b, gasWalletHash: _c, ...restRec } = record(10);
    const { recipientHash: _h, recipientShort: _s, ...restIntent } = record(10).intent;
    mem.m.set('cbpr.tracking.v1', JSON.stringify([{ ...stored(10), record: { ...restRec, sender: A, gasWallet: G, intent: { ...restIntent, source: A, recipient: R } } }]));
    expect(loadTracks()[0]!.record).toMatchObject({ senderHash: addressDigest(A), gasWalletHash: addressDigest(G), intent: { recipientHash: recipientDigest(R) } });
    for (const f of fulls) expect(raw()).not.toContain(f);
  });

  it('isStored: true after a write that reads back; false when storage refuses the write (quota / blocked)', () => {
    const list = putTrack(stored(12));
    expect(isStored(stored(12), list)).toBe(true);
    mem.setItem = () => {
      throw new Error('QuotaExceededError');
    };
    expect(() => putTrack(stored(13))).not.toThrow();
    expect(isStored(stored(13))).toBe(false);
  });

  it('setScanCursor keeps the scan position in place across a reload, without reordering', () => {
    putTrack(stored(14));
    putTrack(stored(15));
    setScanCursor(record(14).userOpHash, null, '50120');
    const list = loadTracks();
    expect(list.map((x) => [x.record.nonce, x.scanCursor])).toEqual([['15', null], ['14', '50120']]);
    expect(() => putTrack({ ...stored(14), scanCursor: '-3' })).toThrow();
  });

  it('cleanRecord refuses a recipient short form that is not 6…6 hex (it could carry the full address)', () => {
    expect(() => cleanRecord({ ...record(11), intent: { ...record(11).intent, recipientShort: R } })).toThrow();
    expect(() => cleanRecord({ ...record(11), intent: { ...record(11).intent, recipientHash: '0x12' } })).toThrow();
  });

  it('one record per UserOperation: the hash-less record is replaced when the tx hash arrives', () => {
    const tx = ('0x' + 'cd'.repeat(32)) as Hex;
    putTrack(stored(7));
    expect(putTrack(stored(7, tx)).map((s) => s.record.txHash)).toEqual([tx]);
    // removeTrack needs the stored pair: the wrong tx hash removes nothing, the right one removes it.
    expect(removeTrack(record(7).userOpHash, null)).toHaveLength(1);
    expect(removeTrack(record(7).userOpHash, tx)).toEqual([]);
  });

  it('a full list (20) never drops an earlier record to make room: the new record is not kept, so the send is refused', () => {
    for (let i = 10; i < 30; i++) putTrack(stored(i));
    expect(trackListFull(record(30).userOpHash)).toBe(true);
    const list = putTrack(stored(30));
    expect([list.length, list[0]!.record.nonce, list[19]!.record.nonce]).toEqual([20, '29', '10']);
    expect(isStored(stored(30), list)).toBe(false);
  });

  it('a full list still updates a record it already holds (the hash arriving for the 20th transfer)', () => {
    for (let i = 10; i < 30; i++) putTrack(stored(i));
    const tx = ('0x' + 'ab'.repeat(32)) as Hex;
    expect(trackListFull(record(10).userOpHash)).toBe(false);
    expect(isStored(stored(10, tx), putTrack(stored(10, tx)))).toBe(true);
    expect(loadTracks()).toHaveLength(20);
  });

  it('after a settled record is removed, a new one fits again', () => {
    for (let i = 10; i < 30; i++) putTrack(stored(i));
    removeTrack(record(10).userOpHash, null);
    expect(isStored(stored(30), putTrack(stored(30)))).toBe(true);
  });

  it('removeTrackIf: a refused send takes back its own hash-less record, so 20 refusals do not fill the list', () => {
    for (let n = 1; n <= 25; n++) {
      const own = stored(100 + n);
      expect(isStored(own, putTrack(own))).toBe(true);
      removeTrackIf(own);
    }
    expect(loadTracks()).toEqual([]);
    expect(trackListFull(record(200).userOpHash)).toBe(false);
  });

  it('removeTrackIf leaves a record that gained a hash, a replaced record, and other transfers', () => {
    const own = stored(7);
    putTrack(own);
    putTrack(stored(8));
    putTrack(stored(7, ('0x' + 'ab'.repeat(32)) as Hex)); // the hash arrived for 7
    removeTrackIf(own);
    expect(loadTracks().map((s) => [s.record.nonce, s.record.txHash])).toEqual([['7', '0x' + 'ab'.repeat(32)], ['8', null]]);
    removeTrackIf(stored(7, ('0x' + 'ab'.repeat(32)) as Hex)); // a record with a hash is never taken back
    expect(loadTracks()).toHaveLength(2);
  });

  it('no storage (private mode / blocked) → empty list, no throw', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(loadTracks()).toEqual([]);
    expect(putTrack(stored(8))).toEqual([]);
  });
});

describe('trackingStore deploy records', () => {
  const acct = ('0x' + 'a1'.repeat(32)) as Hex;
  const other = ('0x' + 'b2'.repeat(32)) as Hex;
  const dr = (accountHash: Hex, txHash: Hex | null = null): DeployRecord => ({ format: 'cbpr-deploy-v1', chainId: 9745, deploymentId: 'coinbase-smart-wallet-v1.1-plasma', accountHash, gasWalletHash: ('0x' + 'c3'.repeat(32)) as Hex, key: 'account', txHash, savedAt: 1_700_000_000_000 });

  it('one in-flight send per account: put → get; the hash replaces the hash-less record; clear removes only that account', () => {
    putDeploy(dr(acct));
    putDeploy(dr(other));
    const tx = ('0x' + 'dd'.repeat(32)) as Hex;
    putDeploy(dr(acct, tx));
    expect(getDeploy(9745, 'coinbase-smart-wallet-v1.1-plasma', acct)?.txHash).toBe(tx);
    clearDeploy(9745, 'coinbase-smart-wallet-v1.1-plasma', acct);
    expect(getDeploy(9745, 'coinbase-smart-wallet-v1.1-plasma', acct)).toBeNull();
    expect(getDeploy(9745, 'coinbase-smart-wallet-v1.1-plasma', other)).not.toBeNull();
    clearDeploy(9745, 'coinbase-smart-wallet-v1.1-plasma', other);
    expect(mem.m.has('cbpr.deploy.v1')).toBe(false);
  });

  it('clearDeployIf: an older attempt clears only its own record; a newer attempt for the account keeps its record', () => {
    const a = dr(acct);
    putDeploy(a);
    const b = { ...dr(acct), savedAt: a.savedAt + 4_000 };
    putDeploy(b);
    clearDeployIf(a);
    expect(getDeploy(9745, 'coinbase-smart-wallet-v1.1-plasma', acct)).toEqual(b);
    clearDeployIf(b);
    expect(getDeploy(9745, 'coinbase-smart-wallet-v1.1-plasma', acct)).toBeNull();
  });

  it('another chain or deployment does not match; only allowlisted fields reach storage', () => {
    putDeploy({ ...dr(acct), account: '0x5FbDB2315678afecb367f032d93F642f64180aa3', signature: '0xbeef' } as unknown as DeployRecord);
    expect(getDeploy(1, 'coinbase-smart-wallet-v1.1-plasma', acct)).toBeNull();
    expect(getDeploy(9745, 'other-deployment', acct)).toBeNull();
    const raw = mem.m.get('cbpr.deploy.v1')!;
    expect(raw).not.toContain('5FbDB2315678');
    expect(raw).not.toContain('beef');
  });

  it('a malformed stored entry is dropped; a malformed write throws (same validator both ways)', () => {
    mem.m.set('cbpr.deploy.v1', JSON.stringify([{ ...dr(acct), accountHash: '0x12' }, dr(other)]));
    expect(getDeploy(9745, 'coinbase-smart-wallet-v1.1-plasma', other)).not.toBeNull();
    expect(() => putDeploy({ ...dr(acct), key: '../x' })).toThrow();
    expect(cleanDeploy(dr(acct)).key).toBe('account');
  });
});
