// Fork simulations and gas policy (tech spec §3.4–§3.6, M3 generalisation). Kinds, never conflated in output:
//   deploy         — the registry/createAccount transactions replayed from a sender (synthetic preview sender, funded on the fork only)
//   execution-only — wallet.execute(callData) with the EntryPoint as caller: effects and call gas, NO signature check
//   twin           — a synthetic twin wallet (same factory, throwaway key at the same owner index) measures validation gas
//   signed         — the exact signed UserOp through EntryPoint.handleOps from the user's gas wallet as bundler
import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import { decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, type Address, type Hex } from 'viem';
import { ERC1967_IMPLEMENTATION_SLOT, tokenAssets, type SupportedDeployment } from '../src/config/registry';
import { bytesToBase64url, bytesToHex, concatBytes, utf8 } from '../src/crypto/bytes';
import type { TransferIntent } from '../src/transfer/intent';
import { userOpHash, type UserOperationV06 } from '../src/userop/hash';
import { encodeUserOpSignature } from '../src/userop/signature';
import type { ParsedAssertion } from '../src/webauthn/assertion';
import { EP_ABI, ERC20_READ_ABI, FACTORY_ABI, WALLET_READ_ABI } from './abi';
import { ForkError, type Fork } from './fork';
import { P256_PROBE } from './p256probe';
import type { OwnerSlot } from './reader';
import type { StateView } from './state';

export const GWEI = 10n ** 9n;
/** Upper bound accepted for a real assertion's clientDataJSON; the gas plan and preVerificationGas assume it. */
export const CLIENT_DATA_MAX_BYTES = 512;
export const AUTH_DATA_BYTES = 37;
export const SYNTH_FUNDER: Address = '0x5ac0000000000000000000000000000000005ac0';
export const PREVIEW_SENDER: Address = '0x5ac0000000000000000000000000000000000de9';
/** Filler owner used in the twin for removed slots, so the twin's signing slot keeps the same index. */
const TWIN_FILLER_OWNER: Hex = ('0x' + '0'.repeat(24) + '5ac00000000000000000000000000000000f111e') as Hex;

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Fee rule: priority ≥ 1 wei; maxFee = max(2·baseFee + priority, 1 gwei). */
export function feePolicy(baseFee: bigint, priority: bigint): Fees {
  const prio = priority < 1n ? 1n : priority;
  const want = baseFee * 2n + prio;
  return { maxPriorityFeePerGas: prio, maxFeePerGas: want > GWEI ? want : GWEI };
}

export const ceilMul = (x: bigint, num: bigint, den: bigint) => (x * num + den - 1n) / den;
const max = (...xs: bigint[]) => xs.reduce((a, b) => (a > b ? a : b));

export function callGasPolicy(execEstimate: bigint): bigint {
  return max(ceilMul(execEstimate, 3n, 2n), 100_000n);
}

export function verificationGasPolicy(measuredValidation: bigint): bigint {
  return max(ceilMul(measuredValidation, 3n, 2n), 500_000n);
}

/** v0.6 bundler-style preVerificationGas for a single-op bundle with the padded (maximum) signature. */
export function preVerificationGasFor(op: UserOperationV06): bigint {
  const packed = packFullUserOp(op);
  let cost = 0n;
  for (let i = 2; i < packed.length; i += 2) cost += packed.slice(i, i + 2) === '00' ? 4n : 16n;
  const words = BigInt(Math.ceil((packed.length - 2) / 2 / 32));
  return ceilMul(cost + 21_000n + 18_300n + 4n * words, 11n, 10n);
}

export function packFullUserOp(op: UserOperationV06): Hex {
  return encodeAbiParameters(
    [{ type: 'tuple', components: [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bytes' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bytes' }] }],
    [[op.sender, op.nonce, op.initCode, op.callData, op.callGasLimit, op.verificationGasLimit, op.preVerificationGas, op.maxFeePerGas, op.maxPriorityFeePerGas, op.paymasterAndData, op.signature]],
  );
}

