// Transfer plans (M3): preview → sign → exact signed simulation → send request → wallet result → track.
// Each is its own state; nothing advances implicitly. The intent is immutable (its hash binds every
// step); the EntryPoint nonce is read live at preview, at signature and at the send request, so a
// nonce race voids the plan instead of sending a stale op. The user's EIP-1193 gas wallet is the
// bundler (beneficiary bound into the handleOps input); the sidecar never signs or broadcasts, and a
// send request is issued at most once per signature unless the wallet reported a rejection.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getAddress, keccak256, type Address, type Hex } from 'viem';
import { assetOf, type SupportedDeployment } from '../src/config/registry';
import { isSignRefusal } from '../src/config/signerApi';
import { hexToBytes } from '../src/crypto/bytes';
import { encodeTransferCall, intentHash, IntentError, parseAddress, parseIntent, type TransferIntent } from '../src/transfer/intent';
import { userOpHash, type UserOperationV06 } from '../src/userop/hash';
import { encodeUserOpSignature, SignatureError } from '../src/userop/signature';
import { AssertionFormatError, parseAssertionJson } from '../src/webauthn/assertion';
import { classifyOwner } from '../src/wallet/derive';
import type { InfraStep } from './bytecodeRegistry';
import { deploySteps } from './deploy';
import type { KnownAccount } from './diagnose';
import type { ForkManager } from './fork';
import { HttpError } from './http';
import { checkSignedTx, type NativeSign, type RelayOutcome } from './relay';
import type { AccountSnapshot, Reader } from './reader';
import {
  AUTH_DATA_BYTES,
  assertP256Parity,
  callGasPolicy,
  CLIENT_DATA_MAX_BYTES,
  feePolicy,
  handleOpsData,
  maxSignatureBytes,
  measureTwinValidation,
  outerGasPolicy,
  prefundOf,
  preVerificationGasFor,
  PREVIEW_SENDER,
  simulateDeploy,
  simulateExecutionOnly,
  simulateSigned,
  verificationGasPolicy,
  type ExecOnlyResult,
  type Fees,
  type SignedSimResult,
  type TwinMeasurement,
} from './sim';
import { deploymentVerdict } from './state';
import { buildTrackRecord } from './track';

/** Local validity window only: NOT an on-chain expiry. A signed UserOp stays executable until its nonce is used. */
export const PLAN_TTL_MS = 10 * 60 * 1000;
/** A Terminal hand-off code is single-use and short-lived. */
export const HANDOFF_TTL_MS = 2 * 60 * 1000;
const HANDOFF_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** Who signs the outer transaction: the browser wallet, the File key in the page, the runner's native signer, or the Terminal signer. */
export type SendVia = 'browser-wallet' | 'browser-file' | 'native-signer' | 'terminal-signer';
export const RELAY_VIA: ReadonlySet<SendVia> = new Set(['browser-file', 'native-signer']);

export type TransferState = 'previewed' | 'sim-failed' | 'signed' | 'sending' | 'sent' | 'unknown' | 'discarded';

