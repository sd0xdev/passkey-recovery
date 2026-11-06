// Independent checks the Terminal signer applies before it will sign (tech spec §5.2, M3). It trusts
// nothing from the browser or the sidecar: the claimed UserOp is decoded and bounded here, its callData
// must decode to exactly the claimed intent, and its Passkey signature is re-verified against the owner
// the signer itself reads from the chain at the signature's owner index.
import { getAddress, type Hex } from 'viem';
import type { SupportedDeployment } from '../../src/config/registry';
import { hexToBytes, utf8 } from '../../src/crypto/bytes';
import { encodeDerSignature } from '../../src/crypto/p256';
import { decodeTransferCall, sameIntent, type TransferIntent } from '../../src/transfer/intent';
import { userOpHash, type UserOperationV06 } from '../../src/userop/hash';
import { decodeUserOpSignature } from '../../src/userop/signature';
import { verifyAssertion } from '../../src/webauthn/verify';
import { AUTH_DATA_BYTES, CLIENT_DATA_MAX_BYTES } from '../sim';

export class SignerCheckError extends Error {
  override name = 'SignerCheckError';
}

/** Ceilings the local signer enforces on any UserOp / outer transaction it is asked to sign. */
export const SIGNER_CAPS = {
  callGasLimit: 500_000n,
  verificationGasLimit: 2_000_000n,
  preVerificationGas: 200_000n,
  maxFeePerGas: 100n * 10n ** 9n,
  outerGas: 6_000_000n,
  /** Upper bound on one transaction's maximum fee (gas × maxFee) in wei: 0.05 of the native unit. */
  maxTxCostWei: 5n * 10n ** 16n,
} as const;

const UINT = /^[0-9]+$/;
const HEX = /^0x[0-9a-fA-F]*$/;

/** Parses the sidecar's JSON (bigints as decimal strings) into a UserOp, rejecting any extra or missing field. */
export function parseClaimedOp(raw: unknown): UserOperationV06 {
  const keys = ['sender', 'nonce', 'initCode', 'callData', 'callGasLimit', 'verificationGasLimit', 'preVerificationGas', 'maxFeePerGas', 'maxPriorityFeePerGas', 'paymasterAndData', 'signature'];
  if (typeof raw !== 'object' || raw === null) throw new SignerCheckError('op must be an object');
  const o = raw as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== [...keys].sort().join()) throw new SignerCheckError('op has unexpected or missing fields');
  const u = (k: string) => {
    const v = o[k];
    if (typeof v !== 'string' || !UINT.test(v) || v.length > 78) throw new SignerCheckError(`${k} must be a decimal integer string`);
    return BigInt(v);
  };
  const h = (k: string) => {
    const v = o[k];
    if (typeof v !== 'string' || !HEX.test(v) || v.length % 2) throw new SignerCheckError(`${k} must be 0x hex`);
    return v.toLowerCase() as Hex;
  };
  const sender = o.sender;
  if (typeof sender !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(sender)) throw new SignerCheckError('sender malformed');
  return { sender: getAddress(sender), nonce: u('nonce'), initCode: h('initCode'), callData: h('callData'), callGasLimit: u('callGasLimit'), verificationGasLimit: u('verificationGasLimit'), preVerificationGas: u('preVerificationGas'), maxFeePerGas: u('maxFeePerGas'), maxPriorityFeePerGas: u('maxPriorityFeePerGas'), paymasterAndData: h('paymasterAndData'), signature: h('signature') };
}

export interface OpCheckOpts {
  dep: SupportedDeployment;
  /** The intent the claim says this op carries; callData must decode to exactly it. */
  intent: TransferIntent;
  /** The owner's public key as read from the chain by the signer at `ownerIndex`. */
  ownerPublicKey: Hex;
  ownerIndex: bigint;
  maxSignatureBytes: number;
}

