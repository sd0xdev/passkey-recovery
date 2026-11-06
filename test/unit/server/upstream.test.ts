import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NetGuardError } from '../../../server/net/guard';
import { createUpstream, providerOf, readUrlFile, UpstreamError, type Transport } from '../../../server/upstream';

// SYNTHETIC URL with a fake key; nothing is ever fetched (the transport is a stub).
const FAKE = 'https://plasma-mainnet.g.alchemy.com/v2/FAKEKEYfakekey0123456789';
const dir = mkdtempSync(join(tmpdir(), 'cbpr-url-'));
function file(name: string, text: string, mode = 0o600) {
  const p = join(dir, name);
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
}
const stub = (body: unknown, status = 200): Transport => async () => ({ status, retryAfter: null, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('readUrlFile', () => {
  it('reads one https line from an owner-only file', () => expect(readUrlFile(file('ok', `${FAKE}\n`))).toBe(FAKE));
  it.each([
    ['group/world readable', () => file('wide', FAKE, 0o644)],
    ['http', () => file('http', 'http://example.com/x')],
    ['two lines', () => file('two', `${FAKE}\n${FAKE}`)],
    ['userinfo', () => file('ui', 'https://u:p@example.com/')],
    ['not a URL', () => file('junk', 'not a url')],
    ['missing', () => join(dir, 'nope')],
  ])('rejects %s without echoing the content', (_, mk) => {
    let err: unknown;
    try {
      readUrlFile(mk());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UpstreamError);
    expect(String((err as Error).message)).not.toContain('FAKEKEY');
  });
});

describe('createUpstream', () => {
  it('labels the provider without exposing the URL', () => {
    const up = createUpstream({ url: FAKE, source: 'file', transport: stub({}) });
    expect(up.info).toEqual({ provider: 'alchemy', source: 'file', masked: 'https://•••/…', localException: false });
    expect(JSON.stringify(up.info)).not.toContain('FAKEKEY');
    expect(providerOf('https://rpc.plasma.to', 'default')).toBe('public-plasma');
  });
  it('never sends a write/sign method upstream', async () => {
    let called = false;
    const up = createUpstream({ url: FAKE, source: 'file', transport: async () => ((called = true), { status: 200, retryAfter: null, body: '{}' }) });
    for (const m of ['eth_sendRawTransaction', 'eth_sendUserOperation', 'eth_sign', 'anvil_setCode', 'debug_traceCall', 'alchemy_simulateExecution', 'trace_call', 'eth_simulateV1', 'eth_estimateUserOperationGas', 'eth_unknownMethod'])
      await expect(up.call(m, [])).rejects.toMatchObject({ kind: 'not-allowed' });
    expect(called).toBe(false);
  });
  it('redacts the URL and key from RPC error text, and network errors carry no URL', async () => {
    const up = createUpstream({ url: FAKE, source: 'file', transport: stub({ jsonrpc: '2.0', id: 1, error: { message: `bad key FAKEKEYfakekey0123456789 at ${FAKE}` } }) });
    const e = await up.call('eth_chainId', []).catch((x: Error) => x);
    expect((e as Error).message).not.toContain('FAKEKEY');
    const down = createUpstream({ url: FAKE, source: 'file', transport: async () => { throw new NetGuardError('network'); } });
    const n = await down.call('eth_chainId', []).catch((x: Error) => x);
    expect(n).toMatchObject({ kind: 'network' });
    expect((n as Error).message + ((n as Error).stack ?? '')).not.toContain('FAKEKEY');
  });
  it('redacts a query-string key, its URL-encoded form, and long non-hex tokens; keeps 0x data', async () => {
    const Q = 'https://rpc.example.invalid/v1?apikey=QSyntheticKey_0123456789&x=1';
    const msg = (m: string) => createUpstream({ url: Q, source: 'file', transport: stub({ jsonrpc: '2.0', id: 1, error: { message: m } }) }).call('eth_chainId', []).catch((x: Error) => x.message);
    const a = await msg(`denied apikey=QSyntheticKey_0123456789 (${encodeURIComponent('QSyntheticKey_0123456789')}) url ${Q}`);
    expect(a).not.toContain('QSyntheticKey');
    expect(a).not.toContain('0123456789');
    expect(await msg('echo key=OtherFormatTokenAAAABBBB')).not.toContain('OtherFormatTokenAAAABBBB');
    expect(await msg('execution reverted 0x08c379a0deadbeefdeadbeef at block 123')).toContain('0x08c379a0deadbeefdeadbeef');
  });
  it('body redaction (fork proxy) masks only URL secrets and leaves JSON field names intact', () => {
    const up = createUpstream({ url: 'https://rpc.example.invalid/v1?apikey=QSyntheticKey_0123456789', source: 'file', transport: stub({}) });
    const body = JSON.stringify({ result: { transactionsRoot: '0x' + '11'.repeat(32), withdrawalsRoot: '0x' + '22'.repeat(32), note: 'QSyntheticKey_0123456789' } });
    const r = JSON.parse(up.redact(body)) as { result: Record<string, string> };
    expect(Object.keys(r.result)).toEqual(['transactionsRoot', 'withdrawalsRoot', 'note']);
    expect(r.result.note).toBe('[redacted]');
    expect(up.redactError('transactionsRoot QSyntheticKey_0123456789')).not.toContain('QSyntheticKey');
  });
  it('treats HTTP errors, non-JSON and mismatched ids as errors, never as results', async () => {
    await expect(createUpstream({ url: FAKE, source: 'file', transport: stub('x', 500) }).call('eth_chainId', [])).rejects.toMatchObject({ kind: 'http' });
    await expect(createUpstream({ url: FAKE, source: 'file', transport: stub('<html>') }).call('eth_chainId', [])).rejects.toMatchObject({ kind: 'bad-response' });
    await expect(createUpstream({ url: FAKE, source: 'file', transport: stub({ jsonrpc: '2.0', id: 99, result: '0x1' }) }).call('eth_chainId', [])).rejects.toMatchObject({ kind: 'bad-response' });
  });
});