export interface TransferPlan {
  id: string;
  createdAt: number;
  state: TransferState;
  intent: TransferIntent;
  intentHash: Hex;
  ownerIndex: number;
  ownerPublicKey: Hex;
  gasWallet: Address;
  op: UserOperationV06;
  hash: Hex;
  snapshotBlock: bigint;
  fees: Fees;
  signable: boolean;
  notSignableReason: string | null;
  execOnly: ExecOnlyResult;
  twin: TwinMeasurement;
  prefundWei: bigint;
  /** Native the account must keep so the EntryPoint can take the missing prefund: max(0, prefund − deposit). */
  reserveWei: bigint;
  recipientInfo: { hasCode: boolean; native: bigint; token: bigint | null };
  /** Signed op: memory only, never logged or persisted, dropped once a send was requested. */
  signedOp: UserOperationV06 | null;
  signedSim: SignedSimResult | null;
  send: { requestedAt: number; inputHash: Hex; gasWalletNonce: bigint; fromBlock: bigint; outerGasLimit: bigint; txHash: Hex | null; outcome: 'awaiting-wallet' | 'rejected' | 'hash' | 'no-hash'; via: SendVia; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null;
  /** Terminal hand-off: sha256 of the one-time code (the code itself is shown once and never stored). */
  handoff: { codeHash: Buffer; expiresAt: number } | null;
  rpcEpoch: number;
  discardReason: string | null;
}

export interface RpcBinding {
  readonly epoch: number;
  onSwitch(fn: (e: { epoch: number; reason: string }) => void): void;
  capabilities(): Partial<Record<'chain' | 'read' | 'fork', { status: string; detail: string }>> | null;
}

export interface Clock {
  now(): number;
}

/**
 * What a browser may keep to track a send after a refresh or a sidecar restart: no signature, no signed
 * op, and no full address — sender, recipient and gas wallet only as digests plus short forms
 * (architecture §6.3). The tracker gets full addresses from the mined op or a hint matching the digest.
 */
export function trackingRecord(p: TransferPlan) {
  return buildTrackRecord({ chainId: p.intent.chainId, deploymentId: p.intent.deploymentId, userOpHash: p.hash, source: p.intent.source, recipient: p.intent.recipient, asset: p.intent.asset, amount: p.intent.amount, nonce: p.op.nonce, gasWallet: p.gasWallet, gasWalletNonce: p.send?.gasWalletNonce ?? null, inputHash: p.send?.inputHash ?? null, txHash: p.send?.txHash ?? null, fromBlock: p.send?.fromBlock ?? p.snapshotBlock });
}

/**
 * The two fees, kept apart (design guidelines §8 FeeSplit): the outer transaction's gas, paid by the gas
 * wallet (a cap: gas limit × max fee — the signed simulation's limit once known), and the UserOp prefund
 * the EntryPoint takes from the wallet's deposit (a cap; unused prefund stays in the deposit).
 */
export function feeSummary(p: TransferPlan) {
  const networkGasLimit = p.signedSim?.success ? p.signedSim.outerGasLimit : outerGasPolicy(0n, p.op);
  return { networkGasLimit, networkMaxWei: networkGasLimit * p.fees.maxFeePerGas, networkFinal: !!p.signedSim?.success, walletMaxWei: p.prefundWei, reserveWei: p.reserveWei };
}

export function publicPlan(p: TransferPlan, dep: SupportedDeployment) {
  const asset = assetOf(dep, p.intent.asset)!;
  return {
    id: p.id,
    state: p.state,
    createdAt: p.createdAt,
    validUntil: p.createdAt + PLAN_TTL_MS,
    intent: p.intent,
    intentHash: p.intentHash,
    asset: { symbol: asset.symbol, decimals: asset.decimals, id: asset.id },
    ownerIndex: p.ownerIndex,
    ownerPublicKey: p.ownerPublicKey,
    gasWallet: p.gasWallet,
    op: { ...p.op, signature: p.signedOp ? `(${(p.signedOp.signature.length - 2) / 2} bytes, in sidecar memory only)` : '0x' },
    userOpHash: p.hash,
    snapshotBlock: p.snapshotBlock,
    fees: p.fees,
    signable: p.signable,
    notSignableReason: p.notSignableReason,
    execOnly: p.execOnly,
    twin: p.twin,
    prefundWei: p.prefundWei,
    reserveWei: p.reserveWei,
    feeSummary: feeSummary(p),
    recipientInfo: p.recipientInfo,
    signedSim: p.signedSim,
    send: p.send && { requestedAt: p.send.requestedAt, txHash: p.send.txHash, outcome: p.send.outcome, outerGasLimit: p.send.outerGasLimit, via: p.send.via },
    handoff: p.handoff && { expiresAt: p.handoff.expiresAt },
    tracking: p.send ? { ...trackingRecord(p), entryPoint: dep.entryPoint } : null,
    discardReason: p.discardReason,
  };
}

export class TransferService {
  private plans = new Map<string, TransferPlan>();
  readonly maxSigBytes: number;
  private rpc: RpcBinding | null = null;
  private relay: ((raw: Hex) => Promise<RelayOutcome>) | null = null;
  private native: NativeSign | null = null;

  constructor(
    readonly reader: Reader,
    private readonly forks: ForkManager,
    private readonly infra: InfraStep[],
    private readonly accounts: { get(a: Address): KnownAccount | undefined },
    private readonly clock: Clock = { now: () => Date.now() },
  ) {
    this.maxSigBytes = maxSignatureBytes(reader.dep);
  }

  get dep(): SupportedDeployment {
    return this.reader.dep;
  }

  /** Switching endpoints voids unsent plans; a plan whose send was requested may be on chain, so it turns unknown. */
  bindRpc(rpc: RpcBinding): void {
    this.rpc = rpc;
    rpc.onSwitch(({ reason }) => {
      for (const p of this.plans.values()) this.void(p, `RPC endpoint changed (${reason}); build a new plan`);
    });
  }

  /** The sidecar's broadcaster for checked bytes (relay.ts); unset in tests that never relay. */
  bindRelay(fn: (raw: Hex) => Promise<RelayOutcome>): void {
    this.relay = fn;
  }
  /** The runner's native signer (IPC); absent when the sidecar runs on its own. */
  bindNativeSigner(fn: NativeSign | null): void {
    this.native = fn;
  }

  private get epoch(): number {
    return this.rpc?.epoch ?? 0;
  }

  private sameEpoch(start: number): void {
    if (this.epoch !== start) throw new HttpError(409, 'the RPC endpoint changed while this was running; results discarded — try again');
  }

  private assertRpcUsable(): void {
    const caps = this.rpc?.capabilities();
    for (const k of ['chain', 'read'] as const) {
      const c = caps?.[k];
      if (c && c.status !== 'ok') throw new HttpError(409, `the last check of this RPC failed (${k}: ${c.detail || c.status}); signing is disabled — check it again or use another RPC`);
    }
    const fork = caps?.fork;
    if (fork && (fork.status === 'unsupported' || fork.status === 'error')) throw new HttpError(409, `this RPC cannot back the fork simulation (${fork.detail}); signing is disabled — use another RPC`);
  }