export const opTuple = (op: UserOperationV06) =>
  ({ sender: op.sender, nonce: op.nonce, initCode: op.initCode, callData: op.callData, callGasLimit: op.callGasLimit, verificationGasLimit: op.verificationGasLimit, preVerificationGas: op.preVerificationGas, maxFeePerGas: op.maxFeePerGas, maxPriorityFeePerGas: op.maxPriorityFeePerGas, paymasterAndData: op.paymasterAndData, signature: op.signature }) as const;

export function handleOpsData(op: UserOperationV06, beneficiary: Address): Hex {
  return encodeFunctionData({ abi: EP_ABI, functionName: 'handleOps', args: [[opTuple(op)], beneficiary] });
}

/** Maximum prefund the EntryPoint may take for `op` (v0.6, no paymaster). */
export const prefundOf = (op: UserOperationV06) => (op.callGasLimit + op.verificationGasLimit + op.preVerificationGas) * op.maxFeePerGas;

// ---------- synthetic twin signer (throwaway key, fork-only) ----------

export interface TwinKey {
  secret: Uint8Array;
  publicKeyXY: Uint8Array;
}

export function newTwinKey(): TwinKey {
  const secret = p256.utils.randomSecretKey();
  return { secret, publicKeyXY: p256.getPublicKey(secret, false).subarray(1) };
}

/** A maximum-size (clientDataJSON padded to the bound) valid WebAuthn assertion from the twin key. */
export function twinAssertion(dep: SupportedDeployment, key: TwinKey, hash: Hex, flags = 0x05): ParsedAssertion {
  const head = `{"type":"webauthn.get","challenge":"${bytesToBase64url(Uint8Array.from(Buffer.from(hash.slice(2), 'hex')))}","origin":"${dep.rp.origin}","crossOrigin":false,"pad":"`;
  const json = head + 'x'.repeat(CLIENT_DATA_MAX_BYTES - head.length - 2) + '"}';
  const clientDataJSON = utf8(json);
  const authenticatorData = concatBytes(sha256(utf8(dep.rp.id)), Uint8Array.of(flags), new Uint8Array(4));
  const digest = sha256(concatBytes(authenticatorData, sha256(clientDataJSON)));
  const der = p256.sign(digest, key.secret, { prehash: false, lowS: true, format: 'der' });
  return { kind: 'userop', reportedOrigin: dep.rp.origin, credentialId: utf8('twin'), authenticatorData, clientDataJSON, signatureDer: der, userHandle: null };
}

export function twinSignature(dep: SupportedDeployment, key: TwinKey, op: UserOperationV06, ownerIndex: bigint): Hex {
  const h = userOpHash(op, dep.entryPoint, dep.chainId);
  return encodeUserOpSignature(twinAssertion(dep, key, h), h, { publicKeyXY: key.publicKeyXY, ownerIndex, rpId: dep.rp.id, origin: dep.rp.origin, requireUV: true });
}

/** Byte length of the largest signature a plan accepts (twin signature at the clientDataJSON bound). ownerIndex is a uint256 word, so any index has the same length. */
export function maxSignatureBytes(dep: SupportedDeployment): number {
  const dummy = { sender: dep.factory, nonce: 0n, initCode: '0x', callData: '0x', callGasLimit: 0n, verificationGasLimit: 0n, preVerificationGas: 0n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n, paymasterAndData: '0x', signature: '0x' } satisfies UserOperationV06;
  return (twinSignature(dep, newTwinKey(), dummy, 0n).length - 2) / 2;
}

// ---------- fork state readback ----------

