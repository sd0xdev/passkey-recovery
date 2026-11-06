// Terminal signer flows (tech spec §5, M3: optional advanced path beside the browser wallet). One
// transaction per confirmation: check → fork simulation from the gas wallet → full summary → the user
// types the exact phrase → unlock the key → re-read fresh state and re-simulate → sign → broadcast →
// verify. There is no --yes and no unattended path: `ask` is the user's TTY. Everything is parameterised
// by the account the user names and the supported deployment; nothing here knows a particular wallet.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { getAddress, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { assetOf } from '../../src/config/registry';
import { formatUnits, parseIntent, type TransferIntent } from '../../src/transfer/intent';
import type { UserOperationV06 } from '../../src/userop/hash';
import type { InfraStep } from '../bytecodeRegistry';
import { deploySteps, planDeploy, verifyDeployStep, type StepVerdict } from '../deploy';
import { diagnose } from '../diagnose';
import type { ForkManager } from '../fork';
import type { Reader } from '../reader';
import { assertP256Parity, feePolicy, forkStateView, handleOpsData, maxSignatureBytes, simulateDeploy, simulateSigned, type Fees } from '../sim';
import { deploymentVerdict } from '../state';
import { buildTrackRecord, track, type TrackResult } from '../track';
import type { Upstream } from '../upstream';
import { broadcastRaw } from './broadcast';
import { checkOuter, checkTransferOp, confirmationPhrase, parseClaimedOp, SignerCheckError } from './checks';
import { decryptKeystore, keyHex } from './keystore';
import type { OpAdapter } from './op';

export interface Io {
  print(line: string): void;
  ask(question: string): Promise<string>;
}

export interface GasManifest {
  address: Address;
  chainId: number;
  keystore: string;
  passwordReference: string;
  keystoreSha256: string;
}

export interface SignerDeps {
  up: Upstream;
  reader: Reader;
  forks: ForkManager;
  infra: InfraStep[];
  op: OpAdapter;
  io: Io;
  manifest: GasManifest;
  /** Fetches the claimed plan from the sidecar with the typed one-time code. */
  claim(code: string): Promise<unknown>;
  receiptTimeoutMs?: number;
}

export function loadManifest(path: string, chainId: number): GasManifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Partial<GasManifest>;
  if (typeof m.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(m.address)) throw new SignerCheckError('manifest address malformed');
  if (m.chainId !== chainId) throw new SignerCheckError(`manifest chainId is not ${chainId}`);
  if (typeof m.keystore !== 'string' || typeof m.passwordReference !== 'string' || typeof m.keystoreSha256 !== 'string') throw new SignerCheckError('manifest incomplete');
  return { ...(m as GasManifest), address: getAddress(m.address) };
}

/** Loads the encrypted keystore, checks file mode and pinned sha256, decrypts via op, checks the address. */
export async function unlock(d: SignerDeps): Promise<{ address: Address; sign: (tx: Parameters<ReturnType<typeof privateKeyToAccount>['signTransaction']>[0]) => Promise<Hex>; wipe: () => void }> {
  const st = statSync(d.manifest.keystore);
  if ((st.mode & 0o077) !== 0) throw new SignerCheckError('keystore file must be mode 0600');
  const text = readFileSync(d.manifest.keystore, 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== d.manifest.keystoreSha256.toLowerCase()) throw new SignerCheckError('keystore sha256 differs from the manifest');
  let password: string | null = await d.op.readPassword(d.manifest.passwordReference);
  const pk = await decryptKeystore(text, password);
  password = null;
  const account = privateKeyToAccount(keyHex(pk));
  if (getAddress(account.address) !== getAddress(d.manifest.address)) {
    pk.fill(0);
    throw new SignerCheckError('decrypted key does not belong to the manifest address');
  }
  return { address: account.address, sign: (tx) => account.signTransaction(tx), wipe: () => pk.fill(0) };
}

const fmtNative = (d: SignerDeps, wei: bigint) => `${formatUnits(wei, 18)} ${d.reader.dep.assets.find((a) => a.native)!.symbol}`;

async function waitFor<T extends { state: string }>(fn: () => Promise<T>, timeoutMs: number, io: Io, waiting: string[]): Promise<T> {
  const until = Date.now() + timeoutMs;
  let v = await fn();
  while (waiting.includes(v.state) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 2000));
    v = await fn();
  }
  if (waiting.includes(v.state)) io.print(`Not settled yet (${v.state}). Do not resend; track it later in the browser or with this tool.`);
  return v;
}

