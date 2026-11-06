// Relay paths of the transfer plan state machine (File / native-signer gas payers). A real preview needs a
// fork (anvil: test/integration/transfer.test.ts); here the reader and the fork manager are fakes and a plan
// is seeded in the `signed` state with a passed signed simulation, which is exactly where sendRequest starts.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, keccak256, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import type { ForkManager } from '../../../server/fork';
import { HttpError } from '../../../server/http';
import type { AccountSnapshot, Reader } from '../../../server/reader';
import type { IssuedTx, NativeSign, RelayOutcome } from '../../../server/relay';
import { handleOpsData, type SignedSimResult } from '../../../server/sim';
import { TransferService, type SendVia, type TransferPlan } from '../../../server/transfer';
import { parseIntent } from '../../../src/transfer/intent';
import type { UserOperationV06 } from '../../../src/userop/hash';
import { DEP, RCPT, SRC_A } from '../../fixtures/accounts';

// SYNTHETIC keys per run; never a well-known key. Nothing reaches a network.
const gasKey = privateKeyToAccount(generatePrivateKey());
const otherKey = privateKeyToAccount(generatePrivateKey());
const GAS_WALLET: Address = gasKey.address;
const PK: Hex = `0x${'ab'.repeat(64)}`;
const EP_NONCE = 3n;
const GAS_NONCE = 11n;
const OUTER_GAS = 500_000n;
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n };

const snapshot = (): AccountSnapshot => ({
  chainId: DEP.chainId,
  block: 900n,
  blockHash: `0x${'22'.repeat(32)}`,
  timestamp: 0n,
  baseFee: 1n,
  priorityFee: 1n,
  infraCode: { entryPoint: DEP.codeHash.entryPoint, singletonFactory: DEP.codeHash.singletonFactory, implementation: DEP.codeHash.implementation, factory: DEP.codeHash.factory },
  account: SRC_A,
  accountCode: DEP.codeHash.walletProxy,
  accountImplementation: DEP.implementation,
  owners: [{ index: 0, bytes: PK }],
  nextOwnerIndex: 1n,
  removedOwnersCount: 0n,
  balances: { native: 10n ** 18n, tokens: {} },
  deposit: 0n,
  nonce: EP_NONCE,
  p256Probe: '0x',
  recipient: null,
  gasWallet: { address: GAS_WALLET, balance: 10n ** 18n, nonce: GAS_NONCE },
});
const signedSim = (): SignedSimResult => ({ label: 'signed handleOps (exact UserOp, real owners, your gas wallet as bundler)', outerGasLimit: OUTER_GAS, outerGasUsed: 400_000n, actualGasCost: 1n, actualGasUsed: 1n, success: true, deltas: {} as SignedSimResult['deltas'], nonceBefore: EP_NONCE, nonceAfter: EP_NONCE + 1n, problems: [], forkBlock: 900n });

