// M3 transfer flow end to end on the offline SYNTHETIC testchain: two synthetic Coinbase Smart Wallet
// v1.1 accounts (throwaway P-256 owners at different owner indexes), real diagnosis, real fork previews
// (execution-only + twin), real Passkey-format signatures from the synthetic keys, the exact signed
// simulation, a send through the "EIP-1193 wallet" (anvil's dev account here), and stateless tracking.
// Covers nonces 0, 1 and > 1, "finish one, then the next", a nonce race, wallet rejection, no-hash,
// inner failure, revert, a dropped block, and the Terminal hand-off claim. No network, no real keys.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatUnits, getAddress, type Address, type Hex } from 'viem';
import { hexToBytes } from '../../src/crypto/bytes';
import { diagnose, type KnownAccount } from '../../server/diagnose';
import { ForkManager } from '../../server/fork';
import { startForkProxy, type ForkProxy } from '../../server/forkProxy';
import { HttpError } from '../../server/http';
import { Reader } from '../../server/reader';
import { track, type TrackResult } from '../../server/track';
import { feeSummary, HANDOFF_TTL_MS, PLAN_TTL_MS, TransferService } from '../../server/transfer';
import { createUpstream } from '../../server/upstream';
import { addressDigest, addressShort, recipientDigest, recipientShort } from '../../src/transfer/intent';
import { buildAssertion, type SyntheticKey } from '../fixtures/synthetic';
import { DEP, startWorld, TOKEN, type SynthAccount, type World } from '../support/world';

const RCPT: Address = getAddress('0x5a000000000000000000000000000000000c0c03');
const RCPT2: Address = getAddress('0x5a000000000000000000000000000000000c0c04');
const XPL = 10n ** 18n;
const ADDR_OWNER: Hex = `0x${'0'.repeat(24)}5a0000000000000000000000000000000000ad01`;

let w: World;
let proxy: ForkProxy;
let reader: Reader;
let forks: ForkManager;
const accounts = new Map<Address, KnownAccount>();
let svc: TransferService;
let A: SynthAccount; // passkey at index 0, address owner at index 1
let B: SynthAccount; // address owner at 0, passkeys at 1 and 2

type Plan = { id: string; state: string; intentHash: Hex; userOpHash: Hex; op: { nonce: string | bigint }; tracking: Record<string, unknown> | null; reserveWei: bigint; prefundWei: bigint };
const status = (p: Promise<unknown>) => p.then(() => 0, (e: unknown) => (e instanceof HttpError ? e.status : -1));
const errOf = (p: Promise<unknown>) => p.then(() => '', (e: unknown) => (e instanceof Error ? e.message : String(e)));

async function know(a: SynthAccount) {
  const r = await diagnose(reader, forks, w.infra, { account: a.address });
  if (!r.known) throw new Error(`diagnosis refused: ${r.diagnosis.blockers.join('; ')}`);
  accounts.set(r.known.address, r.known);
  return r.diagnosis;
}

const sign = (plan: Plan, key: SyntheticKey) => buildAssertion({ challenge: hexToBytes(plan.userOpHash), kind: 'userop', key }).json;

async function previewSigned(s: TransferService, a: SynthAccount, ownerIndex: number, asset: string, amount: string, recipient: Address = RCPT) {
  const plan = (await s.preview({ source: a.address, recipient, asset, amount, gasWallet: w.gasWallet, ownerIndex })) as unknown as Plan;
  const signed = (await s.submitSignature({ planId: plan.id, intentHash: plan.intentHash, assertion: sign(plan, a.keys.get(ownerIndex)!) })) as unknown as Plan;
  return signed;
}

/** The browser's EIP-1193 path: send-request → the wallet sends exactly `tx` → report the hash. */
async function sendViaWallet(s: TransferService, plan: Plan) {
  const r = (await s.sendRequest({ planId: plan.id, intentHash: plan.intentHash })) as unknown as { plan: Plan; tx: { from: Address; to: Address; data: Hex; gas: Hex } };
  expect(getAddress(r.tx.from)).toBe(w.gasWallet);
  const txHash = await w.send({ to: r.tx.to, data: r.tx.data, gas: BigInt(r.tx.gas) });
  const after = (await s.walletResult({ planId: plan.id, outcome: 'hash', txHash })) as unknown as Plan;
  return { txHash, plan: after, tx: r.tx };
}