async function confirm(io: Io, phrase: string): Promise<boolean> {
  io.print('');
  io.print(`To confirm, type exactly: ${phrase}`);
  io.print('(anything else cancels; nothing is signed)');
  return (await io.ask('> ')).trim() === phrase;
}

function gasSummary(d: SignerDeps, gas: bigint, fees: Fees, balance: bigint) {
  d.io.print(`  gas limit        ${gas}`);
  d.io.print(`  maxFeePerGas     ${fees.maxFeePerGas} wei   maxPriorityFeePerGas ${fees.maxPriorityFeePerGas} wei`);
  d.io.print(`  maximum fee      ${fmtNative(d, gas * fees.maxFeePerGas)} (actual = gasUsed × (baseFee + priority), usually far lower)`);
  d.io.print(`  gas wallet       ${fmtNative(d, balance)}`);
}

/** Deploys the next missing step for `account` (one per run). Owners come from the chain or from `evidence`. */
export async function runDeploy(d: SignerDeps, account: Address, evidence?: Record<string, unknown>): Promise<'sent' | 'nothing-to-do' | 'cancelled'> {
  const gw = d.manifest.address;
  const dep = d.reader.dep;
  const { diagnosis, known } = await diagnose(d.reader, d.forks, d.infra, { account, evidence });
  if (!known) throw new SignerCheckError(`stop: ${diagnosis.blockers.join('; ') || 'account not supported'}`);
  const plan = await planDeploy(d.reader, d.forks, d.infra, known, gw);
  const step = plan.steps.find((s) => s.state === 'needed');
  if (!step) {
    d.io.print('Deployment complete and verified (code hashes, implementation slot, owners). Nothing to do.');
    return 'nothing-to-do';
  }
  const owners = known.derivation?.owners;
  const all = deploySteps(dep, d.infra, known);
  // The step to send is re-derived from each snapshot, never carried over: a step whose prerequisite
  // vanished since the plan (a reorg removing the factory) is no longer the next one, and sending it
  // would pay gas for a call that creates nothing.
  const nextStep = (s: typeof snap) => {
    const v = deploymentVerdict(dep, s, s.accountCode ? owners : undefined);
    if (v.stops.length) throw new SignerCheckError(`stop: ${v.stops.map((x) => x.detail).join('; ')}`);
    return all.find((x) => v.targets[x.key] !== 'present')?.key ?? null;
  };
  const changed = 'chain state changed since the plan (step done elsewhere, a prerequisite gone, or nonce moved); nothing signed — run again';
  const snap = await d.reader.snapshot(account, { gasWallet: gw });
  if (nextStep(snap) !== step.key) throw new SignerCheckError(changed);
  const nonce = snap.gasWallet!.nonce;
  const balance = snap.gasWallet!.balance;
  const fees = feePolicy(snap.baseFee, snap.priorityFee);
  // Each simulation must leave the step's target holding the expected code (and, for the account, the
  // verified implementation slot and owners) on the fork; a successful receipt alone proves nothing.
  const sim = async (s: typeof snap) =>
    d.forks.run(s, async (f) => {
      f.guard({ wallets: [account], entryPoint: dep.entryPoint, gasWallet: gw });
      await assertP256Parity(f, s.p256Probe);
      const [r] = await simulateDeploy(f, [{ key: step.key, to: step.to, data: step.data }], gw, { synthetic: false, fees });
      const after = deploymentVerdict(dep, await forkStateView(f, dep, account), owners);
      if (after.targets[step.key] !== 'present') throw new SignerCheckError(`fork simulation did not create the expected code at ${step.creates}; nothing signed`);
      if (step.key === 'account' && !after.complete) throw new SignerCheckError(`fork: the account does not verify after creation: ${after.stops.map((x) => x.detail).join('; ') || 'incomplete'}; nothing signed`);
      return r!;
    });
  const a = await sim(snap);
  checkOuter(a.gasLimit, fees.maxFeePerGas, balance);
  d.io.print(`${dep.chainName} chainId ${dep.chainId} · block ${snap.block}`);
  d.io.print(`Deployment step: ${step.key}`);
  d.io.print(`  from             ${gw} (your gas wallet)`);
  d.io.print(`  to               ${step.to}`);
  d.io.print(`  value            0`);
  d.io.print(`  data             ${(step.data.length - 2) / 2} bytes (${step.key === 'account' ? 'createAccount from verified evidence' : 'pinned bytecode registry'})`);
  d.io.print(`  creates          ${step.creates}`);
  d.io.print(`  tx nonce         ${nonce}`);
  gasSummary(d, a.gasLimit, fees, balance);
  d.io.print(`  fork simulation  success, gasUsed ${a.gasUsed}; the created code (and owners) verified on the fork`);
  if (!(await confirm(d.io, confirmationPhrase('deploy', { step: step.key, nonce })))) {
    d.io.print('Cancelled; nothing signed.');
    return 'cancelled';
  }
  const key = await unlock(d);
  try {
    const fresh = await d.reader.snapshot(account, { gasWallet: gw });
    if (nextStep(fresh) !== step.key || fresh.gasWallet!.nonce !== nonce) throw new SignerCheckError(changed);
    const b = await sim(fresh);
    if (b.gasLimit > a.gasLimit) throw new SignerCheckError('the fresh simulation needs more gas than you confirmed; nothing signed — run again');
    const raw = await key.sign({ type: 'eip1559', chainId: dep.chainId, nonce: Number(nonce), to: step.to, data: step.data, value: 0n, gas: a.gasLimit, ...fees });
    key.wipe();
    const hash = await broadcastRaw(d.up, raw);
    d.io.print(`Sent: ${hash}`);
    const real = all.find((s) => s.key === step.key)!;
    const r: StepVerdict = await waitFor(() => verifyDeployStep(d.reader, real, gw, hash), d.receiptTimeoutMs ?? 180_000, d.io, ['pending', 'not-found']);
    d.io.print(`Result: ${r.state} (${r.detail})`);
    return 'sent';
  } finally {
    key.wipe();
  }
}