  plan(id: unknown): TransferPlan {
    if (typeof id !== 'string') throw new HttpError(400, 'planId required');
    const p = this.plans.get(id);
    if (!p) throw new HttpError(404, 'unknown plan (discarded, or the sidecar restarted) — if you requested a send, track it from the saved tracking record');
    if (this.clock.now() > p.createdAt + PLAN_TTL_MS) this.void(p, 'the local validity window (10 min) ended; this does not revoke a signature already given');
    if (p.rpcEpoch !== this.epoch) this.void(p, 'RPC endpoint changed; build a new plan');
    return p;
  }

  async preview(body: Record<string, unknown>) {
    const dep = this.dep;
    const startEpoch = this.epoch;
    this.assertRpcUsable();
    let intent: TransferIntent, gasWallet: Address;
    try {
      intent = parseIntent(dep, { source: body.source, recipient: body.recipient, asset: body.asset, amount: body.amount });
      gasWallet = parseAddress(body.gasWallet, 'gas wallet');
    } catch (e) {
      if (e instanceof IntentError) throw new HttpError(400, e.message);
      throw e;
    }
    if (gasWallet === intent.source) throw new HttpError(400, 'the gas wallet must be your EOA wallet, not the smart account');
    const known = this.accounts.get(intent.source);
    if (!known) throw new HttpError(409, 'diagnose this account first (owners must be verified before a transfer can be prepared)');
    const ownerIndex = typeof body.ownerIndex === 'number' && Number.isInteger(body.ownerIndex) ? body.ownerIndex : -1;
    const slot = known.owners.find((o) => o.index === ownerIndex);
    const owner = slot ? classifyOwner(slot.index, slot.bytes) : null;
    if (!owner || owner.kind !== 'passkey') throw new HttpError(400, 'ownerIndex must name a Passkey owner of this account');
    const snap = await this.reader.snapshot(intent.source, { gasWallet, recipient: intent.recipient });
    const expected = known.derivation?.owners;
    const v = deploymentVerdict(dep, snap, snap.accountCode ? expected : undefined);
    if (v.stops.length) throw new HttpError(409, `deployment state stop: ${v.stops.map((s) => s.detail).join('; ')}`);
    const deployed = v.complete;
    if (deployed) {
      const live = snap.owners?.find((o) => o.index === ownerIndex);
      if (!live || live.bytes.toLowerCase() !== slot!.bytes.toLowerCase()) throw new HttpError(409, 'the owner at this index changed on chain since the diagnosis; diagnose again');
    }
    const assetBal = intent.asset === 'native' ? snap.balances.native : snap.balances.tokens[intent.asset] ?? null;
    if (assetBal === null) throw new HttpError(409, 'the token balance could not be read on this chain');
    if (assetBal < intent.amount) throw new HttpError(409, `insufficient balance: the account holds ${assetBal} base units, the transfer needs ${intent.amount}`);
    const callData = encodeTransferCall(intent);
    const fees = feePolicy(snap.baseFee, snap.priorityFee);
    const nonce = deployed ? snap.nonce : 0n;
    const needDeploy = deploySteps(dep, this.infra, known).filter((s) => (s.key === 'account' ? v.targets.account !== 'present' : v.targets[s.key] !== 'present'));
    const owners = known.owners;
    const result = await this.forks.run(snap, async (f) => {
      f.guard({ wallets: [intent.source], entryPoint: dep.entryPoint, gasWallet });
      await assertP256Parity(f, snap.p256Probe);
      if (needDeploy.length) await simulateDeploy(f, needDeploy.map((s) => ({ key: s.key, to: s.to, data: s.data })), PREVIEW_SENDER, { synthetic: true, fees });
      const exec = await simulateExecutionOnly(f, dep, intent, callData);
      if (exec.problems.length) throw new HttpError(422, `execution-only simulation failed: ${exec.problems.join('; ')}`);
      const draft: UserOperationV06 = { sender: intent.source, nonce, initCode: '0x', callData, callGasLimit: callGasPolicy(exec.estimate), verificationGasLimit: 2_000_000n, preVerificationGas: 100_000n, ...fees, paymasterAndData: '0x', signature: '0x' };
      const twin = await measureTwinValidation(f, dep, draft, owners, ownerIndex, snap.deposit, snap.balances.native);
      if (twin.sigFailed) throw new HttpError(502, 'twin signature failed validation; refusing to estimate');
      return { exec, twin, draft };
    });
    this.sameEpoch(startEpoch);
    const op: UserOperationV06 = { ...result.draft, verificationGasLimit: verificationGasPolicy(result.twin.validationGas) };
    op.preVerificationGas = preVerificationGasFor({ ...op, signature: ('0x' + 'ff'.repeat(this.maxSigBytes)) as Hex });
    const prefundWei = prefundOf(op);
    const reserveWei = prefundWei > snap.deposit ? prefundWei - snap.deposit : 0n;
    const nativeNeeded = reserveWei + (intent.asset === 'native' ? intent.amount : 0n);
    if (snap.balances.native < nativeNeeded) {
      throw new HttpError(409, intent.asset === 'native'
        ? `available native = balance ${snap.balances.native} − fee reserve ${reserveWei} is below the amount ${intent.amount}; lower the amount or top up the EntryPoint deposit`
        : `the account needs ${reserveWei} wei of native balance for the EntryPoint prefund (deposit covers ${snap.deposit}); it holds ${snap.balances.native}`);
    }
    for (const p of this.plans.values()) if (p.intent.source === intent.source) this.void(p, 'superseded by a newer preview for this account');
    const plan: TransferPlan = {
      id: randomBytes(16).toString('hex'),
      createdAt: this.clock.now(),
      state: 'previewed',
      intent,
      intentHash: intentHash(intent),
      ownerIndex,
      ownerPublicKey: owner.value,
      gasWallet,
      op,
      hash: userOpHash(op, dep.entryPoint, dep.chainId),
      snapshotBlock: snap.block,
      fees,
      signable: deployed,
      notSignableReason: deployed ? null : 'the account is not deployed on this chain yet: this preview assumes nonce 0 after deployment — deploy first, then preview again',
      execOnly: result.exec,
      twin: result.twin,
      prefundWei,
      reserveWei,
      recipientInfo: { hasCode: snap.recipient?.code != null, native: snap.recipient?.native ?? 0n, token: intent.asset === 'native' ? null : snap.recipient?.tokens[intent.asset] ?? null },
      signedOp: null,
      signedSim: null,
      send: null,
      handoff: null,
      rpcEpoch: startEpoch,
      discardReason: null,
    };
    this.plans.set(plan.id, plan);
    return publicPlan(plan, dep);
  }

