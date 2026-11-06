// The AI report is built from an allowlist: free text is redacted (URLs, long hex), addresses cut to
// 6+6, and nothing outside the listed fields — a signature or URL in the input never reaches it.
import { describe, expect, it } from 'vitest';
import { buildReport, redactText, REPORT_FORMAT, type ReportInput } from '../../../src/ui/report';

const ACCT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const SIG = '0x' + 'ab'.repeat(120);
const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  generatedAt: '2026-10-31T00:00:00.000Z',
  mode: 'testchain',
  chain: { chainId: 9745, name: 'Plasma', deploymentId: 'coinbase-smart-wallet-v1.1-plasma' },
  rpc: { source: 'custom', overall: 'ready', capabilities: [{ id: 'fork', status: 'ok' }] },
  wallet: { connected: true, chainId: 9745 },
  diagnosis: { account: ACCT, supported: true, block: '120', checks: [{ id: 'D1', ok: true, detail: `code at ${ACCT} via https://rpc.example.com/key123` }], blockers: [], needs: [], passkeyOwnerIndexes: [0], nonce: '3' },
  deploy: null,
  transfer: { state: 'signed', asset: 'XPL', amount: '1000000000000000000', recipient: ACCT, nonce: '3', ownerIndex: 0, signable: true, notSignableReason: null, signedSim: { success: false, problems: [`revert data ${SIG}`] }, sendOutcome: null },
  tracks: [{ state: 'unknown', detail: 'no hash', confirmations: null, asset: 'XPL', amount: '1' }],
  lastError: `failed at http://127.0.0.1:4173/api?token=abc`,
  ...over,
});

describe('AI report', () => {
  it('redactText: URLs → [url], ≥40-hex runs → 6…6, short hex kept, max 400 chars', () => {
    expect(redactText('see https://a.b/c?x=1 now')).toBe('see [url] now');
    expect(redactText(`addr ${ACCT}`)).toBe('addr 0x5FbD…180aa3');
    expect(redactText('nonce 0x1f')).toBe('nonce 0x1f');
    expect(redactText('x'.repeat(900))).toHaveLength(400);
  });

  it('the built report carries no URL, no full address, no long hex', () => {
    const text = JSON.stringify(buildReport(input()));
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toContain(ACCT);
    expect(text).not.toMatch(/0x[0-9a-fA-F]{13,}/);
    expect(text).not.toContain('token=abc');
  });

  it('fields outside the allowlist are not copied (signature, assertion, publicKey on the input)', () => {
    const dirty = input({ transfer: { ...input().transfer!, signature: SIG, assertion: '{"x":1}', op: { signature: SIG } } as unknown as ReportInput['transfer'] });
    const r = buildReport(dirty) as { transfer: Record<string, unknown>; format: string };
    expect(r.format).toBe(REPORT_FORMAT);
    expect(Object.keys(r.transfer).sort()).toEqual(['amount', 'asset', 'nonce', 'notSignableReason', 'ownerIndex', 'recipient', 'sendOutcome', 'signable', 'signedSim', 'state']);
    expect(JSON.stringify(r)).not.toContain('assertion');
  });

  it('empty state (nothing checked yet) → nulls and empty lists, still well-formed', () => {
    const r = buildReport(input({ rpc: null, wallet: null, diagnosis: null, transfer: null, tracks: [], lastError: null }));
    expect([r.rpc, r.browserWallet, r.diagnosis, r.transfer, r.lastError]).toEqual([null, null, null, null, null]);
    expect(r.tracks).toEqual([]);
  });
});