function setup(o: { relay?: (raw: Hex) => Promise<RelayOutcome>; native?: NativeSign } = {}) {
  let t = 50_000_000;
  const clock = { now: () => t, advance: (ms: number) => void (t += ms) };
  const reader = { dep: DEP, snapshot: async () => snapshot() } as unknown as Reader;
  const forks = { run: async () => signedSim() } as unknown as ForkManager;
  const svc = new TransferService(reader, forks, [], { get: () => undefined }, clock);
  const relayed: Hex[] = [];
  const nativeCalls: IssuedTx[] = [];
  svc.bindRelay(async (raw) => (relayed.push(raw), o.relay ? o.relay(raw) : { outcome: 'hash', txHash: keccak256(raw) }));
  if (o.native) svc.bindNativeSigner(async (tx) => (nativeCalls.push(tx), o.native!(tx)));
  const plans = (svc as unknown as { plans: Map<string, TransferPlan> }).plans;
  const seed = (id = 'plan-a'): TransferPlan => {
    const intent = parseIntent(DEP, { source: SRC_A, recipient: RCPT, asset: 'native', amount: '1' });
    const op: UserOperationV06 = { sender: SRC_A, nonce: EP_NONCE, initCode: '0x', callData: '0xb61d27f6', callGasLimit: 100_000n, verificationGasLimit: 300_000n, preVerificationGas: 60_000n, ...FEES, paymasterAndData: '0x', signature: '0x' };
    const p: TransferPlan = {
      id,
      createdAt: clock.now(),
      state: 'signed',
      intent,
      intentHash: `0x${'33'.repeat(32)}`,
      ownerIndex: 0,
      ownerPublicKey: PK,
      gasWallet: GAS_WALLET,
      op,
      hash: `0x${'44'.repeat(32)}`,
      snapshotBlock: 900n,
      fees: { ...FEES },
      signable: true,
      notSignableReason: null,
      execOnly: {} as TransferPlan['execOnly'],
      twin: {} as TransferPlan['twin'],
      prefundWei: 0n,
      reserveWei: 0n,
      recipientInfo: { hasCode: false, native: 0n, token: null },
      signedOp: { ...op, signature: `0x${'cd'.repeat(120)}` },
      signedSim: signedSim(),
      send: null,
      handoff: null,
      rpcEpoch: 0,
      discardReason: null,
    };
    plans.set(id, p);
    return p;
  };
  return { svc, clock, seed, relayed, nativeCalls, plans };
}

type IssuedJson = { from: Address; to: Address; data: Hex; nonce?: string; gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string; chainId: string };
const signTx = (tx: IssuedJson, key = gasKey, o: { nonce?: number } = {}) =>
  key.signTransaction({ type: 'eip1559', chainId: Number(BigInt(tx.chainId)), to: tx.to, data: tx.data, nonce: o.nonce ?? Number(BigInt(tx.nonce!)), gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), value: 0n });
const nativeFrom = (key = gasKey): NativeSign => async (tx) => ({ ok: true, raw: await key.signTransaction({ type: 'eip1559', chainId: tx.chainId, to: tx.to, data: tx.data, nonce: Number(tx.nonce), gas: tx.gas, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas, value: 0n }) });

async function statusOf(p: Promise<unknown> | (() => unknown)): Promise<number> {
  try {
    await (typeof p === 'function' ? p() : p);
    return 0;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.status;
  }
}
async function issue(s: ReturnType<typeof setup>, via: SendVia | undefined, id = 'plan-a') {
  const p = s.plans.get(id) ?? s.seed(id);
  const r = await s.svc.sendRequest({ planId: id, intentHash: p.intentHash, ...(via === undefined ? {} : { via }) });
  return { p, tx: r.tx as IssuedJson | null, r };
}

describe('sendRequest with a relay via', () => {
  it.each(['browser-file', 'native-signer'] as const)('%s → the issued tx carries the gas wallet nonce at the head', async (via) => {
    const s = setup();
    const { tx, p } = await issue(s, via);
    expect(tx?.nonce).toBe(`0x${GAS_NONCE.toString(16)}`);
    expect(p.state).toBe('sending');
  });
  it('the issued tx is exactly handleOps(signed op, gas wallet) to the EntryPoint at the simulated gas', async () => {
    const s = setup();
    const p = s.seed();
    const want = handleOpsData(p.signedOp!, GAS_WALLET);
    const { tx } = await issue(s, 'browser-file');
    expect(tx).toEqual({ from: GAS_WALLET, to: getAddress(DEP.entryPoint), data: want, value: '0x0', gas: `0x${OUTER_GAS.toString(16)}`, maxFeePerGas: `0x${FEES.maxFeePerGas.toString(16)}`, maxPriorityFeePerGas: `0x${FEES.maxPriorityFeePerGas.toString(16)}`, chainId: `0x${DEP.chainId.toString(16)}`, nonce: `0x${GAS_NONCE.toString(16)}` });
  });
  it.each([['browser-wallet', 'browser-wallet' as const], ['the default via', undefined]])('%s → no nonce (the wallet picks it)', async (_n, via) => {
    const s = setup();
    const { tx } = await issue(s, via);
    expect(tx).not.toHaveProperty('nonce');
  });
  it('records the via on the send', async () => {
    const s = setup();
    const { p } = await issue(s, 'native-signer');
    expect(p.send?.via).toBe('native-signer');
  });
  it.each(['terminal-signer', 'File', 42])('via %s → 400', async (via) => {
    const s = setup();
    const p = s.seed();
    expect(await statusOf(s.svc.sendRequest({ planId: p.id, intentHash: p.intentHash, via }))).toBe(400);
  });
  it('a second send request for the same signature → 409', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-file');
    expect(await statusOf(s.svc.sendRequest({ planId: p.id, intentHash: p.intentHash, via: 'browser-file' }))).toBe(409);
  });
});

