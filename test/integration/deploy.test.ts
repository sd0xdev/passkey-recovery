// M3 deployment flow on the offline SYNTHETIC testchain, starting from a chain where neither the v1.1
// implementation nor the factory exists (only the EntryPoint and the Safe singleton factory): diagnosis
// from owners + creation nonce evidence, a fork-verified plan, each step sent by the "EIP-1193 wallet"
// (anvil's dev account) and verified from its hash, verified steps skipped on re-plan, a duplicate
// step reported as reverted, and a mismatching or unknown hash never counted as done.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bytesToHex, toHex, type Address, type Hex } from 'viem';
import { planDeploy, verifyDeployStep, type DeployPlanStep } from '../../server/deploy';
import { runDeploy, type SignerDeps } from '../../server/signer/core';
import { confirmationPhrase } from '../../server/signer/checks';
import { diagnose, type KnownAccount } from '../../server/diagnose';
import { ForkManager, type Fork } from '../../server/fork';
import { startForkProxy, type ForkProxy } from '../../server/forkProxy';
import { HttpError } from '../../server/http';
import { Reader } from '../../server/reader';
import { createUpstream } from '../../server/upstream';
import { deriveAddress } from '../../src/wallet/derive';
import { syntheticGasWallet } from '../fixtures/keystore';
import { syntheticKey } from '../fixtures/synthetic';
import { DEP, startWorld, type World } from '../support/world';

const ADDR_OWNER: Hex = `0x${'0'.repeat(24)}5a0000000000000000000000000000000000ad02`;
const CREATION_NONCE = 3n;

let w: World;
let proxy: ForkProxy;
let reader: Reader;
let forks: ForkManager;
let owners: Hex[];
let account: Address;
let known: KnownAccount;

const status = (p: Promise<unknown>) => p.then(() => 0, (e: unknown) => (e instanceof HttpError ? e.status : -1));
const evidence = () => ({ owners, nonce: CREATION_NONCE.toString() });
const plan = () => planDeploy(reader, forks, w.infra, known, w.gasWallet);
const sendStep = (s: DeployPlanStep) => w.send({ to: s.to, data: s.data, gas: s.gasLimit! });

beforeAll(async () => {
  w = await startWorld({ deployInfra: false });
  const up = createUpstream({ url: w.tc.url, source: 'testchain', resolve: { allowLocal: true } });
  reader = new Reader(up, { expectedGenesis: null, deployment: DEP });
  proxy = await startForkProxy(up);
  forks = new ForkManager({ anvilBin: 'anvil', upstreamProxyUrl: proxy.url, hardfork: 'prague' });
  owners = [ADDR_OWNER, bytesToHex(syntheticKey(0x41).publicKeyXY)];
  account = deriveAddress(DEP, owners, CREATION_NONCE);
}, 120_000);
afterAll(async () => {
  await proxy?.close();
  await w?.tc.stop();
});