  private async liveSnapshot(p: TransferPlan): Promise<AccountSnapshot> {
    const snap = await this.reader.snapshot(p.intent.source, { gasWallet: p.gasWallet });
    const v = deploymentVerdict(this.dep, snap, this.accounts.get(p.intent.source)?.derivation?.owners);
    if (!v.complete) throw new HttpError(409, 'the account no longer verifies on chain; diagnose again');
    const live = snap.owners?.find((o) => o.index === p.ownerIndex);
    if (!live || live.bytes.toLowerCase() !== p.ownerPublicKey.toLowerCase()) {
      this.void(p, 'the signing owner changed on chain');
      throw new HttpError(409, 'the owner at this index changed on chain; the plan is void');
    }
    if (snap.nonce !== p.op.nonce) {
      this.void(p, `EntryPoint nonce moved to ${snap.nonce} (the plan used ${p.op.nonce})`);
      throw new HttpError(409, `the EntryPoint nonce is now ${snap.nonce} (this plan used ${p.op.nonce}): another operation ran first — this plan is void, preview again`);
    }
    return snap;
  }

  private async submitSignatureNow(body: Record<string, unknown>) {
    const p = this.plan(body.planId);
    if (p.state !== 'previewed' && p.state !== 'sim-failed') throw new HttpError(409, `plan is ${p.state}`);
    if (!p.signable) throw new HttpError(409, p.notSignableReason ?? 'plan is not signable');
    if (typeof body.intentHash !== 'string' || body.intentHash !== p.intentHash) throw new HttpError(409, 'the intent changed since the preview; preview again');
    if (typeof body.assertion !== 'string') throw new HttpError(400, 'assertion JSON string required');
    const dep = this.dep;
    let sig: Hex;
    try {
      const a = parseAssertionJson(body.assertion, 'userop');
      if (a.authenticatorData.length !== AUTH_DATA_BYTES) throw new SignatureError(`authenticatorData must be ${AUTH_DATA_BYTES} bytes (no extensions)`);
      if (a.clientDataJSON.length > CLIENT_DATA_MAX_BYTES) throw new SignatureError(`clientDataJSON longer than ${CLIENT_DATA_MAX_BYTES} bytes exceeds the gas plan`);
      sig = encodeUserOpSignature(a, p.hash, { publicKeyXY: hexToBytes(p.ownerPublicKey), ownerIndex: BigInt(p.ownerIndex), rpId: dep.rp.id, origin: dep.rp.origin, requireUV: true });
    } catch (e) {
      if (e instanceof SignatureError || e instanceof AssertionFormatError) throw new HttpError(422, e.message);
      throw e;
    }
    if ((sig.length - 2) / 2 > this.maxSigBytes) throw new HttpError(422, 'signature longer than the preVerificationGas bound');
    p.signedOp = { ...p.op, signature: sig };
    p.state = 'sim-failed';
    return this.resimulateNow({ planId: p.id });
  }

  /** Exact signed handleOps on a fresh fork at the current block (also after topping up the gas wallet). */
  private async resimulateNow(body: Record<string, unknown>) {
    const p = this.plan(body.planId);
    if (!p.signedOp || (p.state !== 'sim-failed' && p.state !== 'signed')) throw new HttpError(409, `plan is ${p.state}`);
    const startState = p.state;
    const snap = await this.liveSnapshot(p);
    const fees = feePolicy(snap.baseFee, snap.priorityFee);
    const useFees: Fees = fees.maxFeePerGas > p.fees.maxFeePerGas ? fees : p.fees;
    const op = p.signedOp;
    const sim = await this.forks.run(snap, async (f) => {
      f.guard({ wallets: [p.intent.source], entryPoint: this.dep.entryPoint, gasWallet: p.gasWallet });
      await assertP256Parity(f, snap.p256Probe);
      return simulateSigned(f, this.dep, op, p.intent, p.gasWallet, useFees);
    });
    this.sameEpoch(p.rpcEpoch);
    if ((p.state as TransferState) === 'discarded') throw new HttpError(409, p.discardReason ?? 'plan discarded');
    // Never overwrite a state another request reached meanwhile (a send or a hand-off) with this result.
    if (p.state !== startState) throw new HttpError(409, `plan is now ${p.state}`);
    // The plan shows the fee cap it was simulated with: a raised cap is never sent under the old figure.
    p.fees = useFees;
    p.signedSim = sim;
    p.state = sim.success ? 'signed' : 'sim-failed';
    return publicPlan(p, this.dep);
  }