describe('relaySigned (browser-file)', () => {
  it('a hash → sent, the signed op is dropped and the bytes were relayed once', async () => {
    const s = setup();
    const { p, tx } = await issue(s, 'browser-file');
    const raw = await signTx(tx!);
    const r = await s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw });
    expect(r.relay).toEqual({ outcome: 'hash', txHash: keccak256(raw) });
    expect([p.state, p.send?.txHash, p.signedOp]).toEqual(['sent', keccak256(raw), null]);
    expect(s.relayed).toEqual([raw.toLowerCase()]);
  });
  it('a definite rejection → back to signed, the send cleared, and a new send may be requested', async () => {
    const s = setup({ relay: async () => ({ outcome: 'rejected', reason: 'insufficient funds in the gas wallet for gas × max fee' }) });
    const { p, tx } = await issue(s, 'browser-file');
    await s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw: await signTx(tx!) });
    expect([p.state, p.send]).toEqual(['signed', null]);
    expect(p.signedOp).not.toBeNull();
    expect(await statusOf(s.svc.sendRequest({ planId: p.id, intentHash: p.intentHash, via: 'browser-file' }))).toBe(0);
  });
  it('no hash → unknown (may be on chain), signed op dropped, never resendable', async () => {
    const s = setup({ relay: async () => ({ outcome: 'no-hash', reason: 'the RPC did not answer (timeout)' }) });
    const { p, tx } = await issue(s, 'browser-file');
    await s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw: await signTx(tx!) });
    expect([p.state, p.send?.outcome, p.signedOp]).toEqual(['unknown', 'no-hash', null]);
    expect(await statusOf(s.svc.sendRequest({ planId: p.id, intentHash: p.intentHash, via: 'browser-file' }))).toBe(409);
  });
  it('a via mismatch → 409, nothing relayed, the plan still awaits its signature', async () => {
    const s = setup();
    const { p, tx } = await issue(s, 'browser-file');
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'native-signer', raw: await signTx(tx!) }))).toBe(409);
    expect(s.relayed).toEqual([]);
    expect([p.state, p.send?.outcome]).toEqual(['sending', 'awaiting-wallet']);
  });
  it('bytes signed by another key → 422, nothing relayed', async () => {
    const s = setup();
    const { p, tx } = await issue(s, 'browser-file');
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw: await signTx(tx!, otherKey) }))).toBe(422);
    expect(s.relayed).toEqual([]);
  });
  it('bytes with another nonce → 422, nothing relayed', async () => {
    const s = setup();
    const { p, tx } = await issue(s, 'browser-file');
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw: await signTx(tx!, gasKey, { nonce: Number(GAS_NONCE) + 1 }) }))).toBe(422);
    expect(s.relayed).toEqual([]);
  });
  it('missing raw → 400', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-file');
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'browser-file' }))).toBe(400);
  });
  it('a browser-wallet send cannot be relayed (409) and a relay send cannot take a wallet result (409)', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-wallet');
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'browser-wallet', raw: '0x02' }))).toBe(409);
    const s2 = setup();
    const { p: p2 } = await issue(s2, 'browser-file');
    expect(await statusOf(() => s2.svc.walletResult({ planId: p2.id, outcome: 'hash', txHash: `0x${'55'.repeat(32)}` }))).toBe(409);
  });
  it('a plan that was never issued → 409; an unknown plan → 404', async () => {
    const s = setup();
    const p = s.seed();
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw: '0x02' }))).toBe(409);
    expect(await statusOf(s.svc.relaySigned({ planId: 'nope', via: 'browser-file', raw: '0x02' }))).toBe(404);
  });
  it('a second relay after a hash → 409 (never resent)', async () => {
    const s = setup();
    const { p, tx } = await issue(s, 'browser-file');
    const raw = await signTx(tx!);
    await s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw });
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw }))).toBe(409);
    expect(s.relayed).toHaveLength(1);
  });
});