export async function forkStateView(f: Fork, dep: SupportedDeployment, account: Address): Promise<StateView> {
  const ch = async (a: Address) => {
    const c = await f.code(a);
    return c === '0x' ? null : keccak256(c);
  };
  const accountCode = await ch(account);
  const view: StateView = {
    infraCode: { entryPoint: await ch(dep.entryPoint), singletonFactory: await ch(dep.singletonFactory), implementation: await ch(dep.implementation), factory: await ch(dep.factory) },
    accountCode,
    accountImplementation: null,
    owners: null,
    nextOwnerIndex: null,
    removedOwnersCount: null,
  };
  if (accountCode) {
    const slot = await f.storage(account, ERC1967_IMPLEMENTATION_SLOT);
    view.accountImplementation = BigInt(slot) === 0n ? null : getAddress('0x' + slot.slice(-40));
    const rd = async (fn: 'nextOwnerIndex' | 'removedOwnersCount') => BigInt(await f.call(account, encodeFunctionData({ abi: WALLET_READ_ABI, functionName: fn })));
    view.nextOwnerIndex = await rd('nextOwnerIndex');
    view.removedOwnersCount = await rd('removedOwnersCount');
    const owners: OwnerSlot[] = [];
    const n = view.nextOwnerIndex > BigInt(dep.maxOwners) ? BigInt(dep.maxOwners) : view.nextOwnerIndex;
    for (let i = 0n; i < n; i++) {
      const r = await f.call(account, encodeFunctionData({ abi: WALLET_READ_ABI, functionName: 'ownerAtIndex', args: [i] }));
      owners.push({ index: Number(i), bytes: (decodeFunctionResult({ abi: WALLET_READ_ABI, functionName: 'ownerAtIndex', data: r }) as Hex).toLowerCase() as Hex });
    }
    view.owners = owners;
  }
  return view;
}

/** The fork must answer the P256 probe exactly like the upstream (Plasma: no precompile → 0x). */
export async function assertP256Parity(f: Fork, upstreamAnswer: Hex): Promise<void> {
  const local = await f.call(P256_PROBE.to, P256_PROBE.data);
  if (local.toLowerCase() !== upstreamAnswer.toLowerCase()) throw new ForkError(`fork P256 precompile behaviour (${local}) differs from the chain (${upstreamAnswer}); gas estimates would be wrong`);
}

// ---------- deployment ----------

export interface TxStep {
  key: string;
  to: Address;
  data: Hex;
}

export interface DeploySimStep {
  key: string;
  gasUsed: bigint;
  gasLimit: bigint;
}

export const deployGasLimit = (estimate: bigint) => ceilMul(estimate, 6n, 5n) + 20_000n;

/** Replays steps in order from `sender`. A synthetic preview sender is funded on the fork; a real gas wallet never is. */
export async function simulateDeploy(f: Fork, steps: TxStep[], sender: Address, opts: { synthetic: boolean; fees: Fees }): Promise<DeploySimStep[]> {
  if (opts.synthetic) await f.fundSynthetic(sender, 10n ** 20n);
  else f.protectedBalances.add(getAddress(sender));
  await f.impersonate(sender, opts.synthetic ? 'synthetic' : 'outer-sender');
  const out: DeploySimStep[] = [];
  for (const s of steps) {
    const est = await f.estimate({ from: sender, to: s.to, data: s.data });
    const gasLimit = deployGasLimit(est);
    const r = await f.receipt(await f.send({ from: sender, to: s.to, data: s.data, gas: gasLimit, ...opts.fees }));
    if (r.status !== '0x1') throw new ForkError(`deployment step ${s.key} reverted on the fork`);
    out.push({ key: s.key, gasUsed: BigInt(r.gasUsed), gasLimit });
  }
  return out;
}

// ---------- transfer effects ----------

export interface Balances {
  recipient: bigint;
  accountNative: bigint;
  accountAsset: bigint;
  deposit: bigint;
  nonce: bigint;
  /** The source's balance of every other registry token (the ones this transfer must not touch). */
  otherTokens: Array<{ token: Address; balance: bigint }>;
}

export interface Deltas {
  recipient: bigint;
  accountNative: bigint;
  accountAsset: bigint;
  otherTokens: Array<{ token: Address; delta: bigint }>;
}

async function tokenBal(f: Fork, token: Address, a: Address): Promise<bigint> {
  const r = await f.call(token, encodeFunctionData({ abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [a] }));
  return r === '0x' ? 0n : BigInt(r);
}

export async function readBalances(f: Fork, dep: SupportedDeployment, intent: TransferIntent): Promise<Balances> {
  const ep = async (data: Hex) => BigInt(await f.call(dep.entryPoint, data));
  const asset = intent.asset;
  return {
    recipient: asset === 'native' ? await f.balance(intent.recipient) : await tokenBal(f, asset, intent.recipient),
    accountNative: await f.balance(intent.source),
    accountAsset: asset === 'native' ? await f.balance(intent.source) : await tokenBal(f, asset, intent.source),
    deposit: await ep(encodeFunctionData({ abi: EP_ABI, functionName: 'balanceOf', args: [intent.source] })),
    nonce: await ep(encodeFunctionData({ abi: EP_ABI, functionName: 'getNonce', args: [intent.source, 0n] })),
    otherTokens: await Promise.all(otherTokensOf(dep, intent).map(async (token) => ({ token, balance: await tokenBal(f, token, intent.source) }))),
  };
}

