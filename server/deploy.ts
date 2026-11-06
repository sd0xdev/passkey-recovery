// Deployment plan for a diagnosed account (M3). Steps come only from the pinned bytecode registry
// (implementation, factory) and createAccount(owners, nonce) re-encoded from verified evidence; a step
// whose target already holds the expected code is skipped (state, never a receipt, decides). The plan is
// simulated on a fork from a synthetic sender and the fork's end state must verify (code hashes, slot,
// owners) before any step is offered. The user's own EIP-1193 gas wallet sends each step after its
// confirmation; the sidecar never signs or broadcasts. A step's outcome is verified statelessly from
// its tx hash: exact (from, to, input, value, chainId), receipt success, then code at the target.
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import type { SupportedDeployment } from '../src/config/registry';
import { createAccountCalldata } from '../src/wallet/derive';
import type { InfraStep } from './bytecodeRegistry';
import type { KnownAccount } from './diagnose';
import type { ForkManager } from './fork';
import { HttpError } from './http';
import type { Reader } from './reader';
import { assertP256Parity, feePolicy, forkStateView, PREVIEW_SENDER, simulateDeploy, type Fees } from './sim';
import { deploymentVerdict } from './state';

export type DeployKey = 'implementation' | 'factory' | 'account';

export interface DeployStep {
  key: DeployKey;
  to: Address;
  data: Hex;
  inputHash: Hex;
  creates: Address;
  /** keccak256 of the runtime code the target must hold afterwards. */
  expectCodeHash: Hex;
}

export function deploySteps(dep: SupportedDeployment, infra: InfraStep[], acct: KnownAccount): DeployStep[] {
  const infraSteps = infra.map((s) => ({ key: s.target as DeployKey, to: s.to, data: s.data, inputHash: keccak256(s.data), creates: s.creates, expectCodeHash: dep.codeHash[s.target] }));
  if (!acct.derivation) return infraSteps;
  const data = createAccountCalldata(acct.derivation.owners, acct.derivation.nonce).toLowerCase() as Hex;
  return [...infraSteps, { key: 'account', to: getAddress(dep.factory), data, inputHash: keccak256(data), creates: acct.address, expectCodeHash: dep.codeHash.walletProxy }];
}

export interface DeployPlanStep extends DeployStep {
  state: 'done' | 'needed';
  gasLimit: bigint | null;
  gasUsedOnFork: bigint | null;
  maxCostWei: bigint | null;
}

export async function planDeploy(reader: Reader, forks: ForkManager, infra: InfraStep[], acct: KnownAccount, gasWallet: Address | null) {
  const dep = reader.dep;
  const snap = await reader.snapshot(acct.address, { gasWallet });
  const expectedOwners = acct.derivation?.owners;
  const v = deploymentVerdict(dep, snap, snap.accountCode ? expectedOwners : undefined);
  if (v.stops.length) throw new HttpError(409, `deployment stop: ${v.stops.map((s) => s.detail).join('; ')}`);
  const all = deploySteps(dep, infra, acct);
  const isDone = (s: DeployStep) => (s.key === 'account' ? v.targets.account === 'present' : v.targets[s.key] === 'present');
  const needed = all.filter((s) => !isDone(s));
  // Without creation evidence there is no account step at all, so "nothing needed" would read as complete:
  // the latest snapshot itself must show the account deployed (it may have vanished in a reorg since the
  // check that found it).
  if (v.targets.account !== 'present' && !acct.derivation) throw new HttpError(409, 'the account is not deployed and no derivation evidence is known');
  const fees: Fees = feePolicy(snap.baseFee, snap.priorityFee);
  const sim = needed.length === 0 ? [] : await forks.run(snap, async (f) => {
    f.guard({ wallets: [acct.address], entryPoint: dep.entryPoint, gasWallet });
    await assertP256Parity(f, snap.p256Probe);
    const r = await simulateDeploy(f, needed.map((s) => ({ key: s.key, to: s.to, data: s.data })), PREVIEW_SENDER, { synthetic: true, fees });
    const after = deploymentVerdict(dep, await forkStateView(f, dep, acct.address), expectedOwners);
    if (!after.complete) throw new HttpError(502, `fork deployment did not verify: ${after.stops.map((s) => s.detail).join('; ') || 'incomplete'}`);
    return r;
  });
  const steps: DeployPlanStep[] = all.map((s) => {
    const i = needed.indexOf(s);
    const g = i >= 0 ? sim[i]! : null;
    return { ...s, state: i >= 0 ? 'needed' : 'done', gasLimit: g?.gasLimit ?? null, gasUsedOnFork: g?.gasUsed ?? null, maxCostWei: g ? g.gasLimit * fees.maxFeePerGas : null };
  });
  const totalMaxCostWei = steps.reduce((a, s) => a + (s.maxCostWei ?? 0n), 0n);
  return {
    account: acct.address,
    block: snap.block,
    fees,
    steps,
    totalMaxCostWei,
    gasWallet: snap.gasWallet,
    gasWalletSufficient: snap.gasWallet ? snap.gasWallet.balance >= totalMaxCostWei : null,
    complete: needed.length === 0,
    label: 'preview: fork at the current block, synthetic sender, end state verified on the fork',
  };
}

export type StepVerdict =
  | { state: 'not-found'; detail: string }
  | { state: 'mismatch'; detail: string }
  | { state: 'pending'; detail: string }
  | { state: 'reverted'; detail: string; block: bigint }
  | { state: 'confirmed-no-code'; detail: string; block: bigint }
  | { state: 'confirmed'; detail: string; block: bigint; gasUsed: bigint; confirmations: bigint };

/** Stateless: from a tx hash and the step it claims to be. */
export async function verifyDeployStep(reader: Reader, step: DeployStep, from: Address, txHash: Hex): Promise<StepVerdict> {
  const tx = await reader.tx(txHash);
  if (!tx) return { state: 'not-found', detail: 'the RPC does not know this hash (not broadcast yet, dropped or replaced)' };
  const diffs: string[] = [];
  if (typeof tx.from !== 'string' || getAddress(tx.from) !== getAddress(from)) diffs.push('from');
  if (typeof tx.to !== 'string' || getAddress(tx.to) !== getAddress(step.to)) diffs.push('to');
  if (typeof tx.input !== 'string' || keccak256(tx.input.toLowerCase() as Hex) !== step.inputHash) diffs.push('input');
  if (typeof tx.value !== 'string' || BigInt(tx.value) !== 0n) diffs.push('value');
  if (typeof tx.chainId === 'string' && BigInt(tx.chainId) !== BigInt(reader.dep.chainId)) diffs.push('chainId');
  if (diffs.length) return { state: 'mismatch', detail: `transaction differs from the step in: ${diffs.join(', ')}` };
  const r = await reader.receipt(txHash);
  if (!r) return { state: 'pending', detail: 'known to the RPC, not mined yet' };
  const block = BigInt(r.blockNumber as string);
  if (r.status !== '0x1') return { state: 'reverted', detail: 'receipt status is failure (the fee was spent; nothing was deployed)', block };
  const head = await reader.head();
  const code = await reader.code(step.creates, toHex(head.number));
  if (code === null || code.toLowerCase() !== step.expectCodeHash.toLowerCase()) return { state: 'confirmed-no-code', detail: 'mined, but the expected code is not at the target (reorg, or the step was a no-op) — re-check before continuing', block };
  return { state: 'confirmed', detail: 'mined, receipt success, expected code at the target', block, gasUsed: BigInt(r.gasUsed as string), confirmations: head.number - block + 1n };
}