describe('walletResult told "rejected" twice (the first answer lost on the way)', () => {
  it('the repeat → the same signed plan again, nothing changed, and the plan still sends', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-wallet');
    const first = s.svc.walletResult({ planId: p.id, outcome: 'rejected' });
    const again = s.svc.walletResult({ planId: p.id, outcome: 'rejected' });
    expect([again.state, again.id, first.state, p.send, p.signedOp !== null]).toEqual(['signed', p.id, 'signed', null, true]);
    const { p: reissued } = await issue(s, 'browser-wallet', p.id);
    expect(reissued.state).toBe('sending');
  });
  it('only "rejected" repeats: a hash or no-hash on a signed plan with no send → 409', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-wallet');
    s.svc.walletResult({ planId: p.id, outcome: 'rejected' });
    expect([await statusOf(() => s.svc.walletResult({ planId: p.id, outcome: 'hash', txHash: `0x${'55'.repeat(32)}` })), await statusOf(() => s.svc.walletResult({ planId: p.id, outcome: 'no-hash' }))]).toEqual([409, 409]);
  });
  it('"rejected" after a hash (sent) or on a discarded plan → 409 (that is not the same fact)', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-wallet');
    s.svc.walletResult({ planId: p.id, outcome: 'hash', txHash: `0x${'55'.repeat(32)}` });
    const gone = s.seed('plan-b');
    gone.state = 'discarded';
    expect([await statusOf(() => s.svc.walletResult({ planId: p.id, outcome: 'rejected' })), await statusOf(() => s.svc.walletResult({ planId: gone.id, outcome: 'rejected' }))]).toEqual([409, 409]);
  });
});

describe('relaySigned (native-signer)', () => {
  it('asks the native signer for exactly the issued tx and relays its bytes', async () => {
    const s = setup({ native: nativeFrom() });
    const { p, tx } = await issue(s, 'native-signer');
    const r = await s.svc.relaySigned({ planId: p.id, via: 'native-signer' });
    expect(s.nativeCalls).toEqual([{ chainId: DEP.chainId, from: GAS_WALLET, to: getAddress(DEP.entryPoint), data: tx!.data, nonce: GAS_NONCE, gas: OUTER_GAS, maxFeePerGas: FEES.maxFeePerGas, maxPriorityFeePerGas: FEES.maxPriorityFeePerGas }]);
    expect([r.relay.outcome, p.state]).toEqual(['hash', 'sent']);
  });
  it('a payer change while the native signer is signing → 409, the signed bytes are never relayed, plan discarded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sign = nativeFrom();
    const s = setup({ native: async (tx) => (await gate, sign(tx)) });
    const { p } = await issue(s, 'native-signer');
    const relaying = s.svc.relaySigned({ planId: p.id, via: 'native-signer' });
    await new Promise((r) => setTimeout(r, 10));
    expect(s.svc.payerChanged({ reason: 'mode' })).toEqual({ voided: 1 });
    release();
    expect(await statusOf(relaying)).toBe(409);
    expect([s.relayed, p.state]).toEqual([[], 'discarded']);
  });
  it('a native refusal → 409 and the plan goes back to signed with nothing relayed', async () => {
    const s = setup({ native: async () => ({ ok: false, reason: 'the signer is locked' }) });
    const { p } = await issue(s, 'native-signer');
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'native-signer' }))).toBe(409);
    expect([p.state, p.send]).toEqual(['signed', null]);
    expect(s.relayed).toEqual([]);
  });
  it('KSS-06: a coded refusal (keystore-changed) reaches the page as the answer’s kind; nothing relayed', async () => {
    const s = setup({ native: async () => ({ ok: false, reason: 'the keystore file changed after its address was confirmed; open it again', code: 'keystore-changed' }) });
    const { p } = await issue(s, 'native-signer');
    const e = await s.svc.relaySigned({ planId: p.id, via: 'native-signer' }).then(() => null, (x: unknown) => x as { status: number; kind: unknown });
    expect([e?.status, e?.kind, s.relayed]).toEqual([409, 'keystore-changed', []]);
  });
  it('a native signer using another key → 422, nothing relayed', async () => {
    const s = setup({ native: nativeFrom(otherKey) });
    const { p } = await issue(s, 'native-signer');
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'native-signer' }))).toBe(422);
    expect(s.relayed).toEqual([]);
  });
  it('no native signer bound → 503, the plan still awaits', async () => {
    const s = setup();
    const { p } = await issue(s, 'native-signer');
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'native-signer' }))).toBe(503);
    expect(p.state).toBe('sending');
  });
});