const trackPlan = async (p: Plan, cursor?: bigint): Promise<TrackResult> => track(reader, { record: p.tracking!, ...(cursor === undefined ? {} : { scanCursor: cursor.toString() }) });
const tokenBal = async (a: Address) => BigInt(await w.tc.rpc<Hex>('eth_call', [{ to: TOKEN.id, data: `0x70a08231${a.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']));
const nativeBal = async (a: Address) => BigInt(await w.tc.rpc<Hex>('eth_getBalance', [a, 'latest']));

beforeAll(async () => {
  w = await startWorld();
  const up = createUpstream({ url: w.tc.url, source: 'testchain', resolve: { allowLocal: true } });
  reader = new Reader(up, { expectedGenesis: null, deployment: DEP });
  proxy = await startForkProxy(up);
  forks = new ForkManager({ anvilBin: 'anvil', upstreamProxyUrl: proxy.url, hardfork: 'prague' });
  svc = new TransferService(reader, forks, w.infra, accounts);
  A = await w.account({ passkeys: [{ index: 0, seed: 0x31 }], others: [{ index: 1, bytes: ADDR_OWNER }], nonce: 0n });
  B = await w.account({ passkeys: [{ index: 1, seed: 0x32 }, { index: 2, seed: 0x33 }], others: [{ index: 0, bytes: ADDR_OWNER }], nonce: 7n });
  await w.fundNative(A.address, 5n * XPL);
  await w.fundToken(A.address, 100_000_000n);
  await w.fundNative(B.address, 3n * XPL);
  await w.fundToken(B.address, 50_000_000n);
  await know(A);
  await know(B);
}, 120_000);
afterAll(async () => {
  await proxy?.close();
  await w?.tc.stop();
});

describe('diagnosis of synthetic accounts', () => {
  it('reads owners from the chain and lists the Passkey owners with their indexes', async () => {
    const d = await know(B);
    expect(d.supported).toBe(true);
    expect(d.passkeyOwners.map((o) => o.index)).toEqual([1, 2]);
    expect(d.blockers).toEqual([]);
  });
  it('preview with an owner index that is not a Passkey is refused; a Passkey index is accepted', async () => {
    expect(await status(svc.preview({ source: B.address, recipient: RCPT, asset: 'native', amount: '0.1', gasWallet: w.gasWallet, ownerIndex: 0 }))).toBe(400);
    expect(await status(svc.preview({ source: B.address, recipient: RCPT, asset: 'native', amount: '0.1', gasWallet: w.gasWallet, ownerIndex: 2 }))).toBe(0);
  }, 120_000);
});

describe('fee summary (network fee shown apart from the wallet prefund)', () => {
  it('before signing the network figure is a ceiling; after the signed simulation it is the exact gas limit', async () => {
    const draft = await svc.preview({ source: B.address, recipient: RCPT, asset: 'native', amount: '0.01', gasWallet: w.gasWallet, ownerIndex: 1 });
    const f0 = feeSummary(draft as never);
    expect(f0.networkFinal).toBe(false);
    expect(f0.walletMaxWei).toBe((draft as unknown as Plan).prefundWei);
    const plan = draft as unknown as Plan;
    const signed = await svc.submitSignature({ planId: plan.id, intentHash: plan.intentHash, assertion: sign(plan, B.keys.get(1)!) });
    const f1 = feeSummary(signed as never);
    const sim = (signed as unknown as { signedSim: { success: boolean; outerGasLimit: bigint }; fees: { maxFeePerGas: bigint } });
    expect([f1.networkFinal, f1.networkGasLimit]).toEqual([true, sim.signedSim.outerGasLimit]);
    expect(f1.networkMaxWei).toBe(sim.signedSim.outerGasLimit * sim.fees.maxFeePerGas);
    await svc.discard({ planId: plan.id });
  }, 180_000);

  it('a network fee cap that rose after review issues nothing; the plan shows the new cap and the next send uses it', async () => {
    const draft = (await svc.preview({ source: B.address, recipient: RCPT, asset: 'native', amount: '0.01', gasWallet: w.gasWallet, ownerIndex: 1 })) as unknown as Plan & { fees: { maxFeePerGas: bigint } };
    const signed = (await svc.submitSignature({ planId: draft.id, intentHash: draft.intentHash, assertion: sign(draft, B.keys.get(1)!) })) as unknown as Plan & { fees: { maxFeePerGas: bigint } };
    const shown = signed.fees.maxFeePerGas;
    const blk = await w.tc.rpc<{ baseFeePerGas: Hex }>('eth_getBlockByNumber', ['latest', false]);
    await w.tc.rpc('anvil_setNextBlockBaseFeePerGas', [`0x${(BigInt(blk.baseFeePerGas) * 4n + 10n ** 10n).toString(16)}`]);
    await w.mine(1);
    type Req = { plan: Plan & { state: string; fees: { maxFeePerGas: bigint } }; tx: { maxFeePerGas: Hex } | null; feeRaised?: { maxFeePerGas: bigint } };
    const r1 = (await svc.sendRequest({ planId: signed.id, intentHash: signed.intentHash, shownMaxFeePerGas: shown.toString() })) as unknown as Req;
    expect([r1.tx, r1.plan.state]).toEqual([null, 'signed']);
    expect(r1.plan.fees.maxFeePerGas > shown).toBe(true);
    expect(feeSummary(svc.plan(signed.id) as never).networkMaxWei).toBe((svc.plan(signed.id) as unknown as { signedSim: { outerGasLimit: bigint } }).signedSim.outerGasLimit * r1.plan.fees.maxFeePerGas);
    // Confirming the new figure issues the transaction at that cap.
    const r2 = (await svc.sendRequest({ planId: signed.id, intentHash: signed.intentHash, shownMaxFeePerGas: r1.plan.fees.maxFeePerGas.toString() })) as unknown as Req;
    expect(BigInt(r2.tx!.maxFeePerGas)).toBe(r1.plan.fees.maxFeePerGas);
    await svc.walletResult({ planId: signed.id, outcome: 'rejected' });
    await svc.discard({ planId: signed.id });
  }, 180_000);

  it('a network maximum that rose through the gas limit alone (same price) issues nothing; the shown maximum issues', async () => {
    const draft = (await svc.preview({ source: B.address, recipient: RCPT, asset: 'native', amount: '0.01', gasWallet: w.gasWallet, ownerIndex: 1 })) as unknown as Plan;
    const signed = (await svc.submitSignature({ planId: draft.id, intentHash: draft.intentHash, assertion: sign(draft, B.keys.get(1)!) })) as unknown as Plan & { fees: { maxFeePerGas: bigint }; feeSummary: { networkMaxWei: bigint } };
    const price = signed.fees.maxFeePerGas.toString();
    type Req = { plan: Plan & { state: string }; tx: { gas: Hex; maxFeePerGas: Hex } | null; feeRaised?: { networkMaxWei: bigint; shownNetworkMaxWei: bigint } };
    // The user saw a maximum one wei below what the send now needs (as after a costlier execution path).
    const now = feeSummary(svc.plan(signed.id) as never).networkMaxWei;
    const r1 = (await svc.sendRequest({ planId: signed.id, intentHash: signed.intentHash, shownMaxFeePerGas: price, shownNetworkMaxWei: (now - 1n).toString() })) as unknown as Req;
    expect([r1.tx, r1.plan.state]).toEqual([null, 'signed']);
    expect(r1.feeRaised!.networkMaxWei > r1.feeRaised!.shownNetworkMaxWei).toBe(true);
    // Confirming the figure now shown issues the transaction, within it.
    const shownNow = feeSummary(svc.plan(signed.id) as never).networkMaxWei;
    const r2 = (await svc.sendRequest({ planId: signed.id, intentHash: signed.intentHash, shownMaxFeePerGas: price, shownNetworkMaxWei: shownNow.toString() })) as unknown as Req;
    expect(BigInt(r2.tx!.gas) * BigInt(r2.tx!.maxFeePerGas) <= shownNow).toBe(true);
    await svc.walletResult({ planId: signed.id, outcome: 'rejected' });
    await svc.discard({ planId: signed.id });
  }, 180_000);
});

describe('send and track, nonce 0 → 1 → 2 on account A, then account B independently', () => {
  it('A nonce 0: token transfer, exact precision, confirmed then final', async () => {
    const before = await tokenBal(RCPT);
    const p = await previewSigned(svc, A, 0, TOKEN.id, '12.345678');
    expect([p.state, String(p.op.nonce)]).toEqual(['signed', '0']);
    const { plan } = await sendViaWallet(svc, p);
    expect(plan.state).toBe('sent');
    expect((await tokenBal(RCPT)) - before).toBe(12_345_678n);
    const t1 = await trackPlan(plan);
    expect([t1.state, t1.receipt?.amount, t1.receipt?.symbol]).toEqual(['confirmed', '12.345678', TOKEN.symbol]);
    await w.mine(DEP.finalityDepth);
    expect((await trackPlan(plan)).state).toBe('final');
    // A sidecar restart: a brand-new upstream + Reader that never saw this plan tracks it from the record alone.
    const fresh = new Reader(createUpstream({ url: w.tc.url, source: 'testchain', resolve: { allowLocal: true } }), { expectedGenesis: null, deployment: DEP });
    const t2 = await track(fresh, { record: JSON.parse(JSON.stringify(plan.tracking)) });
    expect([t2.state, t2.receipt?.amount]).toEqual(['final', '12.345678']);
  }, 180_000);


  it('A nonce 1: the next preview reads the live nonce (no 0/1 cap), native transfer', async () => {
    const before = await nativeBal(RCPT);
    const p = await previewSigned(svc, A, 0, 'native', '0.75');
    expect(String(p.op.nonce)).toBe('1');
    await sendViaWallet(svc, p);
    expect((await nativeBal(RCPT)) - before).toBe(750_000_000_000_000_000n);
  }, 180_000);

  it('A nonce 2 (> 1): a third transfer to another recipient', async () => {
    const p = await previewSigned(svc, A, 0, TOKEN.id, '1', RCPT2);
    expect(String(p.op.nonce)).toBe('2');
    const { plan } = await sendViaWallet(svc, p);
    expect((await trackPlan(plan)).state).toBe('confirmed');
    expect(await tokenBal(RCPT2)).toBe(1_000_000n);
  }, 180_000);

  it('B signs with owner index 2; its own nonce starts at 0 regardless of A', async () => {
    const p = await previewSigned(svc, B, 2, 'native', '0.5');
    expect(String(p.op.nonce)).toBe('0');
    const { plan } = await sendViaWallet(svc, p);
    expect((await trackPlan(plan)).state).toBe('confirmed');
  }, 180_000);

  it('B nonce 1 with the other Passkey (index 1): a signature from index 2 is refused for an index-1 plan', async () => {
    const plan = (await svc.preview({ source: B.address, recipient: RCPT, asset: TOKEN.id, amount: '3', gasWallet: w.gasWallet, ownerIndex: 1 })) as unknown as Plan;
    expect(String(plan.op.nonce)).toBe('1');
    expect(await status(svc.submitSignature({ planId: plan.id, intentHash: plan.intentHash, assertion: sign(plan, B.keys.get(2)!) }))).toBe(422);
    const ok = (await svc.submitSignature({ planId: plan.id, intentHash: plan.intentHash, assertion: sign(plan, B.keys.get(1)!) })) as unknown as Plan;
    expect(ok.state).toBe('signed');
    await sendViaWallet(svc, ok);
  }, 180_000);
});

describe('fees and reserve', () => {
  it('the native reserve covers the missing prefund: the maximum available native is balance − reserve', async () => {
    const p = (await svc.preview({ source: A.address, recipient: RCPT, asset: 'native', amount: '0.01', gasWallet: w.gasWallet, ownerIndex: 0 })) as unknown as Plan;
    // EntryPoint v0.6 keeps unused prefund as the account's deposit, so after A's earlier sends the
    // reserve is exactly the prefund the deposit does not cover.
    const deposit = BigInt(await w.tc.rpc<Hex>('eth_call', [{ to: DEP.entryPoint, data: `0x70a08231${A.address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']));
    expect(deposit).toBeGreaterThan(0n);
    expect(BigInt(p.reserveWei)).toBe(BigInt(p.prefundWei) > deposit ? BigInt(p.prefundWei) - deposit : 0n);
    // Exactly balance − reserve is the maximum; one wei more is refused (exact decimal, no float rounding).
    const max = (await nativeBal(A.address)) - BigInt(p.reserveWei);
    await svc.discard({ planId: p.id });
    expect(await errOf(svc.preview({ source: A.address, recipient: RCPT, asset: 'native', amount: formatUnits(max + 1n, 18), gasWallet: w.gasWallet, ownerIndex: 0 }))).toMatch(/fee reserve|insufficient|needs/);
    const ok = (await svc.preview({ source: A.address, recipient: RCPT, asset: 'native', amount: formatUnits(max, 18), gasWallet: w.gasWallet, ownerIndex: 0 })) as unknown as Plan;
    expect(ok.state).toBe('previewed');
    await svc.discard({ planId: ok.id });
  }, 180_000);

  it('an account holding less XPL than the provisional draft prefund but enough for the final op previews and signs (the twin is funded for measurement)', async () => {
    // The final op's reserve, measured on A (same owner layout); the draft uses 2M verification gas at ≥ 1 gwei.
    const probe = (await svc.preview({ source: A.address, recipient: RCPT, asset: TOKEN.id, amount: '1', gasWallet: w.gasWallet, ownerIndex: 0 })) as unknown as Plan;
    await svc.discard({ planId: probe.id });
    const op = probe.op as unknown as { callGasLimit: string; verificationGasLimit: string; preVerificationGas: string; maxFeePerGas: string };
    // The provisional draft: the same call gas and fee cap, 2M verification gas, 100k pre-verification gas.
    const draftPrefund = (BigInt(op.callGasLimit) + 2_000_000n + 100_000n) * BigInt(op.maxFeePerGas);
    const low = BigInt(probe.prefundWei) + (draftPrefund - BigInt(probe.prefundWei)) / 4n;
    expect([BigInt(op.verificationGasLimit) < 2_000_000n, low > BigInt(probe.prefundWei), low < draftPrefund]).toEqual([true, true, true]);
    const D = await w.account({ passkeys: [{ index: 0, seed: 0x34 }], others: [{ index: 1, bytes: ADDR_OWNER }], nonce: 3n });
    await w.fundNative(D.address, low);
    await w.fundToken(D.address, 5_000_000n);
    await know(D);
    const p = await previewSigned(svc, D, 0, TOKEN.id, '1');
    expect(p.state).toBe('signed');
    expect(BigInt(p.reserveWei) <= low).toBe(true);
    await svc.discard({ planId: p.id });
  }, 180_000);
});

describe('interruptions never resend and never call unknown a failure', () => {
  it('two concurrent send requests for one signature → exactly one transaction is issued', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    const both = await Promise.allSettled([svc.sendRequest({ planId: p.id, intentHash: p.intentHash }), svc.sendRequest({ planId: p.id, intentHash: p.intentHash })]);
    const issued = both.filter((x) => x.status === 'fulfilled' && (x.value as { tx: unknown }).tx);
    expect(issued).toHaveLength(1);
    expect(both.filter((x) => x.status === 'rejected').map((x) => ((x as PromiseRejectedResult).reason as { status: number }).status)).toEqual([409]);
    expect((svc.plan(p.id) as { state: string }).state).toBe('sending');
    await svc.walletResult({ planId: p.id, outcome: 'rejected' });
    svc.discard({ planId: p.id });
  }, 180_000);

  it('native XPL to the gas wallet itself passes the signed simulation (outer fee and beneficiary refund set apart)', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01', w.gasWallet);
    expect(p.state).toBe('signed');
    svc.discard({ planId: p.id });
  }, 180_000);

  it('wallet rejection returns the plan to signed; a second send request is then allowed once', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    await svc.sendRequest({ planId: p.id, intentHash: p.intentHash });
    expect(await status(svc.sendRequest({ planId: p.id, intentHash: p.intentHash }))).toBe(409); // never twice while awaiting
    const back = (await svc.walletResult({ planId: p.id, outcome: 'rejected' })) as unknown as Plan;
    expect(back.state).toBe('signed');
    await sendViaWallet(svc, back);
  }, 180_000);

  it('wallet error without a hash → unknown; the event scan then finds the op and confirms it', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.02');
    const r = (await svc.sendRequest({ planId: p.id, intentHash: p.intentHash })) as unknown as { tx: { to: Address; data: Hex; gas: Hex } };
    await w.send({ to: r.tx.to, data: r.tx.data, gas: BigInt(r.tx.gas) }); // it did go out
    const u = (await svc.walletResult({ planId: p.id, outcome: 'no-hash' })) as unknown as Plan;
    expect(u.state).toBe('unknown');
    const t = await trackPlan(u);
    expect(t.state).toBe('confirmed');
    expect(t.detail).toMatch(/event scan/);
  }, 180_000);

  it('a nonce race (another plan ran first) voids the plan at send time instead of sending a stale op', async () => {
    const other = new TransferService(reader, forks, w.infra, accounts);
    const mine = await previewSigned(svc, A, 0, 'native', '0.03');
    const theirs = await previewSigned(other, A, 0, 'native', '0.04');
    expect(String(mine.op.nonce)).toBe(String(theirs.op.nonce));
    await sendViaWallet(other, theirs);
    expect(await errOf(svc.sendRequest({ planId: mine.id, intentHash: mine.intentHash }))).toMatch(/nonce/);
    expect(((await svc.discard({ planId: mine.id })) as unknown as Plan).state).toBe('discarded');
  }, 240_000);

  it('a changed intent hash is refused at send time', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    expect(await status(svc.sendRequest({ planId: p.id, intentHash: `0x${'00'.repeat(32)}` }))).toBe(409);
    await svc.discard({ planId: p.id });
  }, 180_000);

  it('inner failure: the token balance drops after the send request → mined, but tracked as inner-failed', async () => {
    const p = await previewSigned(svc, B, 1, TOKEN.id, '2');
    const r = (await svc.sendRequest({ planId: p.id, intentHash: p.intentHash })) as unknown as { tx: { to: Address; data: Hex; gas: Hex } };
    await w.fundToken(B.address, 0n);
    const txHash = await w.send({ to: r.tx.to, data: r.tx.data, gas: BigInt(r.tx.gas) });
    const plan = (await svc.walletResult({ planId: p.id, outcome: 'hash', txHash })) as unknown as Plan;
    expect((await trackPlan(plan)).state).toBe('inner-failed');
    await w.fundToken(B.address, 50_000_000n);
  }, 180_000);

  it('the same handleOps sent twice: the reported second one reverted, but the scan finds the op executed by the first → confirmed', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    const { plan, tx } = await sendViaWallet(svc, p);
    const dup = await w.send({ to: tx.to, data: tx.data, gas: BigInt(tx.gas) });
    const viaDup = await trackPlan({ ...plan, tracking: { ...plan.tracking!, txHash: dup } });
    expect(viaDup.state).toBe('confirmed');
    expect(viaDup.detail).toMatch(/different transaction/);
    expect((await trackPlan(plan)).state).toBe('confirmed');
  }, 180_000);

  it('a reverted outer transaction that did not run the op stays tracked (nonce unchanged); the op later executed elsewhere is then found', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    const r = (await svc.sendRequest({ planId: p.id, intentHash: p.intentHash })) as unknown as { tx: { to: Address; data: Hex; gas: Hex } };
    // Out of gas just above the calldata floor (EIP-7623: 10 gas per token, a non-zero byte is 4 tokens):
    // valid and mined, but far below what validation needs, so it reverts and the UserOp never runs.
    const bytes = hexToBytes(r.tx.data);
    const floor = 21_000n + bytes.reduce((a, b) => a + (b === 0 ? 10n : 40n), 0n);
    expect(floor + 2_000n < BigInt(r.tx.gas)).toBe(true);
    const oog = await w.send({ to: r.tx.to, data: r.tx.data, gas: floor + 2_000n });
    const plan = (await svc.walletResult({ planId: p.id, outcome: 'hash', txHash: oog })) as unknown as Plan;
    const t1 = await trackPlan(plan);
    expect([t1.state, t1.nonceNow]).toEqual(['reverted', BigInt(p.op.nonce)]);
    // The same signed handleOps, sent again with enough gas, executes the op: tracking the reported (reverted) hash finds it.
    await w.send({ to: r.tx.to, data: r.tx.data, gas: BigInt(r.tx.gas) });
    const t2 = await trackPlan(plan);
    expect([t2.state, t2.nonceNow]).toEqual(['confirmed', BigInt(p.op.nonce) + 1n]);
  }, 180_000);

  it('a reported tx still pending in the pool while another tx already executed the op → the scan finds it: confirmed, not pending', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    const r = (await svc.sendRequest({ planId: p.id, intentHash: p.intentHash })) as unknown as { tx: { to: Address; data: Hex; gas: Hex } };
    // The wallet's transaction waits in the pool behind a nonce gap: known to the RPC, never mined.
    const gwNonce = BigInt(await w.tc.rpc<Hex>('eth_getTransactionCount', [w.gasWallet, 'latest']));
    const stuck = await w.tc.rpc<Hex>('eth_sendTransaction', [{ from: w.gasWallet, to: r.tx.to, data: r.tx.data, gas: r.tx.gas, nonce: '0x' + (gwNonce + 1n).toString(16) }]);
    const plan = (await svc.walletResult({ planId: p.id, outcome: 'hash', txHash: stuck })) as unknown as Plan;
    const t1 = await trackPlan(plan);
    expect([t1.state, t1.scan?.complete]).toEqual(['pending', true]);
    // Any bundler may submit the same signed handleOps: here an unrelated account does, and it is mined.
    const other: Address = getAddress('0x5a000000000000000000000000000000000c0c09');
    await w.tc.rpc('anvil_impersonateAccount', [other]);
    await w.fundNative(other, XPL);
    try {
      const h = await w.tc.rpc<Hex>('eth_sendTransaction', [{ from: other, to: r.tx.to, data: r.tx.data, gas: r.tx.gas }]);
      for (let i = 0; i < 200 && !(await w.tc.rpc<unknown>('eth_getTransactionReceipt', [h])); i++) await new Promise((res) => setTimeout(res, 25));
      const t2 = await trackPlan(plan);
      expect([t2.state, t2.txHash]).toEqual(['confirmed', h]);
      expect(t2.detail).toMatch(/different transaction/);
    } finally {
      await w.tc.rpc('anvil_dropTransaction', [stuck]);
      await w.tc.rpc('anvil_stopImpersonatingAccount', [other]);
    }
  }, 180_000);

  it('a dropped block (chain rolled back) is pending, not failed; the signed op stays executable', async () => {
    const snap = await w.tc.rpc<Hex>('evm_snapshot');
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    const { plan } = await sendViaWallet(svc, p);
    expect((await trackPlan(plan)).state).toBe('confirmed');
    await w.tc.rpc('evm_revert', [snap]);
    await w.mine(2);
    const t = await trackPlan(plan);
    expect(['pending', 'unknown', 'reorged']).toContain(t.state);
    expect(t.state).not.toBe('reverted');
  }, 180_000);

  it('the tracking record keeps the recipient only as digest + short form; the receipt names it from the mined op; a wrong digest is a mismatch', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    const { plan } = await sendViaWallet(svc, p);
    const text = JSON.stringify(plan.tracking).toLowerCase();
    expect(text).not.toContain(RCPT.slice(2).toLowerCase());
    expect(plan.tracking!.intent).toMatchObject({ recipientHash: recipientDigest(RCPT), recipientShort: recipientShort(RCPT) });
    const t = await trackPlan(plan);
    expect([t.state, t.receipt?.recipient]).toEqual(['confirmed', RCPT]);
    const wrong = { ...plan, tracking: { ...plan.tracking!, intent: { ...(plan.tracking!.intent as object), recipientHash: recipientDigest(RCPT2) } } };
    expect((await trackPlan(wrong)).state).toBe('mismatch');
    // No full address at rest; the page may add the account it is checking for one request — only if it matches.
    for (const a of [A.address, w.gasWallet]) expect(text).not.toContain(a.slice(2).toLowerCase());
    expect(await status(track(reader, { record: plan.tracking!, sender: B.address }))).toBe(400);
    expect(await status(track(reader, { record: plan.tracking!, sender: A.address, gasWallet: w.gasWallet }))).toBe(0);
  }, 180_000);

  it('no hash and no event: unknown; a scan longer than one call returns a cursor and resumes (never failure)', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    const head = BigInt(await w.tc.rpc<Hex>('eth_blockNumber'));
    // Without a send request the browser has no tracking record yet; build the same shape the UI keeps.
    const record = { format: 'cbpr-track-v1', chainId: DEP.chainId, deploymentId: DEP.id, userOpHash: p.userOpHash, senderHash: addressDigest(A.address), senderShort: addressShort(A.address), nonce: String(p.op.nonce), intent: { recipientHash: recipientDigest(RCPT), recipientShort: recipientShort(RCPT), asset: 'native', amount: '10000000000000000' }, gasWalletHash: addressDigest(w.gasWallet), gasWalletNonce: null, inputHash: null, txHash: null, fromBlock: head.toString() };
    // A small scan budget (3 chunks × 20 blocks per call, the production limit is 25 × 2000) so the chain
    // stays short: mining 50,010 blocks on anvil grew superlinearly past the timeout. The behaviour is the
    // same — one call cannot cover the range, returns a cursor, and the next call resumes there.
    const budget = { chunks: 3, range: 20n };
    // The search starts 64 blocks below the record's block (reorg margin; 0 on a short chain). Mine until the
    // range from that floor to the head is 90 blocks: the first call covers 60 and stops, the second covers
    // the remaining 30 and completes.
    const floor = head > 64n ? head - 64n : 0n;
    await w.mine(Number(floor + 89n - head));
    const t1 = await track(reader, { record }, budget);
    expect([t1.state, t1.scan?.complete]).toEqual(['unknown', false]);
    // The cursor is exactly where the third chunk ended: three chunks of 20 from the search floor.
    expect(t1.scan!.cursor).toBe(floor + 60n);
    expect(t1.scan!.cursor <= t1.scan!.head).toBe(true);
    const t2 = await track(reader, { record, scanCursor: t1.scan!.cursor.toString() }, budget);
    expect([t2.state, t2.scan?.complete]).toEqual(['unknown', true]);
    // Never a failure, and nothing was sent while tracking.
    for (const t of [t1, t2]) expect(t.state).not.toBe('reverted');
    await svc.discard({ planId: p.id });
  }, 240_000);
});