/** Sends one transfer the browser prepared and handed over with a one-time code. */
export async function runSend(d: SignerDeps): Promise<'sent' | 'cancelled'> {
  const gw = d.manifest.address;
  const dep = d.reader.dep;
  const code = (await d.io.ask('One-time hand-off code shown in the browser: ')).trim();
  const claimed = (await d.claim(code)) as { op?: unknown; userOpHash?: unknown; intent?: Record<string, unknown>; ownerIndex?: unknown; gasWallet?: unknown };
  if (typeof claimed.gasWallet !== 'string' || getAddress(claimed.gasWallet) !== gw) throw new SignerCheckError('the plan was prepared for another gas wallet (the beneficiary is bound into the transaction): preview again with this signer\'s address');
  const ci = claimed.intent ?? {};
  const asset = assetOf(dep, String(ci.asset));
  if (!asset) throw new SignerCheckError('claimed asset is not supported');
  let intent: TransferIntent;
  try {
    intent = parseIntent(dep, { source: ci.source, recipient: ci.recipient, asset: ci.asset, amount: formatUnits(BigInt(String(ci.amount)), asset.decimals) });
  } catch (e) {
    throw new SignerCheckError(`claimed intent rejected: ${(e as Error).message}`);
  }
  if (typeof claimed.ownerIndex !== 'number' || !Number.isInteger(claimed.ownerIndex) || claimed.ownerIndex < 0) throw new SignerCheckError('ownerIndex malformed');
  const ownerIndex = BigInt(claimed.ownerIndex);
  const op: UserOperationV06 = parseClaimedOp(claimed.op);
  const readOwner = async () => {
    const head = await d.reader.head();
    const own = await d.reader.owners(intent.source, toHex(head.number));
    const slot = own?.owners.find((o) => BigInt(o.index) === ownerIndex);
    if (!slot || (slot.bytes.length - 2) / 2 !== 64) throw new SignerCheckError(`owner ${ownerIndex} of ${intent.source} is not a Passkey on chain`);
    return slot.bytes;
  };
  const ownerKey = await readOwner();
  const { hash } = checkTransferOp(op, { dep, intent, ownerPublicKey: ownerKey, ownerIndex, maxSignatureBytes: maxSignatureBytes(dep) });
  if (claimed.userOpHash !== hash) throw new SignerCheckError('sidecar-reported userOpHash differs from the recomputed hash');
  const data = handleOpsData(op, gw);
  const prepare = async () => {
    const snap = await d.reader.snapshot(intent.source, { gasWallet: gw });
    const v = deploymentVerdict(dep, snap);
    if (!v.complete) throw new SignerCheckError(`the account does not verify on chain: ${v.stops.map((s) => s.detail).join('; ') || 'not deployed'}`);
    if (snap.nonce !== op.nonce) throw new SignerCheckError(`EntryPoint nonce is ${snap.nonce}, the op uses ${op.nonce} — already executed or stale; nothing will be signed`);
    if (op.maxFeePerGas < snap.baseFee) throw new SignerCheckError('op maxFeePerGas is below the current base fee');
    const fees = feePolicy(snap.baseFee, snap.priorityFee);
    const sim = await d.forks.run(snap, async (f) => {
      f.guard({ wallets: [intent.source], entryPoint: dep.entryPoint, gasWallet: gw });
      await assertP256Parity(f, snap.p256Probe);
      return simulateSigned(f, dep, op, intent, gw, fees);
    });
    if (!sim.success) throw new SignerCheckError(`signed handleOps simulation failed: ${sim.problems.join('; ')}`);
    checkOuter(sim.outerGasLimit, fees.maxFeePerGas, snap.gasWallet!.balance);
    return { snap, fees, sim };
  };
  const a = await prepare();
  const amount = formatUnits(intent.amount, asset.decimals);
  d.io.print(`${dep.chainName} chainId ${dep.chainId} · block ${a.snap.block}`);
  d.io.print(`Transfer: ${amount} ${asset.symbol}`);
  d.io.print(`  recipient        ${intent.recipient}`);
  d.io.print(`  source account   ${intent.source} (UserOp nonce ${op.nonce}, owner index ${ownerIndex})`);
  d.io.print(`  userOpHash       ${hash} (Passkey signature re-verified here against the on-chain owner, UV=true)`);
  d.io.print(`  outer tx         from ${gw} → EntryPoint ${dep.entryPoint}.handleOps, beneficiary = gas wallet, value 0`);
  d.io.print(`  tx nonce         ${a.snap.gasWallet!.nonce}`);
  gasSummary(d, a.sim.outerGasLimit, a.fees, a.snap.gasWallet!.balance);
  d.io.print(`  UserOp fee       paid by the account (EntryPoint deposit first); on the fork ${fmtNative(d, a.sim.actualGasCost)}, refunded to the beneficiary`);
  d.io.print(`  fork simulation  UserOperationEvent.success=true; recipient +${a.sim.deltas.recipient}; nonce ${a.sim.nonceBefore}→${a.sim.nonceAfter}`);
  if (!(await confirm(d.io, confirmationPhrase('send', { amount, asset: asset.symbol, nonce: op.nonce })))) {
    d.io.print('Cancelled; nothing signed. The hand-off code is used up; create a new one in the browser if needed.');
    return 'cancelled';
  }
  const key = await unlock(d);
  try {
    const b = await prepare();
    if (b.snap.gasWallet!.nonce !== a.snap.gasWallet!.nonce) throw new SignerCheckError('gas wallet nonce changed during confirmation; nothing signed');
    if (b.sim.outerGasLimit > a.sim.outerGasLimit || b.fees.maxFeePerGas > a.fees.maxFeePerGas) throw new SignerCheckError('the fresh simulation needs more gas/fee than you confirmed; nothing signed — run again to see the new maximum');
    if (a.fees.maxFeePerGas < b.snap.baseFee) throw new SignerCheckError('the confirmed maxFeePerGas is now below the base fee; nothing signed — run again');
    checkOuter(a.sim.outerGasLimit, a.fees.maxFeePerGas, b.snap.gasWallet!.balance);
    if ((await readOwner()).toLowerCase() !== ownerKey.toLowerCase()) throw new SignerCheckError(`owner ${ownerIndex} changed on chain during confirmation; nothing signed`);
    const raw = await key.sign({ type: 'eip1559', chainId: dep.chainId, nonce: Number(b.snap.gasWallet!.nonce), to: dep.entryPoint, data, value: 0n, gas: a.sim.outerGasLimit, ...a.fees });
    key.wipe();
    const txHash = await broadcastRaw(d.up, raw);
    d.io.print(`Sent: ${txHash}`);
    // The same canonical record the browser keeps (digests only); the full addresses go as checked hints.
    const record = buildTrackRecord({ chainId: dep.chainId, deploymentId: dep.id, userOpHash: hash, source: intent.source, recipient: intent.recipient, asset: intent.asset, amount: intent.amount, nonce: op.nonce, gasWallet: gw, gasWalletNonce: b.snap.gasWallet!.nonce, inputHash: null, txHash, fromBlock: b.snap.block });
    const v: TrackResult = await waitFor(() => track(d.reader, { record, sender: intent.source, gasWallet: gw }), d.receiptTimeoutMs ?? 180_000, d.io, ['pending', 'unknown', 'reorged']);
    d.io.print(`Result: ${v.state} (${v.detail})`);
    return 'sent';
  } finally {
    key.wipe();
  }
}