  /**
   * Issues the exact transaction for the user's wallet, once. Re-reads the nonce, re-runs the signed
   * simulation, and checks the gas wallet can pay. After this the signed op is gone from the sidecar:
   * the browser holds the one transaction until the wallet answers.
   */
  private async sendRequestNow(body: Record<string, unknown>) {
    const p = this.plan(body.planId);
    const via: SendVia = body.via === undefined ? 'browser-wallet' : body.via === 'browser-wallet' || body.via === 'browser-file' || body.via === 'native-signer' ? body.via : (() => { throw new HttpError(400, 'via must be browser-wallet | browser-file | native-signer'); })();
    if (p.state !== 'signed' || !p.signedOp || !p.signedSim?.success) throw new HttpError(409, p.state === 'sending' ? 'a send was already requested for this signature: report the wallet result first (never resend silently)' : `plan is ${p.state}; only a plan whose signed simulation passed can be sent`);
    if (typeof body.intentHash !== 'string' || body.intentHash !== p.intentHash) throw new HttpError(409, 'the intent changed since the preview; preview again');
    // The network max fee the browser showed when the user pressed Send (the plan's figure if not given).
    if (body.shownMaxFeePerGas !== undefined && (typeof body.shownMaxFeePerGas !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(body.shownMaxFeePerGas))) throw new HttpError(400, 'shownMaxFeePerGas must be a decimal string');
    const shown = typeof body.shownMaxFeePerGas === 'string' ? BigInt(body.shownMaxFeePerGas) : p.fees.maxFeePerGas;
    // The network maximum (gas limit × max fee) the browser showed: a larger gas limit at the same price
    // raises it too, and is reconfirmed like a raised price (M3-8).
    if (body.shownNetworkMaxWei !== undefined && (typeof body.shownNetworkMaxWei !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(body.shownNetworkMaxWei))) throw new HttpError(400, 'shownNetworkMaxWei must be a decimal string');
    const shownTotal = typeof body.shownNetworkMaxWei === 'string' ? BigInt(body.shownNetworkMaxWei) : feeSummary(p).networkMaxWei;
    await this.resimulateNow({ planId: p.id });
    const after = this.plan(p.id);
    if (after.state !== 'signed' || !after.signedOp || !after.signedSim?.success) throw new HttpError(409, `the signed simulation no longer passes at the current block: ${after.signedSim?.problems.join('; ') ?? after.state}`);
    const snap = await this.liveSnapshot(after);
    const sim = after.signedSim;
    const data = handleOpsData(after.signedOp, after.gasWallet);
    const fees = feePolicy(snap.baseFee, snap.priorityFee);
    const useFees: Fees = fees.maxFeePerGas > after.fees.maxFeePerGas ? fees : after.fees;
    const gas = sim.outerGasLimit > 0n ? sim.outerGasLimit : outerGasPolicy(0n, after.op);
    if (useFees.maxFeePerGas > shown || gas * useFees.maxFeePerGas > shownTotal) {
      // The cap (price, or gas limit × price) rose above what the user confirmed: nothing is issued. The
      // plan now shows the new figures and the user confirms again (the signature is unchanged — the
      // outer transaction is not part of the UserOp).
      after.fees = useFees;
      return { plan: publicPlan(after, this.dep), tx: null, feeRaised: { shownMaxFeePerGas: shown, maxFeePerGas: useFees.maxFeePerGas, shownNetworkMaxWei: shownTotal, networkMaxWei: gas * useFees.maxFeePerGas } };
    }
    if (!snap.gasWallet || snap.gasWallet.balance < gas * useFees.maxFeePerGas) throw new HttpError(409, `the gas wallet needs ≥ ${gas * useFees.maxFeePerGas} wei for gas ${gas} × max fee ${useFees.maxFeePerGas}; it holds ${snap.gasWallet?.balance ?? 0n}`);
    after.send = { requestedAt: this.clock.now(), inputHash: keccak256(data), gasWalletNonce: snap.gasWallet.nonce, fromBlock: snap.block, outerGasLimit: gas, txHash: null, outcome: 'awaiting-wallet', via, maxFeePerGas: useFees.maxFeePerGas, maxPriorityFeePerGas: useFees.maxPriorityFeePerGas };
    after.state = 'sending';
    const tx = { from: after.gasWallet, to: getAddress(this.dep.entryPoint), data, value: '0x0', gas: '0x' + gas.toString(16), maxFeePerGas: '0x' + useFees.maxFeePerGas.toString(16), maxPriorityFeePerGas: '0x' + useFees.maxPriorityFeePerGas.toString(16), chainId: '0x' + this.dep.chainId.toString(16), ...(RELAY_VIA.has(via) ? { nonce: '0x' + snap.gasWallet.nonce.toString(16) } : {}) };
    // Keep the signed op only until the wallet answers (a rejection may retry with the same signature).
    return { plan: publicPlan(after, this.dep), tx };
  }

