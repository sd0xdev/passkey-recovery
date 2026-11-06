// The upstream read allowlist: every read the sidecar sends is one of a closed set, in both directions.
import { describe, expect, it } from 'vitest';
import { ERC1967_IMPLEMENTATION_SLOT } from '../../../src/config/registry';
import { filterForkRequest } from '../../../server/forkProxy';
import { USER_OP_EVENT_TOPIC } from '../../../server/abi';
import { assertReadAllowed, classifyCall, encodeCall } from '../../../server/reader';
import { UpstreamError } from '../../../server/upstream';
import { DEP, RCPT, SRC_A, USDT0 } from '../../fixtures/accounts';

const B = '0x10';
const call = (c: Parameters<typeof encodeCall>[1]) => encodeCall(DEP, c);
describe('upstream read allowlist', () => {
  it('allows the snapshot reads for any account', () => {
    expect(() => assertReadAllowed('eth_chainId', [])).not.toThrow();
    expect(() => assertReadAllowed('eth_getCode', [SRC_A, B])).not.toThrow();
    expect(() => assertReadAllowed('eth_getStorageAt', [SRC_A, ERC1967_IMPLEMENTATION_SLOT, B])).not.toThrow();
    for (const c of [call({ kind: 'tokenBalance', token: USDT0, owner: SRC_A }), call({ kind: 'epNonce', account: SRC_A }), call({ kind: 'ownerAtIndex', account: SRC_A, index: 15n }), call({ kind: 'factoryGetAddress', owners: ['0x01'], nonce: 9n })])
      expect(() => assertReadAllowed('eth_call', [c, B])).not.toThrow();
  });
  it('event scan: EntryPoint UserOperationEvent by hash within the range limit only', () => {
    const topic = USER_OP_EVENT_TOPIC;
    const ok = { address: DEP.entryPoint, topics: [topic, `0x${'11'.repeat(32)}`], fromBlock: '0x1', toBlock: '0x7d0' };
    expect(() => assertReadAllowed('eth_getLogs', [ok])).not.toThrow();
    expect(() => assertReadAllowed('eth_getLogs', [{ ...ok, toBlock: '0x7d2' }])).toThrow(UpstreamError);
    expect(() => assertReadAllowed('eth_getLogs', [{ ...ok, address: USDT0 }])).toThrow(UpstreamError);
  });
  it.each([
    ['eth_sendRawTransaction', ['0x00']],
    ['eth_sendUserOperation', [{}, SRC_A]],
    ['eth_estimateGas', [{ to: SRC_A, data: '0x' }]],
    ['eth_call (token transfer)', [{ to: USDT0, data: '0xa9059cbb' }, B]],
    ['eth_call (extra field)', [{ ...call({ kind: 'epNonce', account: SRC_A }), from: SRC_A }, B]],
    ['eth_call (ownerAtIndex beyond the supported maximum)', [{ to: SRC_A, data: call({ kind: 'ownerAtIndex', account: SRC_A, index: 0n }).data.replace(/0{2}$/, '10') }, B]],
    ['eth_call (trailing data)', [{ ...call({ kind: 'epNonce', account: SRC_A }), data: call({ kind: 'epNonce', account: SRC_A }).data + '00' }, B]],
    ['eth_getStorageAt (other slot)', [SRC_A, '0x0', B]],
    ['eth_chainId (params)', [1]],
  ])('refuses %s', (m, params) => {
    expect(() => assertReadAllowed(m.split(' ')[0]!, params as unknown[])).toThrow(UpstreamError);
  });
  it('classifyCall recognises a balance read of a registry token but not of another contract', () => {
    expect(classifyCall(DEP, USDT0, call({ kind: 'tokenBalance', token: USDT0, owner: RCPT }).data)?.kind).toBe('tokenBalance');
    expect(classifyCall(DEP, RCPT, call({ kind: 'tokenBalance', token: USDT0, owner: RCPT }).data)).toBeNull();
  });
});

describe('fork proxy filter', () => {
  it('forwards state reads only, normalised', () => {
    const r = filterForkRequest({ jsonrpc: '2.0', id: 7, method: 'eth_getStorageAt', params: [SRC_A, '0x0', '0x1'], extra: 'x' } as never);
    expect(r).toEqual({ ok: true, clean: { jsonrpc: '2.0', id: 7, method: 'eth_getStorageAt', params: [SRC_A, '0x0', '0x1'] } });
  });
  it.each(['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sendUserOperation', 'eth_call', 'eth_estimateGas', 'anvil_setCode', 'debug_traceCall', 'eth_sign'])('refuses %s', (method) => {
    expect(filterForkRequest({ jsonrpc: '2.0', id: 1, method, params: [] }).ok).toBe(false);
  });
  it('refuses malformed requests', () => {
    expect(filterForkRequest({ id: 1 }).ok).toBe(false);
    expect(filterForkRequest({ id: 1, method: 'eth_chainId', params: {} }).ok).toBe(false);
  });
});