/** Registry tokens other than the one being moved (all of them for a native transfer). */
export const otherTokensOf = (dep: SupportedDeployment, intent: TransferIntent): Address[] =>
  tokenAssets(dep)
    .map((a) => getAddress(a.id))
    .filter((t) => intent.asset === 'native' || t !== getAddress(intent.asset));

export const deltasOf = (b: Balances, a: Balances): Deltas => ({
  recipient: a.recipient - b.recipient,
  accountNative: a.accountNative - b.accountNative,
  accountAsset: a.accountAsset - b.accountAsset,
  otherTokens: b.otherTokens.map((x, i) => ({ token: x.token, delta: (a.otherTokens[i]?.balance ?? x.balance) - x.balance })),
});

export function transferLogs(logs: Array<{ address: string; topics: Hex[]; data: Hex }>, token: Address): Array<{ from: Address; to: Address; value: bigint }> {
  return logs
    .filter((l) => getAddress(l.address) === getAddress(token))
    .flatMap((l) => {
      try {
        const d = decodeEventLog({ abi: ERC20_READ_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data });
        return d.eventName === 'Transfer' ? [d.args as { from: Address; to: Address; value: bigint }] : [];
      } catch {
        return [];
      }
    });
}

/** Checks the exact effect of the intent; returns problems (empty = matches). */
export function checkEffects(intent: TransferIntent, d: Deltas, logs: Array<{ address: string; topics: Hex[]; data: Hex }>, gasFromWallet: bigint): string[] {
  const p: string[] = [];
  const selfRecipient = getAddress(intent.recipient) === getAddress(intent.source);
  if (selfRecipient) p.push('recipient equals source');
  if (d.recipient !== intent.amount) p.push(`recipient delta ${d.recipient} ≠ ${intent.amount}`);
  if (intent.asset === 'native') {
    if (d.accountNative !== -intent.amount - gasFromWallet) p.push(`account native delta ${d.accountNative} ≠ −(${intent.amount} + ${gasFromWallet})`);
  } else {
    if (d.accountAsset !== -intent.amount) p.push(`account token delta ${d.accountAsset} ≠ −${intent.amount}`);
    if (d.accountNative !== -gasFromWallet) p.push('account native balance changed beyond the prefund');
    const t = transferLogs(logs, intent.asset).filter((x) => getAddress(x.from) === getAddress(intent.source));
    if (t.length !== 1 || getAddress(t[0]!.to) !== getAddress(intent.recipient) || t[0]!.value !== intent.amount) p.push('token Transfer event is not exactly source → recipient for the amount');
  }
  // Every other registry token stays where it was: a recipient contract's callback must not be able to
  // pull, say, USDT0 through an old allowance while the requested transfer itself looks exact.
  for (const o of d.otherTokens) {
    if (o.delta !== 0n) p.push(`account balance of token ${o.token} changed by ${o.delta} (this transfer must not touch it)`);
    if (transferLogs(logs, o.token).some((x) => getAddress(x.from) === getAddress(intent.source))) p.push(`a Transfer of token ${o.token} out of the account was emitted (this transfer must not touch it)`);
  }
  return p;
}

export interface ExecOnlyResult {
  label: 'execution-only (EntryPoint as caller, signature NOT checked)';
  estimate: bigint;
  deltas: Deltas;
  problems: string[];
}

export async function simulateExecutionOnly(f: Fork, dep: SupportedDeployment, intent: TransferIntent, callData: Hex): Promise<ExecOnlyResult> {
  await f.impersonate(dep.entryPoint, 'execution-only');
  const before = await readBalances(f, dep, intent);
  const estimate = await f.estimate({ from: dep.entryPoint, to: intent.source, data: callData });
  // Fee-free, so the EntryPoint's own balance (its deposits) is neither needed nor touched on the fork.
  await f.zeroFeeNextBlock();
  const r = await f.receipt(await f.send({ from: dep.entryPoint, to: intent.source, data: callData, gas: estimate * 2n, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n }));
  const deltas = deltasOf(before, await readBalances(f, dep, intent));
  const problems = r.status === '0x1' ? checkEffects(intent, deltas, r.logs, 0n) : ['execute() reverted (would the transfer fail? check the balance and the recipient)'];
  return { label: 'execution-only (EntryPoint as caller, signature NOT checked)', estimate, deltas, problems };
}