describe('send and hand-off only after the exact signed simulation passed', () => {
  it('a previewed (unsigned) plan can be neither sent nor handed off', async () => {
    const p = (await svc.preview({ source: A.address, recipient: RCPT, asset: 'native', amount: '0.01', gasWallet: w.gasWallet, ownerIndex: 0 })) as unknown as Plan;
    expect(p.state).toBe('previewed');
    expect(await status(svc.sendRequest({ planId: p.id, intentHash: p.intentHash }))).toBe(409);
    expect(await status(svc.handoff({ planId: p.id, intentHash: p.intentHash }))).toBe(409);
    svc.discard({ planId: p.id });
  }, 180_000);

  it('a signature whose signed simulation fails (gas wallet cannot pay) → sim-failed: no send, no hand-off', async () => {
    const funded = await nativeBal(w.gasWallet);
    await w.tc.rpc('anvil_setBalance', [w.gasWallet, '0x3e8']); // 1000 wei: far below gas × max fee
    await w.mine(1); // forks start from a mined block
    try {
      const p = await previewSigned(svc, A, 0, 'native', '0.01');
      expect(p.state).toBe('sim-failed');
      expect(await status(svc.sendRequest({ planId: p.id, intentHash: p.intentHash }))).toBe(409);
      expect(await status(svc.handoff({ planId: p.id, intentHash: p.intentHash }))).toBe(409);
      svc.discard({ planId: p.id });
    } finally {
      await w.tc.rpc('anvil_setBalance', [w.gasWallet, '0x' + funded.toString(16)]);
      await w.mine(1);
    }
  }, 180_000);
});