describe('signerAborted', () => {
  it('an awaiting relay send → back to signed, send cleared', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-file');
    s.svc.signerAborted({ planId: p.id });
    expect([p.state, p.send]).toEqual(['signed', null]);
  });
  it('a browser-wallet send → 409 (the wallet answers through walletResult)', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-wallet');
    expect(await statusOf(() => s.svc.signerAborted({ planId: p.id }))).toBe(409);
  });
  it('told twice (the first answer lost on the way) → the same signed plan again, nothing changed', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-file');
    const first = s.svc.signerAborted({ planId: p.id });
    const again = s.svc.signerAborted({ planId: p.id });
    expect([again.state, again.id, p.state, p.send, p.signedOp !== null]).toEqual(['signed', first.id, 'signed', null, true]);
    // The same plan sends again afterwards: the repeat did not consume anything.
    const { p: reissued } = await issue(s, 'browser-file', p.id);
    expect(reissued.state).toBe('sending');
  });
  it('a signed plan with no send → that plan (nothing to undo); discarded / sent → 409; unknown plan → 404', async () => {
    const s = setup();
    const p = s.seed();
    expect(s.svc.signerAborted({ planId: p.id }).state).toBe('signed');
    const gone = s.seed('plan-b');
    gone.state = 'discarded';
    const { p: sent, tx } = await issue(s, 'browser-file', 'plan-c');
    await s.svc.relaySigned({ planId: sent.id, via: 'browser-file', raw: await signTx(tx!) });
    expect([await statusOf(() => s.svc.signerAborted({ planId: gone.id })), await statusOf(() => s.svc.signerAborted({ planId: sent.id })), await statusOf(() => s.svc.signerAborted({ planId: 'nope' }))]).toEqual([409, 409, 404]);
  });
  it('while its signed bytes are being relayed → 409, and the relay result stands', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ relay: async (raw) => (await gate, { outcome: 'hash', txHash: keccak256(raw) }) });
    const { p, tx } = await issue(s, 'browser-file');
    const relaying = s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw: await signTx(tx!) });
    await new Promise((r) => setTimeout(r, 10));
    expect(await statusOf(() => s.svc.signerAborted({ planId: p.id }))).toBe(409);
    release();
    await relaying;
    expect(p.state).toBe('sent');
  });
});

