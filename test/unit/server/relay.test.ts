import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { getAddress, keccak256, parseSignature, toHex, toRlp, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../../../server/http';
import { checkSignedTx, MAX_RAW_TX_BYTES, relayRaw, type ExpectedTx } from '../../../server/relay';
import { UpstreamError, type Upstream } from '../../../server/upstream';

// SYNTHETIC keys generated per run; never a well-known (Anvil/Hardhat) key. Nothing is broadcast.
const signer = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());
const CHAIN = 9745;
const TO: Address = getAddress('0x5a00000000000000000000000000000000e9e9e9');
const DATA: Hex = '0x1fad948c00000000000000000000000000000000000000000000000000000000000000aa';

interface TxFields {
  chainId: number;
  to: Address;
  data: Hex;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  value: bigint;
  accessList?: { address: Address; storageKeys: Hex[] }[];
}
const BASE: TxFields = { chainId: CHAIN, to: TO, data: DATA, nonce: 7, gas: 300_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, value: 0n };
const want = (o: Partial<ExpectedTx> = {}): ExpectedTx => ({ chainId: CHAIN, from: signer.address, to: TO, inputHash: keccak256(DATA), nonce: 7n, gas: 300_000n, maxFeePerGas: 2_000_000_000n, ...o });
const sign = (o: Partial<TxFields> = {}, acct: PrivateKeyAccount = signer): Promise<Hex> => acct.signTransaction({ type: 'eip1559', ...BASE, ...o });

/** Hand-built type-2 tx, for fields viem's serializer refuses to produce (priority > max fee). */
async function signRawEip1559(f: TxFields, acct: PrivateKeyAccount = signer): Promise<Hex> {
  const q = (v: bigint | number) => (BigInt(v) === 0n ? '0x' : toHex(BigInt(v)));
  const fields = [q(f.chainId), q(f.nonce), q(f.maxPriorityFeePerGas), q(f.maxFeePerGas), q(f.gas), f.to, q(f.value), f.data, []] as const;
  const unsigned = `0x02${toRlp(fields as unknown as Hex[]).slice(2)}` as Hex;
  const sig = parseSignature(await acct.sign({ hash: keccak256(unsigned) }));
  const signed = [...fields, q(sig.yParity ?? 0), sig.r, sig.s];
  return `0x02${toRlp(signed as unknown as Hex[]).slice(2)}` as Hex;
}

async function statusOf(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.status;
  }
}