/** Static checks on the claimed op; returns the hash. Chain-state checks are separate. */
export function checkTransferOp(op: UserOperationV06, o: OpCheckOpts): { hash: Hex } {
  if (getAddress(op.sender) !== o.intent.source) throw new SignerCheckError(`sender ${op.sender} is not the intent's source account`);
  if (op.initCode !== '0x') throw new SignerCheckError('initCode must be empty (account already deployed)');
  if (op.paymasterAndData !== '0x') throw new SignerCheckError('paymasterAndData must be empty');
  if (op.nonce >> 64n !== 0n) throw new SignerCheckError('nonce key must be 0');
  let decoded: TransferIntent;
  try {
    decoded = decodeTransferCall(o.dep, op.sender, op.callData);
  } catch (e) {
    throw new SignerCheckError(`callData rejected: ${(e as Error).message}`);
  }
  if (!sameIntent(decoded, o.intent)) throw new SignerCheckError('callData does not carry exactly the claimed intent');
  const caps: Array<[string, bigint, bigint]> = [
    ['callGasLimit', op.callGasLimit, SIGNER_CAPS.callGasLimit],
    ['verificationGasLimit', op.verificationGasLimit, SIGNER_CAPS.verificationGasLimit],
    ['preVerificationGas', op.preVerificationGas, SIGNER_CAPS.preVerificationGas],
    ['maxFeePerGas', op.maxFeePerGas, SIGNER_CAPS.maxFeePerGas],
  ];
  for (const [k, v, cap] of caps) if (v > cap) throw new SignerCheckError(`${k} ${v} exceeds the signer cap ${cap}`);
  if (op.maxPriorityFeePerGas > op.maxFeePerGas) throw new SignerCheckError('maxPriorityFeePerGas > maxFeePerGas');
  const hash = userOpHash(op, o.dep.entryPoint, o.dep.chainId);
  if ((op.signature.length - 2) / 2 > o.maxSignatureBytes) throw new SignerCheckError('signature longer than the gas plan allows');
  let s;
  try {
    s = decodeUserOpSignature(op.signature);
  } catch {
    throw new SignerCheckError('signature is not a SignatureWrapper(WebAuthnAuth)');
  }
  if (s.ownerIndex !== o.ownerIndex) throw new SignerCheckError(`signature uses ownerIndex ${s.ownerIndex}, the claim says ${o.ownerIndex}`);
  const authenticatorData = hexToBytes(s.authenticatorData);
  const clientDataJSON = utf8(s.clientDataJSON);
  if (authenticatorData.length !== AUTH_DATA_BYTES || clientDataJSON.length > CLIENT_DATA_MAX_BYTES) throw new SignerCheckError('signature payload outside the gas plan bounds');
  if (s.clientDataJSON.indexOf('"challenge":"') !== Number(s.challengeIndex) || s.clientDataJSON.indexOf('"type":"webauthn.get"') !== Number(s.typeIndex)) throw new SignerCheckError('challengeIndex/typeIndex do not point at the expected substrings');
  const r = verifyAssertion(
    { kind: 'userop', reportedOrigin: o.dep.rp.origin, credentialId: new Uint8Array(0), authenticatorData, clientDataJSON, signatureDer: encodeDerSignature({ r: s.r, s: s.s }), userHandle: null },
    { expectedChallenge: hexToBytes(hash), publicKeyXY: hexToBytes(o.ownerPublicKey), rpId: o.dep.rp.id, origin: o.dep.rp.origin, requireUV: true, ownerIndex: o.ownerIndex },
  );
  if (!r.allOk) throw new SignerCheckError(`Passkey signature does not authorize this userOpHash: ${r.checks.filter((c) => !c.ok).map((c) => c.id).join(', ')}`);
  return { hash };
}

/** Outer transaction bounds for both deploy steps and handleOps. */
export function checkOuter(gas: bigint, maxFeePerGas: bigint, balance: bigint, perTxCap: bigint = SIGNER_CAPS.maxTxCostWei): void {
  if (gas > SIGNER_CAPS.outerGas) throw new SignerCheckError(`gas ${gas} exceeds the signer cap ${SIGNER_CAPS.outerGas}`);
  if (maxFeePerGas > SIGNER_CAPS.maxFeePerGas) throw new SignerCheckError('maxFeePerGas exceeds the signer cap');
  const max = gas * maxFeePerGas;
  if (max > perTxCap) throw new SignerCheckError(`maximum fee ${max} wei exceeds the per-transaction cap ${perTxCap}`);
  if (balance < max) throw new SignerCheckError(`gas wallet holds ${balance} wei; this transaction may cost up to ${max} wei — fund the gas wallet first`);
}

/** The exact phrase the user must type for one transaction; binds asset/amount/nonce or step/nonce. */
export function confirmationPhrase(kind: 'deploy' | 'send', a: { step?: string; amount?: string; asset?: string; nonce: bigint }): string {
  return kind === 'deploy' ? `DEPLOY ${a.step!.toUpperCase()} NONCE ${a.nonce}` : `SEND ${a.amount} ${a.asset} NONCE ${a.nonce}`;
}
