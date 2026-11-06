// The canonical tracking record (architecture §6.3) is built in one place for the sidecar's plans and the
// Terminal signer: digests only, and the tracker's parser accepts exactly that shape. A record in the old
// full-address shape — what the signer used to build — is refused, so a drift shows up here, not after a
// real broadcast.
import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, type Hex } from 'viem';
import { SUPPORTED } from '../../../src/config/registry';
import { addressDigest } from '../../../src/transfer/intent';
import type { Reader } from '../../../server/reader';
import { buildTrackRecord, parseTrackHints, parseTrackRecord } from '../../../server/track';

const dep = SUPPORTED[0]!;
const reader = { dep } as unknown as Reader;
const SOURCE = getAddress('0x3f1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c');
const RECIPIENT = getAddress('0x9a8b7c6d5e4f30211203f4e5d6c7b8a990817263');
const GAS = getAddress('0x5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d');
const HASH = keccak256('0x01') as Hex;
const TX = keccak256('0x02') as Hex;
const build = () => buildTrackRecord({ chainId: dep.chainId, deploymentId: dep.id, userOpHash: HASH, source: SOURCE, recipient: RECIPIENT, asset: 'native', amount: 250_000_000_000_000_000n, nonce: 7n, gasWallet: GAS, gasWalletNonce: 3n, inputHash: null, txHash: TX, fromBlock: 1_204_000n });

describe('buildTrackRecord', () => {
  it('builds a record the tracker parses, with no full address anywhere in it', () => {
    const rec = build();
    const parsed = parseTrackRecord(reader, { record: rec });
    expect(parsed.senderHash).toBe(addressDigest(SOURCE));
    expect(parsed.intent.recipientHash).toBe(addressDigest(RECIPIENT));
    expect(parsed.txHash).toBe(TX);
    const text = JSON.stringify(rec).toLowerCase();
    for (const a of [SOURCE, RECIPIENT, GAS]) expect(text).not.toContain(a.slice(2).toLowerCase());
  });

  it('the full addresses travel only as hints, accepted when they match and refused when they do not', () => {
    const parsed = parseTrackRecord(reader, { record: build() });
    expect(parseTrackHints(parsed, { sender: SOURCE, gasWallet: GAS })).toEqual({ sender: SOURCE, gasWallet: GAS });
    expect(() => parseTrackHints(parsed, { sender: RECIPIENT })).toThrow(/not the address this record was made for/);
  });

  it('the old full-address shape (sender / intent.recipient / gasWallet) is refused by the parser', () => {
    const legacy = { format: 'cbpr-track-v1', chainId: dep.chainId, deploymentId: dep.id, userOpHash: HASH, sender: SOURCE, nonce: '7', intent: { source: SOURCE, recipient: RECIPIENT, asset: 'native', amount: '1' }, gasWallet: GAS, gasWalletNonce: '3', inputHash: null, txHash: TX, fromBlock: '1' };
    expect(() => parseTrackRecord(reader, { record: legacy })).toThrow(/senderHash/);
  });
});