describe('deployment from an empty chain, one wallet-confirmed step at a time', () => {
  it('without evidence the counterfactual account cannot be planned; with owners + nonce it derives', async () => {
    const bare = await diagnose(reader, forks, w.infra, { account });
    expect(bare.known).toBeNull();
    expect(bare.diagnosis.blockers.join(' ')).toMatch(/evidence/);
    // Missing evidence is the only stop, so the page can word it as one more input (PM-03), not a refusal.
    expect(bare.diagnosis.needsEvidence).toBe(true);
    expect(await status(diagnose(reader, forks, w.infra, { account, evidence: { owners, nonce: '4' } }))).toBe(0);
    const wrong = await diagnose(reader, forks, w.infra, { account, evidence: { owners, nonce: '4' } });
    expect(wrong.known).toBeNull(); // nonce 4 derives a different address
    expect(wrong.diagnosis.needsEvidence).toBe(false); // evidence was given and is wrong: a stop, not a missing input
    const r = await diagnose(reader, forks, w.infra, { account, evidence: evidence() });
    expect([r.diagnosis.derivation?.localMatch, r.diagnosis.needs]).toEqual([true, ['implementation', 'factory', 'account']]);
    // Both derivations agree: local CREATE2 and factory.getAddress, on a fork that replays the registry infra.
    expect([r.diagnosis.derivation?.factoryMatch, r.diagnosis.derivation?.factoryCheckedOn]).toEqual([true, 'fork']);
    known = r.known!;
    expect(known.address).toBe(account);
  }, 180_000);

  it('missing evidence alongside another blocker is a stop, not a one-input continuation (PM-03)', async () => {
    const entryPoint = await w.tc.rpc<Hex>('eth_getCode', [DEP.entryPoint, 'latest']);
    try {
      await w.tc.setCode(DEP.entryPoint, '0x');
      const r = await diagnose(reader, forks, w.infra, { account });
      expect(r.known).toBeNull();
      expect(r.diagnosis.blockers).toHaveLength(2); // infrastructure + evidence
      expect(r.diagnosis.needsEvidence).toBe(false);
    } finally {
      await w.tc.setCode(DEP.entryPoint, entryPoint);
    }
    expect((await diagnose(reader, forks, w.infra, { account })).diagnosis.needsEvidence).toBe(true);
  }, 180_000);

  it('the plan simulates all three steps on a fork and verifies the end state; nothing is sent', async () => {
    const p = await plan();
    expect(p.steps.map((s) => [s.key, s.state])).toEqual([['implementation', 'needed'], ['factory', 'needed'], ['account', 'needed']]);
    expect(p.steps.every((s) => s.gasLimit! > 0n && s.maxCostWei! > 0n)).toBe(true);
    expect(p.gasWalletSufficient).toBe(true);
    expect(await reader.code(account, toHex((await reader.head()).number))).toBeNull();
  }, 180_000);

  it('step 1 sent and verified from its hash; the re-plan skips it; a second identical send reverts', async () => {
    const s1 = (await plan()).steps[0]!;
    const h1 = await sendStep(s1);
    expect((await verifyDeployStep(reader, s1, w.gasWallet, h1)).state).toBe('confirmed');
    const again = await plan();
    expect(again.steps.map((s) => s.state)).toEqual(['done', 'needed', 'needed']);
    expect(again.steps[0]!.gasLimit).toBeNull();
    const dup = await w.send({ to: s1.to, data: s1.data, gas: s1.gasLimit! });
    expect((await verifyDeployStep(reader, s1, w.gasWallet, dup)).state).toBe('reverted');
  }, 180_000);

  it('a hash for a different step is a mismatch, an unknown hash is not-found, a wrong sender is a mismatch', async () => {
    const p = await plan();
    const [s1, s2] = [p.steps[0]!, p.steps[1]!];
    const h2 = await sendStep(s2);
    expect((await verifyDeployStep(reader, s1, w.gasWallet, h2)).state).toBe('mismatch');
    expect((await verifyDeployStep(reader, s2, '0x5a00000000000000000000000000000000000001', h2)).state).toBe('mismatch');
    expect((await verifyDeployStep(reader, s2, w.gasWallet, `0x${'ab'.repeat(32)}`)).state).toBe('not-found');
    expect((await verifyDeployStep(reader, s2, w.gasWallet, h2)).state).toBe('confirmed');
  }, 180_000);

  it('the last step deploys the account; the plan is complete and diagnosis now reads the owners from the chain', async () => {
    const s3 = (await plan()).steps[2]!;
    expect((await verifyDeployStep(reader, s3, w.gasWallet, await sendStep(s3))).state).toBe('confirmed');
    const done = await plan();
    expect([done.complete, done.totalMaxCostWei]).toEqual([true, 0n]);
    const d = await diagnose(reader, forks, w.infra, { account });
    expect([d.diagnosis.supported, d.diagnosis.needs, d.diagnosis.passkeyOwners.map((o) => o.index)]).toEqual([true, [], [1]]);
  }, 180_000);
});

describe('both derivations must agree before evidence is accepted', () => {
  it('local CREATE2 matches but factory.getAddress (on chain) disagrees → refused; the honest factory → accepted', async () => {
    const other = deriveAddress(DEP, owners, 9n); // not deployed; the factory is on chain by now
    const honest = await diagnose(reader, forks, w.infra, { account: other, evidence: { owners, nonce: '9' } });
    expect([honest.diagnosis.derivation?.localMatch, honest.diagnosis.derivation?.factoryMatch, honest.diagnosis.derivation?.factoryCheckedOn]).toEqual([true, true, 'chain']);
    // Same chain, but the factory's answer is another address (a substituted or misbehaving factory).
    const lying = Object.create(reader) as Reader;
    lying.readCall = (c: Parameters<Reader['readCall']>[0], tag: Hex) => (c.kind === 'factoryGetAddress' ? Promise.resolve(`0x${'0'.repeat(24)}${'5a'.repeat(20)}` as Hex) : reader.readCall(c, tag));
    const r = await diagnose(lying, forks, w.infra, { account: other, evidence: { owners, nonce: '9' } });
    expect([r.known, r.diagnosis.derivation?.localMatch, r.diagnosis.derivation?.factoryMatch]).toEqual([null, true, false]);
    expect(r.diagnosis.blockers.join(' ')).toMatch(/does not derive this account/);
  }, 180_000);
});