describe('checkSignedTx', () => {
  it('the exact issued transaction → returns the raw bytes (lower-cased)', async () => {
    const raw = await sign();
    expect(await checkSignedTx(raw, want())).toBe(raw.toLowerCase());
  });
  it('accepts upper-case hex and normalises it', async () => {
    const raw = await sign();
    const upper = (`0x${raw.slice(2).toUpperCase()}`) as Hex;
    expect(await checkSignedTx(upper, want())).toBe(raw.toLowerCase());
  });
  it('accepts a lower max fee than issued (the cap is an upper bound)', async () => {
    expect(await statusOf(checkSignedTx(await sign({ maxFeePerGas: 1_500_000_000n }), want()))).toBe(0);
  });
  it('the hand-built signer agrees with viem for a valid tx (helper control)', async () => {
    expect(await statusOf(checkSignedTx(await signRawEip1559(BASE), want()))).toBe(0);
  });

  it.each([
    ['chainId', { chainId: 1 }, /chainId/],
    ['to', { to: getAddress('0x5a00000000000000000000000000000000e9e9e8') }, /\bto\b/],
    ['value ≠ 0', { value: 1n }, /value/],
    ['input', { data: `${DATA.slice(0, -2)}ab` as Hex }, /input/],
    ['nonce', { nonce: 8 }, /nonce/],
    ['gas (exact, lower)', { gas: 299_999n }, /gas/],
    ['gas (exact, higher)', { gas: 300_001n }, /gas/],
    ['maxFee above issued', { maxFeePerGas: 2_000_000_001n }, /maxFeePerGas/],
    ['an access list', { accessList: [{ address: TO, storageKeys: [] }] }, /accessList/],
  ] as const)('a %s mismatch → 422 naming it', async (_n, o, re) => {
    const err = await checkSignedTx(await sign(o as Partial<TxFields>), want()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toMatch(re);
  });
  it('a different signer → 422 (signer)', async () => {
    const err = await checkSignedTx(await sign({}, stranger), want()).catch((e: unknown) => e);
    expect((err as HttpError).status).toBe(422);
    expect((err as HttpError).message).toMatch(/signer/);
  });
  it('priority fee above max fee → 422', async () => {
    const raw = await signRawEip1559({ ...BASE, maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000_001n });
    expect(await statusOf(checkSignedTx(raw, want()))).toBe(422);
  });
  it('several differences are all reported, and nothing passes', async () => {
    const err = (await checkSignedTx(await sign({ nonce: 9, value: 5n }), want()).catch((e: unknown) => e)) as HttpError;
    expect(err.message).toMatch(/value/);
    expect(err.message).toMatch(/nonce/);
  });

  describe('gasAtMost', () => {
    it('accepts a lower gas limit', async () => {
      expect(await statusOf(checkSignedTx(await sign({ gas: 250_000n }), want({ gasAtMost: true })))).toBe(0);
    });
    it('accepts exactly the bound', async () => {
      expect(await statusOf(checkSignedTx(await sign(), want({ gasAtMost: true })))).toBe(0);
    });
    it('refuses a higher gas limit (422)', async () => {
      expect(await statusOf(checkSignedTx(await sign({ gas: 300_001n }), want({ gasAtMost: true })))).toBe(422);
    });
  });

  // The type gate is a syntactic pre-check (status 400), before any decoding: a legacy or type-1 tx
  // never reaches the 422 field comparison. Both are refused before any network call.
  it('a legacy tx → refused (400, not type 2)', async () => {
    const raw = await signer.signTransaction({ type: 'legacy', chainId: CHAIN, to: TO, data: DATA, nonce: 7, gas: 300_000n, gasPrice: 2_000_000_000n });
    expect(await statusOf(checkSignedTx(raw, want()))).toBe(400);
  });
  it('a type-1 (EIP-2930) tx → refused (400, not type 2)', async () => {
    const raw = await signer.signTransaction({ type: 'eip2930', chainId: CHAIN, to: TO, data: DATA, nonce: 7, gas: 300_000n, gasPrice: 2_000_000_000n, accessList: [] });
    expect(await statusOf(checkSignedTx(raw, want()))).toBe(400);
  });
  it(`a raw tx above ${MAX_RAW_TX_BYTES} bytes → refused (413)`, async () => {
    const big = (`0x${'ab'.repeat(MAX_RAW_TX_BYTES)}`) as Hex;
    const raw = await sign({ data: big });
    expect(await statusOf(checkSignedTx(raw, want({ inputHash: keccak256(big) })))).toBe(413);
  });
  it.each([
    ['non-hex characters', '0x02zzzz'],
    ['an odd length', '0x02abc'],
    ['no 0x prefix', '02f86b'],
    ['a non-string', 12345],
    ['undefined', undefined],
  ])('%s → 400', async (_n, raw) => {
    expect(await statusOf(checkSignedTx(raw, want()))).toBe(400);
  });
  it('type-2 prefixed garbage that is not RLP → 422 (cannot decode)', async () => {
    expect(await statusOf(checkSignedTx('0x02deadbeef', want()))).toBe(422);
  });
  it('a truncated valid tx → 422', async () => {
    const raw = await sign();
    expect(await statusOf(checkSignedTx(raw.slice(0, -10), want()))).toBe(422);
  });
});

describe('relayRaw', () => {
  const fakeUp = (answer: (body: string) => Promise<string>) => {
    const bodies: string[] = [];
    const up = { raw: async (b: string) => (bodies.push(b), answer(b)) } as unknown as Upstream;
    return { up, bodies };
  };
  const RAW = '0x02f8aa0102030405' as Hex;
  const LOCAL = keccak256(RAW);
  const rpc = (o: object) => async () => JSON.stringify({ jsonrpc: '2.0', id: 1, ...o });

  it('sends exactly one eth_sendRawTransaction with the raw bytes', async () => {
    const { up, bodies } = fakeUp(rpc({ result: LOCAL }));
    await relayRaw(up, RAW);
    expect(bodies.map((b) => JSON.parse(b))).toEqual([{ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [RAW] }]);
  });
  it('a matching hash → hash', async () => {
    expect(await relayRaw(fakeUp(rpc({ result: LOCAL })).up, RAW)).toEqual({ outcome: 'hash', txHash: LOCAL });
  });
  it('a matching hash in upper case → hash (the local one)', async () => {
    expect(await relayRaw(fakeUp(rpc({ result: `0x${LOCAL.slice(2).toUpperCase()}` })).up, RAW)).toEqual({ outcome: 'hash', txHash: LOCAL });
  });
  it('a hash that is not keccak256(raw) → no-hash (never trusted)', async () => {
    const r = await relayRaw(fakeUp(rpc({ result: keccak256('0x01') })).up, RAW);
    expect(r.outcome).toBe('no-hash');
  });
  it('a non-string result → no-hash', async () => {
    expect((await relayRaw(fakeUp(rpc({ result: null })).up, RAW)).outcome).toBe('no-hash');
  });
  it('"already known" → hash of the local bytes', async () => {
    expect(await relayRaw(fakeUp(rpc({ error: { code: -32000, message: 'already known' } })).up, RAW)).toEqual({ outcome: 'hash', txHash: LOCAL });
  });
  it.each(['insufficient funds for gas * price + value', 'nonce too high', 'replacement transaction underpriced', 'invalid chain id'])('definite rejection "%s" → rejected', async (message) => {
    expect((await relayRaw(fakeUp(rpc({ error: { code: -32000, message } })).up, RAW)).outcome).toBe('rejected');
  });
  it('"nonce too low" → no-hash (ambiguous: something was sent with this nonce)', async () => {
    expect((await relayRaw(fakeUp(rpc({ error: { code: -32000, message: 'nonce too low: next nonce 8, tx nonce 7' } })).up, RAW)).outcome).toBe('no-hash');
  });
  it('an unrecognised rejection → no-hash, and the node text is withheld', async () => {
    const r = await relayRaw(fakeUp(rpc({ error: { code: -32603, message: `weird failure echoing ${RAW}` } })).up, RAW);
    expect(r.outcome).toBe('no-hash');
    expect(JSON.stringify(r)).not.toContain(RAW.slice(2));
  });
  it('a definite rejection does not forward the node text either', async () => {
    const r = await relayRaw(fakeUp(rpc({ error: { code: -32000, message: `insufficient funds; tx=${RAW}` } })).up, RAW);
    expect(JSON.stringify(r)).not.toContain(RAW.slice(2));
  });
  it.each([
    ['an UpstreamError timeout', () => Promise.reject(new UpstreamError('timeout', 'timed out')), /timeout/],
    ['an UpstreamError http', () => Promise.reject(new UpstreamError('http', 'HTTP 502')), /http/],
    ['a plain network error', () => Promise.reject(new Error('ECONNRESET')), /network/],
  ])('%s → no-hash', async (_n, answer, re) => {
    const r = await relayRaw(fakeUp(answer).up, RAW);
    expect(r.outcome).toBe('no-hash');
    expect((r as { reason: string }).reason).toMatch(re);
  });
  it('a non-JSON answer → no-hash', async () => {
    expect((await relayRaw(fakeUp(async () => '<html>bad gateway</html>').up, RAW)).outcome).toBe('no-hash');
  });
});
