import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { broadcastRaw, broadcastReason } from '../../../server/signer/broadcast';
import { UpstreamError, type Upstream } from '../../../server/upstream';

// SYNTHETIC bytes only: a fake "signed transaction" and a fake 65-byte signature, never real ones.
const RAW = `0x02f8${'ab'.repeat(120)}` as Hex;
const SIG = `0x${'5c'.repeat(65)}`;
const fakeUp = (body: unknown, source: Upstream['info']['source'] = 'testchain') =>
  ({ info: { source }, raw: async () => JSON.stringify(body) }) as unknown as Upstream;
const failure = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as UpstreamError);

describe('broadcast errors never forward the node’s text', () => {
  it('an RPC rejection that echoes the signature or the raw transaction is reported without either', async () => {
    for (const message of [`invalid signature ${SIG}`, `rlp: bad tx ${RAW}`, `weird ${SIG.slice(2)}`, 'something unknown']) {
      const e = await failure(broadcastRaw(fakeUp({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } }), RAW));
      expect(e).toBeInstanceOf(UpstreamError);
      expect(e!.message).toMatch(/^broadcast rejected: /);
      expect(e!.message).not.toContain(SIG.slice(2, 40));
      expect(e!.message).not.toContain(RAW.slice(6, 40));
      expect(e!.message).toContain('(code -32000)');
    }
  });

  it('known rejections map onto fixed reasons; a non-numeric code or message is ignored', () => {
    expect(broadcastReason({ code: -32000, message: 'nonce too low: next nonce 8, tx nonce 7' })).toBe('nonce already used — something was sent with this nonce; do not resend; track it (code -32000)');
    expect(broadcastReason({ message: 'insufficient funds for gas * price + value' })).toBe('insufficient funds in the gas wallet for gas × max fee');
    expect(broadcastReason({ message: 'max fee per gas less than block base fee' })).toBe('max fee is below the current base fee');
    expect(broadcastReason({ message: `invalid sender ${SIG}` })).toBe('signature or chain id rejected by the node');
    expect(broadcastReason({ code: '0xdead', message: 42 })).toBe('the node rejected the transaction (its message is withheld: it may echo the signed transaction)');
    expect(broadcastReason({})).toMatch(/withheld/);
  });

  it('success returns the local keccak; a different hash, non-JSON or the public default RPC are refused', async () => {
    expect(await broadcastRaw(fakeUp({ jsonrpc: '2.0', id: 1, result: keccak256(RAW) }), RAW)).toBe(keccak256(RAW));
    expect((await failure(broadcastRaw(fakeUp({ result: `0x${'00'.repeat(32)}` }), RAW)))!.message).toMatch(/not keccak256/);
    const notJson = { info: { source: 'file' }, raw: async () => `<html>${SIG}</html>` } as unknown as Upstream;
    expect((await failure(broadcastRaw(notJson, RAW)))!.message).toBe('broadcast response is not JSON');
    expect((await failure(broadcastRaw(fakeUp({ result: keccak256(RAW) }, 'default'), RAW)))!.message).toMatch(/requires the user-configured RPC/);
  });
});