  /** The wallet's answer to the one transaction: rejected (nothing sent), a hash, or an error without a hash (unknown). */
  walletResult(body: Record<string, unknown>) {
    const p = this.plans.get(String(body.planId));
    if (!p) throw new HttpError(404, 'unknown plan');
    const outcome = body.outcome;
    // "Nothing sent" told twice: the first report already put the signed plan back (its send cleared), and the
    // page asks again only when that answer was lost on the way — the same fact, so the same answer, not 409.
    if (outcome === 'rejected' && p.state === 'signed' && p.send === null) return publicPlan(p, this.dep);
    if (p.state !== 'sending' || !p.send || p.send.via !== 'browser-wallet') throw new HttpError(409, `plan is ${p.state}; no browser-wallet send is awaiting an answer`);
    if (outcome === 'rejected') {
      p.send = null;
      p.state = p.signedOp ? 'signed' : 'discarded';
    } else if (outcome === 'hash') {
      if (typeof body.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) throw new HttpError(400, 'txHash must be 0x + 64 hex');
      p.send = { ...p.send, txHash: body.txHash.toLowerCase() as Hex, outcome: 'hash' };
      p.state = 'sent';
      p.signedOp = null;
    } else if (outcome === 'no-hash') {
      // The wallet failed without a hash: it may or may not have broadcast. Never assume either.
      p.send = { ...p.send, outcome: 'no-hash' };
      p.state = 'unknown';
      p.signedOp = null;
    } else throw new HttpError(400, 'outcome must be rejected | hash | no-hash');
    return publicPlan(p, this.dep);
  }

  /**
   * File / native-signer path: the outer transaction signed by the user's own gas key comes back as raw
   * bytes. They must be exactly the issued transaction (relay.ts) before they are forwarded, once. A
   * definite node rejection returns the plan to signed (nothing is pending); anything else that is not
   * a hash turns it unknown. Never resent automatically.
   */
  private async relayNow(body: Record<string, unknown>) {
    const p = this.plans.get(String(body.planId));
    if (!p) throw new HttpError(404, 'unknown plan');
    if (p.state !== 'sending' || !p.send || !RELAY_VIA.has(p.send.via) || p.send.outcome !== 'awaiting-wallet') throw new HttpError(409, `plan is ${p.state}; no File or native-signer send is awaiting a signed transaction`);
    if (body.via !== p.send.via) throw new HttpError(409, `this send was issued for ${p.send.via}; the gas payer changed — discard and build a new plan`);
    this.expireBeforeRelay(p);
    if (!this.relay) throw new HttpError(503, 'relay unavailable');
    let signed: unknown = body.raw;
    if (p.send.via === 'native-signer') {
      // The runner's native signer signs only this issued transaction; its key never enters the sidecar.
      if (!this.native) throw new HttpError(503, 'the native signer is not running (start the local runner)');
      if (!p.signedOp) throw new HttpError(409, 'the signed operation is no longer held');
      const data = handleOpsData(p.signedOp, p.gasWallet);
      if (keccak256(data) !== p.send.inputHash) throw new HttpError(500, 'issued input drifted');
      this.signing.add(p.id);
      let ns: Awaited<ReturnType<NativeSign>>;
      try {
        ns = await this.native({ chainId: this.dep.chainId, from: p.gasWallet, to: getAddress(this.dep.entryPoint), data, nonce: p.send.gasWalletNonce, gas: p.send.outerGasLimit, maxFeePerGas: p.send.maxFeePerGas, maxPriorityFeePerGas: p.send.maxPriorityFeePerGas });
      } finally {
        this.signing.delete(p.id);
      }
      // Voided (payer change, RPC switch, expiry) while the native signer was signing: the bytes never left,
      // and they never will — the plan was discarded, so the signed transaction is dropped here.
      if (p.state !== 'sending' || !p.send) throw new HttpError(409, `this plan was voided while the native signer was signing (${p.discardReason ?? 'changed'}); nothing was sent`);
      if (!ns.ok) {
        // The signer refused or is locked: nothing was signed, so nothing can have been sent.
        p.send = null;
        p.state = p.signedOp ? 'signed' : 'discarded';
        throw new HttpError(409, `native signer: ${ns.reason}`, isSignRefusal(ns.code) ? ns.code : 'sign-failed');
      }
      signed = ns.raw;
      // The window may have closed while the native signer waited for the user; the bytes are dropped.
      this.expireBeforeRelay(p);
    } else if (body.raw === undefined) throw new HttpError(400, 'raw signed transaction required');
    const raw = await checkSignedTx(signed, { chainId: this.dep.chainId, from: p.gasWallet, to: getAddress(this.dep.entryPoint), inputHash: p.send.inputHash, nonce: p.send.gasWalletNonce, gas: p.send.outerGasLimit, maxFeePerGas: p.send.maxFeePerGas });
    const r = await this.relay(raw);
    if (r.outcome === 'hash') {
      p.send = { ...p.send, txHash: r.txHash, outcome: 'hash' };
      p.state = 'sent';
      p.signedOp = null;
    } else if (r.outcome === 'rejected') {
      p.send = null;
      p.state = p.signedOp ? 'signed' : 'discarded';
    } else {
      p.send = { ...p.send, outcome: 'no-hash' };
      p.state = 'unknown';
      p.signedOp = null;
    }
    return { plan: publicPlan(p, this.dep), relay: r.outcome === 'hash' ? { outcome: 'hash', txHash: r.txHash } : r };
  }
  /** Past the local validity window nothing is relayed: the plan is discarded here, before any network call. */
  private expireBeforeRelay(p: TransferPlan): void {
    if (this.clock.now() <= p.createdAt + PLAN_TTL_MS) return;
    p.state = 'discarded';
    p.signedOp = null;
    p.send = null;
    p.discardReason ??= 'the local validity window (10 min) ended; this does not revoke a signature already given';
    throw new HttpError(409, `this plan expired before it was sent (${p.discardReason}); nothing was sent — build a new plan`);
  }
  relaySigned(body: Record<string, unknown>) {
    return this.exclusive(body, (b) => this.relayNow(b));
  }
  /** The browser could not get a signature (File key locked, native signer refused): nothing was sent. */
  signerAborted(body: Record<string, unknown>) {
    const p = this.plans.get(String(body.planId));
    if (!p) throw new HttpError(404, 'unknown plan');
    // Already put back by an earlier report whose answer the page never saw: the same answer again (see walletResult).
    if (p.state === 'signed' && p.send === null) return publicPlan(p, this.dep);
    if (p.state !== 'sending' || !p.send || !RELAY_VIA.has(p.send.via) || p.send.outcome !== 'awaiting-wallet') throw new HttpError(409, `plan is ${p.state}; nothing is awaiting a signature`);
    if (this.busy.has(p.id)) throw new HttpError(409, 'a signed transaction for this plan is being relayed; wait for its answer');
    p.send = null;
    p.state = p.signedOp ? 'signed' : 'discarded';
    return publicPlan(p, this.dep);
  }

