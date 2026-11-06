// Tracking evidence (events, receipts, nonces) is only about Plasma if the endpoint answers for Plasma
// now: a custom node restarted on another chain at the same URL must not settle a record. The real
// Reader over a SYNTHETIC endpoint (no network); the record is synthetic too.
import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, type Hex } from 'viem';
import { SUPPORTED, tokenAssets } from '../../../src/config/registry';
import { Reader } from '../../../server/reader';
import { buildTrackRecord, track } from '../../../server/track';
import { createUpstream, UpstreamError } from '../../../server/upstream';
import { SYN_GENESIS, syntheticRpc } from '../../fixtures/synthetic-rpc';

const dep = SUPPORTED[0]!;
const SOURCE = getAddress('0x3f1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c');
const RCPT = getAddress('0x9a8b7c6d5e4f30211203f4e5d6c7b8a990817263');
const GAS = getAddress('0x5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d');
const record = buildTrackRecord({ chainId: dep.chainId, deploymentId: dep.id, userOpHash: keccak256('0x51') as Hex, source: SOURCE, recipient: RCPT, asset: getAddress(tokenAssets(dep)[0]!.id), amount: 1_250_000n, nonce: 7n, gasWallet: GAS, gasWalletNonce: 3n, inputHash: null, txHash: null, fromBlock: 999_000n });

const run = (o: { chainId?: number; genesis?: string }) => {
  const s = syntheticRpc(o);
  const up = createUpstream({ url: 'https://synthetic.invalid/rpc', source: 'custom', transport: s.transport, sleep: async () => undefined });
  const reader = new Reader(up, { expectedGenesis: SYN_GENESIS, deployment: dep });
  return { result: track(reader, { record, sender: SOURCE }).then((r) => r, (e: unknown) => e), methods: () => s.log.map((l) => l.method) };
};

describe('track verifies the chain before reading any evidence', () => {
  it('an endpoint now on another chain (chainId 1) or with another genesis → chain-mismatch, no event or nonce read', async () => {
    for (const o of [{ chainId: 1 }, { genesis: '0x' + '0c'.repeat(32) }]) {
      const r = run(o);
      const e = await r.result;
      expect(e).toBeInstanceOf(UpstreamError);
      expect((e as UpstreamError).kind).toBe('chain-mismatch');
      expect(r.methods().filter((m) => m === 'eth_getLogs' || m === 'eth_call')).toEqual([]);
    }
  });

  it('the expected chain → the chain check passes and tracking reads on (a result, not an error)', async () => {
    const r = run({});
    const out = await r.result;
    expect(out).not.toBeInstanceOf(Error);
    expect(r.methods()).toContain('eth_chainId');
    expect(r.methods().some((m) => m === 'eth_getLogs' || m === 'eth_call')).toBe(true);
  });
});
