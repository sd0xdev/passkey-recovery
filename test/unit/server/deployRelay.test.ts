import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { DeployStep } from '../../../server/deploy';
import { DEPLOY_ISSUE_TTL_MS, DeployRelay, MAX_DEPLOY_GAS } from '../../../server/deployRelay';
import { HttpError } from '../../../server/http';
import type { Reader } from '../../../server/reader';
import type { IssuedTx, NativeSign, RelayOutcome } from '../../../server/relay';
import { DEP, GAS, SRC_A, SRC_B } from '../../fixtures/accounts';

// SYNTHETIC gas key per run; never a well-known key. The relay and the reader are fakes: no network.
const gasKey = privateKeyToAccount(generatePrivateKey());
const otherKey = privateKeyToAccount(generatePrivateKey());
const FROM: Address = gasKey.address;
const HEAD = 1234n;
const TX_COUNT = 5n;

const step = (key: DeployStep['key'] = 'account', o: Partial<DeployStep> = {}): DeployStep => {
  const data: Hex = '0x3ffba36f00000000000000000000000000000000000000000000000000000000000000c1';
  return { key, to: getAddress(DEP.factory), data, inputHash: keccak256(data), creates: SRC_A, expectCodeHash: DEP.codeHash.walletProxy, ...o };
};
const body = (o: Record<string, unknown> = {}) => ({ via: 'browser-file', gas: '400000', maxFeePerGas: '2000000000', maxPriorityFeePerGas: '1000000', ...o });

function setup(o: { code?: Hex | null; native?: NativeSign | null; relay?: (raw: Hex) => Promise<RelayOutcome> } = {}) {
  let t = 10_000_000;
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const calls = { code: [] as [Address, Hex][], txCount: [] as [Address, Hex][], relayed: [] as Hex[], native: [] as IssuedTx[] };
  const reader = {
    dep: DEP,
    head: async () => ({ number: HEAD, hash: `0x${'11'.repeat(32)}` as Hex, timestamp: 0n, baseFee: 1n }),
    code: async (a: Address, tag: Hex) => (calls.code.push([a, tag]), o.code === undefined ? null : o.code),
    txCount: async (a: Address, tag: Hex) => (calls.txCount.push([a, tag]), TX_COUNT),
  } as unknown as Reader;
  const relay = o.relay ?? (async (raw: Hex): Promise<RelayOutcome> => (calls.relayed.push(raw), { outcome: 'hash', txHash: keccak256(raw) }));
  const wrappedRelay = async (raw: Hex) => (o.relay ? (calls.relayed.push(raw), relay(raw)) : relay(raw));
  const native = o.native === undefined ? null : o.native;
  const dr = new DeployRelay(reader, wrappedRelay, native, clock.now);
  return { dr, clock, calls };
}

/** Signs exactly what was issued (what the page's File key would do). */
const signIssued = async (tx: { to: Address; data: Hex; nonce: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string; chainId: string }, key = gasKey, o: { nonce?: number } = {}) =>
  key.signTransaction({ type: 'eip1559', chainId: Number(BigInt(tx.chainId)), to: tx.to, data: tx.data, nonce: o.nonce ?? Number(BigInt(tx.nonce)), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), value: 0n });
const nativeSigner = (calls: { native: IssuedTx[] }, key = gasKey): NativeSign => async (tx) => {
  calls.native.push(tx);
  return { ok: true, raw: await key.signTransaction({ type: 'eip1559', chainId: tx.chainId, to: tx.to, data: tx.data, nonce: Number(tx.nonce), gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, value: 0n }) };
};

async function statusOf(p: Promise<unknown> | (() => unknown)): Promise<number> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 0;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.status;
  }
}