describe('Terminal hand-off', () => {
  it('issues a one-time code; the claim returns the signed op once; the plan can no longer be sent from the browser', async () => {
    const p = await previewSigned(svc, A, 0, 'native', '0.01');
    const h = (await svc.handoff({ planId: p.id, intentHash: p.intentHash })) as { code: string; plan: Plan };
    expect(h.code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(await status(svc.sendRequest({ planId: p.id, intentHash: p.intentHash }))).toBe(409);
    expect(await status(Promise.resolve().then(() => svc.claim({ code: 'AAAAA-AAAAA' })))).toBe(404);
    const c = svc.claim({ code: h.code.toLowerCase() }) as { op: { nonce: string; signature: Hex }; ownerIndex: number; gasWallet: Address };
    expect([c.ownerIndex, c.gasWallet, c.op.nonce]).toEqual([0, w.gasWallet, String(p.op.nonce)]);
    expect(await status(Promise.resolve().then(() => svc.claim({ code: h.code })))).toBe(404);
    expect((svc.plan(p.id) as { state: string }).state).toBe('unknown');
  }, 180_000);
  it('a code claimed after the plan 10-minute window ended is refused (410) and the unclaimed plan is discarded; the code never outlives the plan', async () => {
    const clock = { t: Date.now(), now() { return this.t; } };
    const timed = new TransferService(reader, forks, w.infra, accounts, clock);
    const p = await previewSigned(timed, A, 0, 'native', '0.01');
    clock.t += PLAN_TTL_MS - 60_000; // one minute of the plan left: the 2-minute code is cut to it
    const h = (await timed.handoff({ planId: p.id, intentHash: p.intentHash })) as { code: string; plan: { validUntil: number; handoff: { expiresAt: number } } };
    expect(h.plan.handoff.expiresAt).toBe(h.plan.validUntil);
    expect(h.plan.handoff.expiresAt < clock.t + HANDOFF_TTL_MS).toBe(true);
    clock.t = h.plan.validUntil + 1; // past both deadlines
    expect(await status(Promise.resolve().then(() => timed.claim({ code: h.code })))).toBe(410);
    expect((timed.plan(p.id) as { state: string }).state).toBe('discarded');
  }, 180_000);
});

describe('large EntryPoint deposit', () => {
  it('an account whose deposit exceeds the measurement funder’s former fixed 1000 XPL still previews (the twin copies the whole deposit)', async () => {
    const funder: Address = getAddress('0x5a000000000000000000000000000000000c0c0a');
    const big = 1_001n * XPL;
    await w.tc.rpc('anvil_impersonateAccount', [funder]);
    await w.fundNative(funder, big + XPL);
    const h = await w.tc.rpc<Hex>('eth_sendTransaction', [{ from: funder, to: DEP.entryPoint, data: `0xb760faf9${A.address.slice(2).toLowerCase().padStart(64, '0')}`, value: '0x' + big.toString(16), gas: '0x30d40' }]);
    for (let i = 0; i < 200 && !(await w.tc.rpc<unknown>('eth_getTransactionReceipt', [h])); i++) await new Promise((res) => setTimeout(res, 25));
    const deposit = BigInt(await w.tc.rpc<Hex>('eth_call', [{ to: DEP.entryPoint, data: `0x70a08231${A.address.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest']));
    expect(deposit > 1_000n * XPL).toBe(true);
    const p = (await svc.preview({ source: A.address, recipient: RCPT, asset: 'native', amount: '0.01', gasWallet: w.gasWallet, ownerIndex: 0 })) as unknown as Plan;
    expect([p.state, BigInt(p.reserveWei)]).toEqual(['previewed', 0n]);
    await svc.discard({ planId: p.id });
  }, 180_000);
});