// ---------- twin validation measurement ----------

export interface TwinMeasurement {
  label: 'synthetic twin wallet (throwaway key at the same owner index, same factory/implementation, FCL path)';
  validationGas: bigint;
  sigFailed: boolean;
  ownerIndex: number;
  twinNonce: bigint;
}

/**
 * Owners of the twin: the account's owner list, the signing slot replaced by the twin key, each removed
 * slot by its own filler (the wallet refuses a repeated owner with AlreadyOwner, so two removed slots
 * cannot share one). Fillers are address-shaped, distinct per slot, and never equal a kept owner.
 */
export function twinOwners(owners: readonly OwnerSlot[], ownerIndex: number, twinKeyXY: Hex): Hex[] {
  const taken = new Set(owners.filter((o) => o.bytes !== '0x' && o.index !== ownerIndex).map((o) => o.bytes.toLowerCase()));
  taken.add(twinKeyXY.toLowerCase());
  let n = 0n;
  const filler = (): Hex => {
    for (;;) {
      const f = ('0x' + (BigInt(TWIN_FILLER_OWNER) + n++).toString(16).padStart(64, '0')) as Hex;
      if (!taken.has(f)) return taken.add(f), f;
    }
  };
  return owners.map((o) => (o.index === ownerIndex ? twinKeyXY : o.bytes === '0x' ? filler() : o.bytes));
}

/** Synthetic funder balance for a twin measurement: the deposit it copies plus a fixed gas budget. */
export const twinFunding = (deposit: bigint): bigint => deposit + 10n ** 21n;

export async function measureTwinValidation(f: Fork, dep: SupportedDeployment, op: UserOperationV06, owners: readonly OwnerSlot[], ownerIndex: number, deposit: bigint, nativeBalance: bigint): Promise<TwinMeasurement> {
  const key = newTwinKey();
  const list = twinOwners(owners, ownerIndex, bytesToHex(key.publicKeyXY));
  const createNonce = BigInt(bytesToHex(randomBytes(16)));
  // The funder pays the twin's creation and then copies the account's whole deposit: fund it for both,
  // whatever the deposit's size (a fixed amount would refuse any account with a larger deposit).
  await f.fundSynthetic(SYNTH_FUNDER, twinFunding(deposit));
  await f.impersonate(SYNTH_FUNDER, 'synthetic');
  const twinAddr = decodeFunctionResult({ abi: FACTORY_ABI, functionName: 'getAddress', data: await f.call(dep.factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: 'getAddress', args: [list, createNonce] })) }) as Address;
  const mk = await f.receipt(await f.send({ from: SYNTH_FUNDER, to: dep.factory, data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'createAccount', args: [list, createNonce] }), gas: 3_000_000n }));
  if (mk.status !== '0x1') throw new ForkError('twin createAccount failed');
  // Funded for the measurement, not mirroring the account: the provisional draft's prefund (2M
  // verification gas at the live fee cap) can exceed what a low-balance account holds, and an AA21 here
  // would refuse a transfer the final, smaller op could pay for. The same payment path still runs (the
  // twin pays whatever its deposit does not cover); the real balance is checked against the final op's
  // reserve by the caller and again by the exact signed simulation.
  const draftPrefund = (op.callGasLimit + op.verificationGasLimit + op.preVerificationGas) * op.maxFeePerGas;
  const missing = draftPrefund > deposit ? draftPrefund - deposit : 0n;
  await f.fundSynthetic(twinAddr, nativeBalance > missing ? nativeBalance : missing);
  if (deposit > 0n) {
    const d = await f.receipt(await f.send({ from: SYNTH_FUNDER, to: dep.entryPoint, data: encodeFunctionData({ abi: EP_ABI, functionName: 'depositTo', args: [twinAddr] }), value: deposit, gas: 200_000n }));
    if (d.status !== '0x1') throw new ForkError('twin deposit failed');
  }
  // The twin is a fresh account: it reads its own EntryPoint nonce (0). The real op's nonce is never changed.
  const twinNonce = BigInt(await f.call(dep.entryPoint, encodeFunctionData({ abi: EP_ABI, functionName: 'getNonce', args: [twinAddr, 0n] })));
  const twinOp: UserOperationV06 = { ...op, sender: twinAddr, nonce: twinNonce, signature: '0x' };
  twinOp.signature = twinSignature(dep, key, twinOp, BigInt(ownerIndex));
  let data: unknown;
  try {
    await f.call(dep.entryPoint, encodeFunctionData({ abi: EP_ABI, functionName: 'simulateValidation', args: [opTuple(twinOp)] }));
    throw new ForkError('simulateValidation did not revert');
  } catch (e) {
    data = (e as { data?: unknown }).data;
    if (typeof data !== 'string') throw e;
  }
  const dec = decodeErrorResult({ abi: EP_ABI, data: data as Hex });
  if (dec.errorName === 'FailedOp') throw new ForkError(`twin validation failed: ${String((dec.args as readonly unknown[])[1])}`);
  if (dec.errorName !== 'ValidationResult') throw new ForkError('unexpected simulateValidation result');
  const info = (dec.args as unknown as readonly [{ preOpGas: bigint; sigFailed: boolean }])[0];
  return { label: 'synthetic twin wallet (throwaway key at the same owner index, same factory/implementation, FCL path)', validationGas: info.preOpGas - op.preVerificationGas, sigFailed: info.sigFailed, ownerIndex, twinNonce };
}