describe('deployment known without creation evidence', () => {
  it('an account accepted as deployed whose code is gone at the next snapshot (a reorg) is never reported complete; while deployed it is', async () => {
    // Infra is deployed by the earlier tests; `account` is deployed too. `vanished` has no code: it stands for
    // the same account after a reorg removed its creation, known only from a diagnosis that found it deployed.
    const present: KnownAccount = { ...known, derivation: null, deployed: true };
    expect((await planDeploy(reader, forks, w.infra, present, w.gasWallet)).complete).toBe(true);
    const vanished: KnownAccount = { ...present, address: deriveAddress(DEP, owners, CREATION_NONCE + 101n) };
    expect(await status(planDeploy(reader, forks, w.infra, vanished, w.gasWallet))).toBe(409);
  }, 180_000);
});

describe('fork binding', () => {
  it('a fork runs only on the snapshot’s block hash: the same height with another hash (a reorg since the snapshot) is refused', async () => {
    const head = await w.tc.rpc<{ number: Hex; hash: Hex }>('eth_getBlockByNumber', ['latest', false]);
    const at = { block: BigInt(head.number), blockHash: head.hash };
    expect(await forks.run(at, async (f) => f.block)).toBe(at.block);
    const other = `0x${(BigInt(head.hash) ^ 1n).toString(16).padStart(64, '0')}` as Hex;
    await expect(forks.run({ ...at, blockHash: other }, async () => 'ran')).rejects.toThrow(/different hash than the snapshot/);
  }, 180_000);
});

describe('Terminal deploy re-derives its step and verifies every simulation', () => {
  // A SYNTHETIC gas wallet (throwaway keystore + fake op) on the offline testchain. The account step is
  // planned while the factory exists; what changes during the confirmation decides whether anything is
  // signed: a createAccount call to an address without code returns a successful receipt and creates
  // nothing, so neither "still absent" nor a passing simulation alone may let it through.
  const run = async (n: bigint, during: () => Promise<void>, opts: { forkHidesAccount?: boolean } = {}) => {
    const g = syntheticGasWallet();
    await w.fundNative(g.address, 10n ** 20n);
    const target = deriveAddress(DEP, owners, n);
    let hide = false;
    // After the confirmation, the fork reports no code at the account (a simulation that creates nothing).
    const hiding = {
      run: (at: Parameters<ForkManager['run']>[0], job: (f: Fork) => Promise<unknown>) =>
        forks.run(at, (f) => job(hide ? new Proxy(f, { get: (o, k, r) => (k === 'code' ? async (a: Address) => (a === target ? '0x' : o.code(a)) : Reflect.get(o, k, r)) }) : f)),
    } as unknown as ForkManager;
    const nonceOf = async () => BigInt(await w.tc.rpc<Hex>('eth_getTransactionCount', [g.address, 'latest']));
    const d: SignerDeps = {
      up: createUpstream({ url: w.tc.url, source: 'testchain', resolve: { allowLocal: true } }),
      reader,
      forks: opts.forkHidesAccount ? hiding : forks,
      infra: w.infra,
      op: { readPassword: async () => g.password },
      manifest: g.manifest,
      claim: async () => ({}),
      receiptTimeoutMs: 5_000,
      io: {
        print: () => undefined,
        ask: async () => {
          await during();
          hide = !!opts.forkHidesAccount;
          return confirmationPhrase('deploy', { step: 'account', nonce: await nonceOf() });
        },
      },
    };
    const outcome = await runDeploy(d, target, { owners, nonce: n.toString() }).then((r) => r, (e: Error) => e);
    return { outcome, txCount: await nonceOf(), code: await w.tc.rpc<Hex>('eth_getCode', [target, 'latest']) };
  };

  it('the factory removed during the confirmation (a reorg): the account step is no longer next → refused, nothing signed or sent', async () => {
    const factoryCode = await w.tc.rpc<Hex>('eth_getCode', [DEP.factory, 'latest']);
    try {
      const r = await run(CREATION_NONCE + 301n, () => w.tc.setCode(DEP.factory, '0x'));
      expect(r.outcome).toBeInstanceOf(Error);
      expect((r.outcome as Error).message).toMatch(/chain state changed since the plan/);
      expect([r.txCount, r.code]).toEqual([0n, '0x']);
    } finally {
      await w.tc.setCode(DEP.factory, factoryCode);
    }
  }, 180_000);

  it('a fresh simulation whose end state lacks the account code is refused before signing; an honest run deploys and verifies', async () => {
    const r = await run(CREATION_NONCE + 302n, async () => undefined, { forkHidesAccount: true });
    expect(r.outcome).toBeInstanceOf(Error);
    expect((r.outcome as Error).message).toMatch(/fork simulation did not create the expected code/);
    expect([r.txCount, r.code]).toEqual([0n, '0x']);
    const ok = await run(CREATION_NONCE + 303n, async () => undefined);
    expect([ok.outcome, ok.txCount, ok.code !== '0x']).toEqual(['sent', 1n, true]);
  }, 180_000);
});