  /**
   * Advanced path: hands the signed op to the user's Terminal signer instead of the browser wallet.
   * Issues a single-use code (shown once in the browser, typed by the user into the Terminal). From
   * here the plan cannot also be sent from the browser; once claimed it is tracked like any send whose
   * hash the browser does not know (event scan over the nonce), never resent.
   */
  private async handoffNow(body: Record<string, unknown>) {
    const p = this.plan(body.planId);
    if (p.state !== 'signed' || !p.signedOp || !p.signedSim?.success) throw new HttpError(409, `plan is ${p.state}; only a plan whose signed simulation passed can be handed off`);
    if (typeof body.intentHash !== 'string' || body.intentHash !== p.intentHash) throw new HttpError(409, 'the intent changed since the preview; preview again');
    await this.resimulateNow({ planId: p.id });
    const after = this.plan(p.id);
    if (after.state !== 'signed' || !after.signedOp || !after.signedSim?.success) throw new HttpError(409, `the signed simulation no longer passes at the current block: ${after.signedSim?.problems.join('; ') ?? after.state}`);
    const snap = await this.liveSnapshot(after);
    const data = handleOpsData(after.signedOp, after.gasWallet);
    const bytes = randomBytes(10);
    const code = Array.from(bytes, (b) => HANDOFF_ALPHABET[b % HANDOFF_ALPHABET.length]).join('');
    const now = this.clock.now();
    // The code never outlives the plan's own 10-minute window.
    const planEnd = after.createdAt + PLAN_TTL_MS;
    after.handoff = { codeHash: createHash('sha256').update(code).digest(), expiresAt: Math.min(now + HANDOFF_TTL_MS, planEnd) };
    after.send = { requestedAt: now, inputHash: keccak256(data), gasWalletNonce: snap.gasWallet?.nonce ?? 0n, fromBlock: snap.block, outerGasLimit: after.signedSim.outerGasLimit, txHash: null, outcome: 'awaiting-wallet', via: 'terminal-signer', maxFeePerGas: after.fees.maxFeePerGas, maxPriorityFeePerGas: after.fees.maxPriorityFeePerGas };
    after.state = 'sending';
    return { plan: publicPlan(after, this.dep), code: `${code.slice(0, 5)}-${code.slice(5)}` };
  }