describe('DeployRelay.issue', () => {
  it('issues the exact step at the head nonce with value 0 and the deployment chainId', async () => {
    const { dr } = setup();
    const r = await dr.issue(step(), SRC_A, FROM, body());
    expect(r.tx).toEqual({ from: getAddress(FROM), to: getAddress(DEP.factory), data: step().data, value: '0x0', nonce: '0x5', gas: '0x61a80', maxFeePerGas: '0x77359400', maxPriorityFeePerGas: '0xf4240', chainId: `0x${DEP.chainId.toString(16)}` });
  });
  it('reads the target code and the nonce at the same head block', async () => {
    const { dr, calls } = setup();
    await dr.issue(step(), SRC_A, FROM, body());
    expect(calls.code).toEqual([[SRC_A, '0x4d2']]);
    expect(calls.txCount).toEqual([[FROM, '0x4d2']]);
  });
  it('expires DEPLOY_ISSUE_TTL_MS (2 min) after issue', async () => {
    const { dr, clock } = setup();
    expect((await dr.issue(step(), SRC_A, FROM, body())).expiresAt).toBe(clock.now() + DEPLOY_ISSUE_TTL_MS);
  });
  it(`accepts gas exactly ${MAX_DEPLOY_GAS} (the cap)`, async () => {
    const { dr } = setup();
    expect(await statusOf(dr.issue(step(), SRC_A, FROM, body({ gas: MAX_DEPLOY_GAS.toString() })))).toBe(0);
  });
  it.each([
    ['gas above 30M', { gas: (MAX_DEPLOY_GAS + 1n).toString() }],
    ['gas 0', { gas: '0' }],
    ['gas as a number', { gas: 400000 }],
    ['gas with a leading zero', { gas: '0400000' }],
    ['gas negative', { gas: '-1' }],
    ['a hex fee', { maxFeePerGas: '0x10' }],
    ['priority above max fee', { maxPriorityFeePerGas: '2000000001' }],
    ['an unknown via', { via: 'browser-wallet' }],
    ['no via', { via: undefined }],
  ])('%s → 400, nothing read', async (_n, o) => {
    const { dr, calls } = setup();
    expect(await statusOf(dr.issue(step(), SRC_A, FROM, body(o)))).toBe(400);
    expect(calls.txCount).toEqual([]);
  });
  it('refuses a target that already holds code (409)', async () => {
    const { dr } = setup({ code: keccak256('0x6000') });
    expect(await statusOf(dr.issue(step(), SRC_A, FROM, body()))).toBe(409);
  });
  it('one open issue per account + step: a second issue is 409', async () => {
    const { dr } = setup();
    await dr.issue(step(), SRC_A, FROM, body());
    expect(await statusOf(dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' })))).toBe(409);
  });
  it('another step of the same account, or the same step of another account, may be issued', async () => {
    const { dr } = setup();
    await dr.issue(step(), SRC_A, FROM, body());
    expect(await statusOf(dr.issue(step('factory'), SRC_A, FROM, body()))).toBe(0);
    expect(await statusOf(dr.issue(step('account', { creates: SRC_B }), SRC_B, FROM, body()))).toBe(0);
  });
  it('the same step can be issued again once the open one has expired', async () => {
    const { dr, clock } = setup();
    await dr.issue(step(), SRC_A, FROM, body());
    clock.advance(DEPLOY_ISSUE_TTL_MS + 1);
    expect(await statusOf(dr.issue(step(), SRC_A, FROM, body()))).toBe(0);
  });
  it('the same step is still refused at exactly the TTL', async () => {
    const { dr, clock } = setup();
    await dr.issue(step(), SRC_A, FROM, body());
    clock.advance(DEPLOY_ISSUE_TTL_MS);
    expect(await statusOf(dr.issue(step(), SRC_A, FROM, body()))).toBe(409);
  });
  // Regression (TOCTOU): the slot is reserved before the reader awaits, so two concurrent issues of the
  // same step cannot both pass the duplicate check.
  it('two concurrent issues of the same step → exactly one succeeds', async () => {
    const { dr } = setup();
    const r = await Promise.allSettled([dr.issue(step(), SRC_A, FROM, body()), dr.issue(step(), SRC_A, FROM, body())]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('DeployRelay.send (browser-file)', () => {
  it('relays the exactly signed issued step once and returns its key with the relay outcome', async () => {
    const { dr, calls } = setup();
    const { issueId, tx } = await dr.issue(step(), SRC_A, FROM, body());
    const raw = await signIssued(tx);
    expect(await dr.send({ issueId, via: 'browser-file', raw })).toEqual({ key: 'account', outcome: 'hash', txHash: keccak256(raw) });
    expect(calls.relayed).toEqual([raw.toLowerCase()]);
  });
  it('is single use: the second send is 404 and nothing more is relayed', async () => {
    const { dr, calls } = setup();
    const { issueId, tx } = await dr.issue(step(), SRC_A, FROM, body());
    const raw = await signIssued(tx);
    await dr.send({ issueId, via: 'browser-file', raw });
    expect(await statusOf(dr.send({ issueId, via: 'browser-file', raw }))).toBe(404);
    expect(calls.relayed).toHaveLength(1);
  });
  it('the issue is spent even when the relay rejects', async () => {
    const { dr } = setup({ relay: async () => ({ outcome: 'rejected', reason: 'insufficient funds in the gas wallet for gas × max fee' }) });
    const { issueId, tx } = await dr.issue(step(), SRC_A, FROM, body());
    const raw = await signIssued(tx);
    expect((await dr.send({ issueId, via: 'browser-file', raw })).outcome).toBe('rejected');
    expect(await statusOf(dr.send({ issueId, via: 'browser-file', raw }))).toBe(404);
  });
  it('an unknown issue id → 404', async () => {
    const { dr } = setup();
    expect([await statusOf(dr.send({ issueId: 'nope', via: 'browser-file' })), await statusOf(dr.send({ via: 'browser-file' }))]).toEqual([404, 404]);
  });
  it('a wrong via → 409, nothing relayed, and the issue is still usable with the right via', async () => {
    const { dr, calls } = setup();
    const { issueId, tx } = await dr.issue(step(), SRC_A, FROM, body());
    const raw = await signIssued(tx);
    expect(await statusOf(dr.send({ issueId, via: 'native-signer', raw }))).toBe(409);
    expect(calls.relayed).toEqual([]);
    expect(await statusOf(dr.send({ issueId, via: 'browser-file', raw }))).toBe(0);
  });
  it.each([
    ['another key', async (tx: Parameters<typeof signIssued>[0]) => signIssued(tx, otherKey)],
    ['another nonce', async (tx: Parameters<typeof signIssued>[0]) => signIssued(tx, gasKey, { nonce: 6 })],
    ['missing raw', async () => undefined],
  ])('a raw signed with %s is refused by checkSignedTx before any relay', async (_n, make) => {
    const { dr, calls } = setup();
    const { issueId, tx } = await dr.issue(step(), SRC_A, FROM, body());
    const status = await statusOf(dr.send({ issueId, via: 'browser-file', raw: await make(tx) }));
    expect([400, 422]).toContain(status);
    expect(calls.relayed).toEqual([]);
  });
  it('after the TTL the send is 410 and nothing is relayed', async () => {
    const { dr, clock, calls } = setup();
    const { issueId, tx } = await dr.issue(step(), SRC_A, FROM, body());
    const raw = await signIssued(tx);
    clock.advance(DEPLOY_ISSUE_TTL_MS + 1);
    expect(await statusOf(dr.send({ issueId, via: 'browser-file', raw }))).toBe(410);
    expect(calls.relayed).toEqual([]);
  });
  it('a second send while the first is being relayed → 404 (the issue was spent before the bytes left)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { dr, calls } = setup({ relay: async (raw) => (await gate, { outcome: 'hash', txHash: keccak256(raw) }) });
    const { issueId, tx } = await dr.issue(step(), SRC_A, FROM, body());
    const raw = await signIssued(tx);
    const first = dr.send({ issueId, via: 'browser-file', raw });
    await new Promise((r) => setTimeout(r, 10));
    expect(await statusOf(dr.send({ issueId, via: 'browser-file', raw }))).toBe(404);
    release();
    expect((await first).outcome).toBe('hash');
    expect(calls.relayed).toHaveLength(1);
  });
});

describe('DeployRelay.send (native-signer)', () => {
  it('asks the native signer for exactly the issued fields and relays its bytes', async () => {
    const calls0 = { native: [] as IssuedTx[] };
    const { dr, calls } = setup({ native: nativeSigner(calls0) });
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
    const r = await dr.send({ issueId, via: 'native-signer' });
    expect(calls0.native).toEqual([{ chainId: DEP.chainId, from: getAddress(FROM), to: getAddress(DEP.factory), data: step().data, nonce: TX_COUNT, gas: 400_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n }]);
    expect(r.outcome).toBe('hash');
    expect(calls.relayed).toHaveLength(1);
  });
  it('ignores a raw supplied by the page on the native path', async () => {
    const calls0 = { native: [] as IssuedTx[] };
    const { dr, calls } = setup({ native: nativeSigner(calls0) });
    const { issueId, tx } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
    const pageRaw = await signIssued(tx, otherKey);
    await dr.send({ issueId, via: 'native-signer', raw: pageRaw });
    expect(calls.relayed[0]).not.toBe(pageRaw.toLowerCase());
  });
  it('regression: the 2 min window closing while the native signer waits for the user → 410, nothing relayed, the issue ends', async () => {
    let clockRef!: { advance: (ms: number) => void };
    const calls0 = { native: [] as IssuedTx[] };
    const sign = nativeSigner(calls0);
    const { dr, clock, calls } = setup({ native: async (tx) => (clockRef.advance(DEPLOY_ISSUE_TTL_MS + 1), sign(tx)) });
    clockRef = clock;
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
    expect(await statusOf(dr.send({ issueId, via: 'native-signer' }))).toBe(410);
    expect([calls0.native.length, calls.relayed.length]).toEqual([1, 0]);
    expect(await statusOf(dr.send({ issueId, via: 'native-signer' }))).toBe(404);
  });
  it('a native signer refusal → 409 and the issue ends', async () => {
    const { dr, calls } = setup({ native: async () => ({ ok: false, reason: 'locked' }) });
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
    expect(await statusOf(dr.send({ issueId, via: 'native-signer' }))).toBe(409);
    expect(await statusOf(dr.send({ issueId, via: 'native-signer' }))).toBe(404);
    expect(calls.relayed).toEqual([]);
  });
  it('KSS-06: a coded refusal keeps its code as the answer’s kind; an unknown or missing code → sign-failed', async () => {
    const kindOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => (e as { kind?: unknown }).kind);
    for (const [code, kind] of [['keystore-stale', 'keystore-stale'], ['keystore-key-changed', 'keystore-key-changed'], ['made-up-code', 'sign-failed'], [undefined, 'sign-failed']] as const) {
      const { dr } = setup({ native: async () => ({ ok: false, reason: 'refused', ...(code ? { code: code as never } : {}) }) });
      const { issueId } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
      expect(await kindOf(dr.send({ issueId, via: 'native-signer' }))).toBe(kind);
    }
  });
  it('a native signer that signs with another key is refused by checkSignedTx (422)', async () => {
    const { dr, calls } = setup({ native: nativeSigner({ native: [] }, otherKey) });
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
    expect(await statusOf(dr.send({ issueId, via: 'native-signer' }))).toBe(422);
    expect(calls.relayed).toEqual([]);
  });
  it('no native signer bound → 503; binding one later lets the same issue go through', async () => {
    const { dr } = setup();
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
    expect(await statusOf(dr.send({ issueId, via: 'native-signer' }))).toBe(503);
    dr.bindNativeSigner(nativeSigner({ native: [] }));
    expect(await statusOf(dr.send({ issueId, via: 'native-signer' }))).toBe(0);
  });
});

describe('DeployRelay.abort / voidAll', () => {
  it('abort ends the issue: aborted true, then the send is 404', async () => {
    const { dr } = setup();
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body());
    expect(dr.abort({ issueId })).toEqual({ aborted: true });
    expect(await statusOf(dr.send({ issueId, via: 'browser-file' }))).toBe(404);
  });
  it('abort frees the step for a new issue', async () => {
    const { dr } = setup();
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body());
    dr.abort({ issueId });
    expect(await statusOf(dr.issue(step(), SRC_A, FROM, body()))).toBe(0);
  });
  it('abort of an unknown issue → aborted false', () => {
    const { dr } = setup();
    expect([dr.abort({ issueId: 'nope' }), dr.abort({})]).toEqual([{ aborted: false }, { aborted: false }]);
  });
  // The busy window is while the native signer is signing (before checkSignedTx and the relay).
  const pendingNative = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = nativeSigner({ native: [] });
    const native: NativeSign = async (tx) => (await gate, inner(tx));
    return { native, release: () => release() };
  };
  it('abort while the native signer is signing → 409', async () => {
    const n = pendingNative();
    const { dr } = setup({ native: n.native });
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
    const sending = dr.send({ issueId, via: 'native-signer' });
    await new Promise((r) => setTimeout(r, 10));
    expect(await statusOf(() => dr.abort({ issueId }))).toBe(409);
    n.release();
    expect((await sending).outcome).toBe('hash');
  });
  it('a second send while the native signer is signing → 409', async () => {
    const n = pendingNative();
    const { dr, calls } = setup({ native: n.native });
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
    const sending = dr.send({ issueId, via: 'native-signer' });
    await new Promise((r) => setTimeout(r, 10));
    expect(await statusOf(dr.send({ issueId, via: 'native-signer' }))).toBe(409);
    n.release();
    await sending;
    expect(calls.relayed).toHaveLength(1);
  });
  it('abort after the bytes went to the relay → aborted false (already spent)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { dr } = setup({ relay: async (raw) => (await gate, { outcome: 'hash', txHash: keccak256(raw) }) });
    const { issueId, tx } = await dr.issue(step(), SRC_A, FROM, body());
    const sending = dr.send({ issueId, via: 'browser-file', raw: await signIssued(tx) });
    await new Promise((r) => setTimeout(r, 10));
    expect(dr.abort({ issueId })).toEqual({ aborted: false });
    release();
    await sending;
  });
  it('voidAll ends every open issue and counts them', async () => {
    const { dr } = setup();
    const a = await dr.issue(step(), SRC_A, FROM, body());
    await dr.issue(step('factory'), SRC_A, GAS, body());
    expect(dr.voidAll()).toBe(2);
    expect(await statusOf(dr.send({ issueId: a.issueId, via: 'browser-file' }))).toBe(404);
  });
  it('regression: voidAll while the native signer is signing → the late signature is dropped (409), never relayed', async () => {
    const n = pendingNative();
    const { dr, calls } = setup({ native: n.native });
    const { issueId } = await dr.issue(step(), SRC_A, FROM, body({ via: 'native-signer' }));
    const sending = dr.send({ issueId, via: 'native-signer' });
    await new Promise((r) => setTimeout(r, 10));
    expect(dr.voidAll()).toBe(1);
    n.release();
    expect(await statusOf(sending)).toBe(409);
    expect(calls.relayed).toHaveLength(0);
  });
});
