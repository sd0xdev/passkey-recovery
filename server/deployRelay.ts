// Deploy steps for gas payers without a browser wallet (File in the page, native signer of the runner).
// A step is issued once — exact to/input/value, the gas wallet's live nonce, the gas limit and fees the
// user confirmed — and the signed bytes must match it before relay.ts forwards them. An issue is
// single-use and short-lived; a second issue of the same step while one is open is refused, so a step
// is never sent twice by this path. Tracking afterwards is the same stateless verifyDeployStep.
import { randomBytes } from 'node:crypto';
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { isSignRefusal } from '../src/config/signerApi';
import type { DeployStep } from './deploy';
import { HttpError } from './http';
import type { Reader } from './reader';
import { checkSignedTx, type NativeSign, type RelayOutcome } from './relay';

export const DEPLOY_ISSUE_TTL_MS = 2 * 60 * 1000;
export const MAX_DEPLOY_GAS = 30_000_000n;
const UINT = /^(0|[1-9][0-9]{0,77})$/;

interface Issue {
  id: string;
  key: string;
  account: Address;
  via: 'browser-file' | 'native-signer';
  from: Address;
  step: DeployStep;
  nonce: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  expiresAt: number;
  busy: boolean;
}

const big = (v: unknown, name: string): bigint => {
  if (typeof v !== 'string' || !UINT.test(v)) throw new HttpError(400, `${name} must be a decimal string`);
  return BigInt(v);
};

export class DeployRelay {
  private issues = new Map<string, Issue>();
  /** account|step slots whose issue is being prepared (awaiting chain reads). */
  private readonly issuing = new Set<string>();