  /** The Terminal signer's claim: one code, one use. Returns the signed op once, then forgets it. */
  claim(body: Record<string, unknown>) {
    const typed = typeof body.code === 'string' ? body.code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
    const h = createHash('sha256').update(typed).digest();
    const now = this.clock.now();
    for (const p of this.plans.values()) {
      if (!p.handoff || !timingSafeEqual(p.handoff.codeHash, h)) continue;
      // Both deadlines hold: the code's and the plan's validity window. An expired plan is voided here,
      // while its hand-off is still unclaimed (nothing can have been sent with it).
      const planExpired = now > p.createdAt + PLAN_TTL_MS;
      const expired = planExpired || now > p.handoff.expiresAt;
      if (planExpired) this.void(p, 'the local validity window (10 min) ended; this does not revoke a signature already given');
      p.handoff = null;
      if (expired || p.state !== 'sending' || !p.signedOp || p.send?.via !== 'terminal-signer') {
        if (p.state === 'sending') {
          // The code was never used: nothing can have been broadcast with it; return to signed.
          p.state = p.signedOp ? 'signed' : 'discarded';
          p.send = null;
        }
        throw new HttpError(410, 'hand-off code expired or already used; create a new one in the browser');
      }
      const op = p.signedOp;
      p.signedOp = null;
      p.state = 'unknown';
      p.send = { ...p.send, outcome: 'no-hash' };
      p.discardReason = 'handed to the Terminal signer: the browser does not know whether it was sent — track it';
      const str = (v: bigint) => v.toString();
      return {
        op: { sender: op.sender, nonce: str(op.nonce), initCode: op.initCode, callData: op.callData, callGasLimit: str(op.callGasLimit), verificationGasLimit: str(op.verificationGasLimit), preVerificationGas: str(op.preVerificationGas), maxFeePerGas: str(op.maxFeePerGas), maxPriorityFeePerGas: str(op.maxPriorityFeePerGas), paymasterAndData: op.paymasterAndData, signature: op.signature },
        userOpHash: p.hash,
        intent: { source: p.intent.source, recipient: p.intent.recipient, asset: p.intent.asset, amount: p.intent.amount.toString() },
        ownerIndex: p.ownerIndex,
        gasWallet: p.gasWallet,
      };
    }
    throw new HttpError(404, 'no plan is waiting for this code');
  }

  /**
   * The gas payer changed (mode, provider, account, 1Password item/field, File key): every plan built for
   * the previous payer is voided. A send already requested may be on chain, so it turns unknown and stays
   * trackable; nothing is ever resent.
   */
  payerChanged(body: Record<string, unknown>) {
    const reason = typeof body.reason === 'string' && /^[a-z-]{1,40}$/.test(body.reason) ? body.reason : 'changed';
    let voided = 0;
    for (const p of this.plans.values()) {
      const before = p.state;
      this.void(p, `the gas payer changed (${reason}); build a new plan`);
      if (p.state !== before) voided++;
    }
    return { voided };
  }

  discard(body: Record<string, unknown>) {
    const p = this.plan(body.planId);
    this.void(p, 'discarded in the browser');
    return publicPlan(p, this.dep);
  }

  /** Expiry, supersession, RPC switch, nonce race. Unsent plans are discarded; a requested send turns unknown (it may be on chain). */
  // One request per plan at a time. Every step that awaits (signature check, re-simulation, send
  // request, hand-off) holds the plan, so two concurrent Send presses cannot both pass the "signed"
  // check and issue the same signed operation twice.
  private readonly busy = new Set<string>();
  /** Plans whose relay is waiting for the native signer: nothing has reached the network yet. */
  private readonly signing = new Set<string>();
  private async exclusive<T>(body: Record<string, unknown>, run: (b: Record<string, unknown>) => Promise<T>): Promise<T> {
    const id = String(body.planId);
    if (this.busy.has(id)) throw new HttpError(409, 'another request for this plan is still running; wait for it (a signed operation is never issued twice)');
    this.busy.add(id);
    try {
      return await run(body);
    } finally {
      this.busy.delete(id);
    }
  }
  submitSignature(body: Record<string, unknown>) {
    return this.exclusive(body, (b) => this.submitSignatureNow(b));
  }
  /** Exact signed handleOps on a fresh fork at the current block (also after topping up the gas wallet). */
  resimulate(body: Record<string, unknown>) {
    return this.exclusive(body, (b) => this.resimulateNow(b));
  }
  sendRequest(body: Record<string, unknown>) {
    return this.exclusive(body, (b) => this.sendRequestNow(b));
  }
  handoff(body: Record<string, unknown>) {
    return this.exclusive(body, (b) => this.handoffNow(b));
  }

  private void(p: TransferPlan, reason: string): void {
    if (p.state === 'previewed' || p.state === 'signed' || p.state === 'sim-failed') {
      p.state = 'discarded';
      p.signedOp = null;
      p.discardReason ??= reason;
    } else if (p.state === 'sending' && p.handoff) {
      // An unclaimed Terminal hand-off: the signed op never left the sidecar, so nothing was sent.
      p.state = 'discarded';
      p.signedOp = null;
      p.handoff = null;
      p.send = null;
      p.discardReason ??= `${reason} (the Terminal hand-off code was not used)`;
    } else if (p.state === 'sending' && p.send && RELAY_VIA.has(p.send.via) && p.send.outcome === 'awaiting-wallet' && (!this.busy.has(p.id) || this.signing.has(p.id))) {
      // File / native-signer: bytes reach the network only through relaySigned, which is not running (or is
      // still waiting for the native signer, and re-checks the plan before relaying), so nothing was sent.
      p.state = 'discarded';
      p.signedOp = null;
      p.send = null;
      p.discardReason ??= `${reason} (no signed transaction had reached the relay)`;
    } else if (p.state === 'sending') {
      p.state = 'unknown';
      p.signedOp = null;
      p.discardReason ??= `${reason} while a send was awaiting the wallet — track it`;
      if (p.send) p.send = { ...p.send, outcome: 'no-hash' };
    }
  }
}