describe('payerChanged / void', () => {
  it('voids an awaiting relay-via plan (discarded, nothing reached the relay) and counts it', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-file');
    expect(s.svc.payerChanged({ reason: 'file-key' })).toEqual({ voided: 1 });
    expect([p.state, p.send, p.signedOp]).toEqual(['discarded', null, null]);
    expect(p.discardReason).toMatch(/gas payer changed \(file-key\).*no signed transaction had reached the relay/);
  });
  it('a relay after payerChanged → 409 (the plan is gone from sending)', async () => {
    const s = setup();
    const { p, tx } = await issue(s, 'browser-file');
    s.svc.payerChanged({ reason: 'mode' });
    expect(await statusOf(s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw: await signTx(tx!) }))).toBe(409);
    expect(s.relayed).toEqual([]);
  });
  it('voids a signed (unsent) plan to discarded', () => {
    const s = setup();
    const p = s.seed();
    s.svc.payerChanged({});
    expect([p.state, p.signedOp]).toEqual(['discarded', null]);
  });
  it('a browser-wallet send awaiting the wallet turns unknown (it may be on chain)', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-wallet');
    s.svc.payerChanged({ reason: 'provider' });
    expect([p.state, p.send?.outcome]).toEqual(['unknown', 'no-hash']);
  });
  it('a relay-via plan whose bytes are being relayed turns unknown, not discarded', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup({ relay: async (raw) => (await gate, { outcome: 'no-hash', reason: 'timeout' }) });
    const { p, tx } = await issue(s, 'browser-file');
    const relaying = s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw: await signTx(tx!) });
    await new Promise((r) => setTimeout(r, 10));
    s.svc.payerChanged({ reason: 'mode' });
    expect(p.state).toBe('unknown');
    release();
    await relaying;
    expect(p.state).toBe('unknown');
  });
  it('a sent plan is left alone and not counted', async () => {
    const s = setup();
    const { p, tx } = await issue(s, 'browser-file');
    await s.svc.relaySigned({ planId: p.id, via: 'browser-file', raw: await signTx(tx!) });
    expect(s.svc.payerChanged({})).toEqual({ voided: 0 });
    expect(p.state).toBe('sent');
  });
  it('an unsafe reason string is replaced by "changed"', async () => {
    const s = setup();
    const p = s.seed();
    s.svc.payerChanged({ reason: 'Evil <script>' });
    expect(p.discardReason).toMatch(/\(changed\)/);
  });
  it('discard() of an awaiting, non-busy relay-via plan → discarded with nothing sent', async () => {
    const s = setup();
    const { p } = await issue(s, 'native-signer');
    s.svc.discard({ planId: p.id });
    expect([p.state, p.send]).toEqual(['discarded', null]);
  });
  it.each(['browser-file', 'native-signer'] as const)('regression: %s relay arriving after the 10 min window → 409, discarded, nothing relayed or natively signed', async (via) => {
    const s = setup({ native: nativeFrom() });
    const { p, tx } = await issue(s, via);
    const raw = via === 'browser-file' ? await signTx(tx!) : undefined;
    s.clock.advance(10 * 60 * 1000 + 1);
    await expect(s.svc.relaySigned({ planId: p.id, via, raw })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/expired.*nothing was sent/) });
    expect([p.state, p.send, p.signedOp, s.relayed.length, s.nativeCalls.length]).toEqual(['discarded', null, null, 0, 0]);
  });
  it('regression: the window closing while the native signer waits for the user → its bytes are dropped, nothing relayed', async () => {
    let s!: ReturnType<typeof setup>;
    s = setup({ native: async (tx) => (s.clock.advance(10 * 60 * 1000 + 1), nativeFrom()(tx)) });
    const { p } = await issue(s, 'native-signer');
    await expect(s.svc.relaySigned({ planId: p.id, via: 'native-signer' })).rejects.toMatchObject({ status: 409 });
    expect([p.state, p.send, s.nativeCalls.length, s.relayed.length]).toEqual(['discarded', null, 1, 0]);
  });
  it('plan expiry (10 min) while awaiting a relay signature → discarded on the next read', async () => {
    const s = setup();
    const { p } = await issue(s, 'browser-file');
    s.clock.advance(10 * 60 * 1000 + 1);
    s.svc.plan(p.id);
    expect([p.state, p.send]).toEqual(['discarded', null]);
  });
});