// ---------- signed handleOps ----------

export interface SignedSimResult {
  label: 'signed handleOps (exact UserOp, real owners, your gas wallet as bundler)';
  outerGasLimit: bigint;
  outerGasUsed: bigint;
  actualGasCost: bigint;
  actualGasUsed: bigint;
  success: boolean;
  deltas: Deltas;
  nonceBefore: bigint;
  nonceAfter: bigint;
  problems: string[];
  forkBlock: bigint;
}

export function decodeFailure(e: unknown): string {
  const data = (e as { data?: unknown }).data;
  if (typeof data === 'string' && data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: EP_ABI, data: data as Hex });
      if (d.errorName === 'FailedOp') return `EntryPoint FailedOp: ${String((d.args as readonly unknown[])[1])}`;
    } catch {
      /* fallthrough */
    }
  }
  return e instanceof Error ? e.message.slice(0, 200) : 'simulation failed';
}

/**
 * EntryPoint v0.6 without a paymaster: the account owes `requiredPrefund = (callGas + verificationGas +
 * preVerificationGas) × maxFeePerGas`, minus what its deposit already covers; the wallet pays exactly that
 * (`missingAccountFunds`) from its own balance during validation.
 */
export const walletPrefund = (op: UserOperationV06, depositBefore: bigint): bigint => {
  const need = prefundOf(op);
  return need > depositBefore ? need - depositBefore : 0n;
};

/** The deposit must end where prefund paid in and gas charged out put it — nothing else may move it. */
export function depositProblems(depositBefore: bigint, depositAfter: bigint, paidIn: bigint, actualGasCost: bigint): string[] {
  const want = depositBefore + paidIn - actualGasCost;
  return depositAfter === want ? [] : [`EntryPoint deposit is ${depositAfter}, expected ${want} (before ${depositBefore} + prefund ${paidIn} − gas ${actualGasCost})`];
}

export const outerGasPolicy = (estimate: bigint, op: UserOperationV06) => max(ceilMul(estimate, 13n, 10n), op.callGasLimit + op.verificationGasLimit + op.preVerificationGas + 100_000n);