  constructor(
    private readonly reader: Reader,
    private readonly relay: (raw: Hex) => Promise<RelayOutcome>,
    private native: NativeSign | null = null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  bindNativeSigner(fn: NativeSign | null): void {
    this.native = fn;
  }

  /**
   * Every open issue ends (gas payer change, RPC switch): none of them has reached the relay. One still
   * waiting for the native signer ends too — `send` re-checks before relaying (an issue being relayed
   * has already left this map).
   */
  voidAll(): number {
    const n = this.issues.size;
    this.issues.clear();
    return n;
  }

  async issue(step: DeployStep, account: Address, from: Address, body: Record<string, unknown>) {
    const via = body.via === 'browser-file' || body.via === 'native-signer' ? body.via : null;
    if (!via) throw new HttpError(400, 'via must be browser-file | native-signer');
    const gas = big(body.gas, 'gas');
    const maxFeePerGas = big(body.maxFeePerGas, 'maxFeePerGas');
    const maxPriorityFeePerGas = big(body.maxPriorityFeePerGas, 'maxPriorityFeePerGas');
    if (gas <= 0n || gas > MAX_DEPLOY_GAS) throw new HttpError(400, 'gas out of range');
    if (maxPriorityFeePerGas > maxFeePerGas) throw new HttpError(400, 'priority fee above max fee');
    const now = this.now();
    for (const [id, i] of this.issues) if (now > i.expiresAt && !i.busy) this.issues.delete(id);
    const slot = `${account.toLowerCase()}|${step.key}`;
    const open = [...this.issues.values()].some((i) => i.account === account && i.key === step.key);
    if (open || this.issuing.has(slot)) throw new HttpError(409, 'this step was already issued and has not been answered: finish or wait 2 minutes (a step is never issued twice)');
    // Reserved before the first await: two concurrent requests for the same step cannot both pass the check.
    this.issuing.add(slot);
    try {
      return await this.issueChecked(account, from, step, via, gas, maxFeePerGas, maxPriorityFeePerGas, now);
    } finally {
      this.issuing.delete(slot);
    }
  }

  private async issueChecked(account: Address, from: Address, step: DeployStep, via: Issue['via'], gas: bigint, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint, now: number) {
    const head = await this.reader.head();
    const code = await this.reader.code(step.creates, toHex(head.number));
    if (code !== null) throw new HttpError(409, 'the target already holds code: this step is not needed any more — re-check the plan');
    // The mined nonce at the head: a pending transaction of the same wallet makes the node answer
    // "nonce too low", which relay.ts treats as unknown (track), never as "not sent".
    const nonce = await this.reader.txCount(from, toHex(head.number));
    const id = randomBytes(16).toString('base64url');
    this.issues.set(id, { id, key: step.key, account, via, from: getAddress(from), step, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, expiresAt: now + DEPLOY_ISSUE_TTL_MS, busy: false });
    const hex = (v: bigint) => '0x' + v.toString(16);
    return { issueId: id, expiresAt: now + DEPLOY_ISSUE_TTL_MS, tx: { from: getAddress(from), to: getAddress(step.to), data: step.data, value: '0x0', nonce: hex(nonce), gas: hex(gas), maxFeePerGas: hex(maxFeePerGas), maxPriorityFeePerGas: hex(maxPriorityFeePerGas), chainId: hex(BigInt(this.reader.dep.chainId)) } };
  }

  /** Relays the signed step (File: `raw` from the page; native: signed here by the runner's signer). Single use. */
  async send(body: Record<string, unknown>) {
    const i = typeof body.issueId === 'string' ? this.issues.get(body.issueId) : undefined;
    if (!i) throw new HttpError(404, 'unknown or used deploy issue: plan the step again');
    if (i.busy) throw new HttpError(409, 'this step is being relayed; wait for its answer');
    if (this.now() > i.expiresAt) {
      this.issues.delete(i.id);
      throw new HttpError(410, 'the issued step expired (2 min); nothing was sent — plan it again');
    }
    if (body.via !== i.via) throw new HttpError(409, 'the gas payer changed since this step was issued; nothing was sent');
    i.busy = true;
    try {
      let signed: unknown = body.raw;
      if (i.via === 'native-signer') {
        if (!this.native) throw new HttpError(503, 'the native signer is not running (start the local runner)');
        const r = await this.native({ chainId: this.reader.dep.chainId, from: i.from, to: getAddress(i.step.to), data: i.step.data, nonce: i.nonce, gas: i.gas, maxFeePerGas: i.maxFeePerGas, maxPriorityFeePerGas: i.maxPriorityFeePerGas });
        if (!r.ok) {
          this.issues.delete(i.id);
          throw new HttpError(409, `native signer: ${r.reason}`, isSignRefusal(r.code) ? r.code : 'sign-failed');
        }
        signed = r.raw;
      }
      const raw = await checkSignedTx(signed, { chainId: this.reader.dep.chainId, from: i.from, to: getAddress(i.step.to), inputHash: keccak256(i.step.data), nonce: i.nonce, gas: i.gas, maxFeePerGas: i.maxFeePerGas });
      // Voided while it was being signed or checked (payer or RPC change): the signature is dropped unsent.
      if (this.issues.get(i.id) !== i) throw new HttpError(409, 'the gas payer or RPC changed while this step was being signed; nothing was sent — plan it again');
      // The 2 min window can close while the native signer waits for the user: the signature is dropped unsent.
      if (this.now() > i.expiresAt) {
        this.issues.delete(i.id);
        throw new HttpError(410, 'the issued step expired (2 min) while it was being signed; nothing was sent — plan it again');
      }
      // From here the bytes leave the sidecar: the issue is spent whatever the answer.
      this.issues.delete(i.id);
      return { key: i.key, ...(await this.relay(raw)) };
    } finally {
      i.busy = false;
    }
  }

  /** The page could not sign (File key locked or the user cancelled): nothing was sent; the issue ends. */
  abort(body: Record<string, unknown>) {
    const i = typeof body.issueId === 'string' ? this.issues.get(body.issueId) : undefined;
    if (!i) return { aborted: false };
    if (i.busy) throw new HttpError(409, 'this step is being relayed; wait for its answer');
    this.issues.delete(i.id);
    return { aborted: true };
  }
}