/** Full handleOps of the exact signed op on a fork; nothing is edited except impersonating the outer sender. */
export async function simulateSigned(f: Fork, dep: SupportedDeployment, op: UserOperationV06, intent: TransferIntent, gasWallet: Address, fees: Fees): Promise<SignedSimResult> {
  const hash = userOpHash(op, dep.entryPoint, dep.chainId);
  await f.impersonate(gasWallet, 'outer-sender');
  const before = await readBalances(f, dep, intent);
  const base: Omit<SignedSimResult, 'problems'> = { label: 'signed handleOps (exact UserOp, real owners, your gas wallet as bundler)', outerGasLimit: 0n, outerGasUsed: 0n, actualGasCost: 0n, actualGasUsed: 0n, success: false, deltas: { recipient: 0n, accountNative: 0n, accountAsset: 0n, otherTokens: [] }, nonceBefore: before.nonce, nonceAfter: before.nonce, forkBlock: f.block };
  if (before.nonce !== op.nonce) return { ...base, problems: [`EntryPoint nonce is ${before.nonce}, the signed op uses ${op.nonce} (stale plan, or this op already executed)`] };
  const data = handleOpsData(op, gasWallet);
  let est: bigint;
  try {
    est = await f.estimate({ from: gasWallet, to: dep.entryPoint, data });
  } catch (e) {
    return { ...base, problems: [decodeFailure(e)] };
  }
  const outerGasLimit = outerGasPolicy(est, op);
  const gwBal = await f.balance(gasWallet);
  if (gwBal < outerGasLimit * fees.maxFeePerGas) return { ...base, outerGasLimit, problems: [`gas wallet holds ${gwBal} wei; needs ≥ ${outerGasLimit * fees.maxFeePerGas} wei for gas ${outerGasLimit} × maxFee ${fees.maxFeePerGas}`] };
  let r;
  try {
    r = await f.receipt(await f.send({ from: gasWallet, to: dep.entryPoint, data, gas: outerGasLimit, ...fees }));
  } catch (e) {
    return { ...base, outerGasLimit, problems: [decodeFailure(e)] };
  }
  const after = await readBalances(f, dep, intent);
  const evs = r.logs
    .filter((l) => getAddress(l.address) === getAddress(dep.entryPoint))
    .flatMap((l) => {
      try {
        return [decodeEventLog({ abi: EP_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data })];
      } catch {
        return [];
      }
    });
  const uoe = evs.filter((e) => e.eventName === 'UserOperationEvent' && (e.args as { userOpHash: Hex }).userOpHash === hash);
  const problems: string[] = [];
  if (r.status !== '0x1') problems.push('outer handleOps transaction reverted');
  if (uoe.length !== 1) problems.push('no UserOperationEvent for this userOpHash');
  const ev = uoe[0]?.args as { success: boolean; actualGasCost: bigint; actualGasUsed: bigint; sender: Address } | undefined;
  if (ev && !ev.success) problems.push('inner execution failed (UserOperationEvent.success = false)');
  if (ev && getAddress(ev.sender) !== getAddress(op.sender)) problems.push('UserOperationEvent sender mismatch');
  if (evs.some((e) => e.eventName === 'UserOperationRevertReason')) problems.push('UserOperationRevertReason emitted');
  const raw = deltasOf(before, after);
  const cost = ev?.actualGasCost ?? 0n;
  // Native XPL to the gas wallet itself: that address is also the outer sender (pays the outer fee) and
  // the handleOps beneficiary (gets actualGasCost back), so its balance moves by amount − outer fee +
  // actualGasCost. Those two terms are taken out, leaving exactly what the transfer itself delivered.
  const outerFee = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice ?? '0x0');
  const deltas = intent.asset === 'native' && getAddress(intent.recipient) === getAddress(gasWallet) ? { ...raw, recipient: raw.recipient + outerFee - cost } : raw;
  // What the account had to pay the EntryPoint is computed from the signed op and the deposit before it ran —
  // never read back from the account's own balance change, which is the very thing being checked.
  const fromWallet = walletPrefund(op, before.deposit);
  problems.push(...depositProblems(before.deposit, after.deposit, fromWallet, cost));
  problems.push(...checkEffects(intent, deltas, r.logs, fromWallet));
  if (after.nonce !== op.nonce + 1n) problems.push(`nonce after is ${after.nonce}, expected ${op.nonce + 1n}`);
  return { ...base, outerGasLimit, outerGasUsed: BigInt(r.gasUsed), actualGasCost: cost, actualGasUsed: ev?.actualGasUsed ?? 0n, success: problems.length === 0, deltas, nonceAfter: after.nonce, problems };
}
