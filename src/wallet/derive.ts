// Account derivation for Coinbase Smart Wallet v1.1 (M3). A factory-made wallet's address is
//   CREATE2(factory, salt = keccak256(abi.encode(bytes[] owners, uint256 nonce)), factory.initCodeHash())
// so owners + creation nonce fully determine it. Evidence for an undeployed account (pasted
// createAccount calldata, an initCode, or owners + nonce typed by hand) is accepted only when this
// local derivation lands exactly on the account address; the sidecar then cross-checks factory.getAddress.
import { concat, decodeFunctionData, encodeAbiParameters, encodeFunctionData, getAddress, getContractAddress, keccak256, parseAbi, type Address, type Hex } from 'viem';
import type { SupportedDeployment } from '../config/registry';

export class DeriveError extends Error {
  override name = 'DeriveError';
}

export const CREATE_ACCOUNT_ABI = parseAbi(['function createAccount(bytes[] owners, uint256 nonce) payable returns (address)']);

export type OwnerKind = 'passkey' | 'address' | 'removed' | 'unknown';

export interface OwnerInfo {
  index: number;
  kind: OwnerKind;
  /** passkey: 0x + 128 hex (x‖y); address: checksummed 20-byte address; removed/unknown: raw bytes. */
  value: Hex;
}

export function classifyOwner(index: number, bytes: Hex): OwnerInfo {
  const b = bytes.toLowerCase() as Hex;
  if (b === '0x') return { index, kind: 'removed', value: b };
  const len = (b.length - 2) / 2;
  if (len === 64) return { index, kind: 'passkey', value: b };
  if (len === 32 && /^0x0{24}/.test(b)) return { index, kind: 'address', value: getAddress('0x' + b.slice(-40)) };
  return { index, kind: 'unknown', value: b };
}

export function walletSalt(owners: readonly Hex[], nonce: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes[]' }, { type: 'uint256' }], [[...owners], nonce]));
}

export function deriveAddress(dep: SupportedDeployment, owners: readonly Hex[], nonce: bigint): Address {
  return getContractAddress({ opcode: 'CREATE2', from: dep.factory, salt: walletSalt(owners, nonce), bytecodeHash: dep.proxyInitCodeHash });
}

export function createAccountCalldata(owners: readonly Hex[], nonce: bigint): Hex {
  return encodeFunctionData({ abi: CREATE_ACCOUNT_ABI, functionName: 'createAccount', args: [[...owners], nonce] });
}

export function initCodeFor(dep: SupportedDeployment, owners: readonly Hex[], nonce: bigint): Hex {
  return concat([dep.factory.toLowerCase() as Hex, createAccountCalldata(owners, nonce)]);
}

/** Owner bytes the factory accepts: 32-byte left-padded address or 64-byte P256 public key. */
export function normalizeOwner(input: string): Hex {
  const s = input.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return ('0x' + '0'.repeat(24) + s.slice(2).toLowerCase()) as Hex;
  if (/^0x0{24}[0-9a-fA-F]{40}$/.test(s)) return s.toLowerCase() as Hex;
  if (/^0x[0-9a-fA-F]{128}$/.test(s)) return s.toLowerCase() as Hex;
  if (/^0x04[0-9a-fA-F]{128}$/.test(s)) return ('0x' + s.slice(4).toLowerCase()) as Hex;
  throw new DeriveError('owner must be an address (0x + 40 hex) or a P256 public key (0x + 128 hex, x‖y; a 0x04-prefixed key is accepted)');
}

export interface Derivation {
  owners: Hex[];
  nonce: bigint;
  source: 'calldata' | 'initcode' | 'manual' | 'chain';
}

/**
 * Parses deployment evidence: createAccount calldata, an initCode (factory ‖ calldata) or
 * a manual {owners, nonce}. Strict: the bytes must re-encode identically.
 */
export function parseDerivationEvidence(dep: SupportedDeployment, input: { calldata?: unknown; initCode?: unknown; owners?: unknown; nonce?: unknown }): Derivation {
  const fromCalldata = (hex: string, source: Derivation['source']): Derivation => {
    const data = hex.toLowerCase() as Hex;
    let d;
    try {
      d = decodeFunctionData({ abi: CREATE_ACCOUNT_ABI, data });
    } catch {
      throw new DeriveError('not createAccount(bytes[] owners, uint256 nonce) calldata');
    }
    const owners = d.args[0].map((o) => o.toLowerCase() as Hex);
    const nonce = d.args[1];
    if (createAccountCalldata(owners, nonce).toLowerCase() !== data) throw new DeriveError('non-canonical createAccount encoding');
    return { owners, nonce, source };
  };
  if (typeof input.calldata === 'string' && input.calldata.trim()) {
    const s = input.calldata.trim();
    if (!/^0x([0-9a-fA-F]{2})+$/.test(s)) throw new DeriveError('calldata must be 0x-prefixed hex');
    return fromCalldata(s, 'calldata');
  }
  if (typeof input.initCode === 'string' && input.initCode.trim()) {
    const s = input.initCode.trim();
    if (!/^0x([0-9a-fA-F]{2})+$/.test(s) || s.length < 42) throw new DeriveError('initCode must be factory address ‖ createAccount calldata');
    if (getAddress('0x' + s.slice(2, 42).toLowerCase()) !== getAddress(dep.factory)) throw new DeriveError('initCode factory is not the supported v1.1 factory');
    return fromCalldata('0x' + s.slice(42), 'initcode');
  }
  if (Array.isArray(input.owners)) {
    if (input.owners.length === 0 || input.owners.length > dep.maxOwners) throw new DeriveError(`1 to ${dep.maxOwners} owners`);
    const owners = input.owners.map((o) => {
      if (typeof o !== 'string') throw new DeriveError('owner must be a hex string');
      return normalizeOwner(o);
    });
    if (typeof input.nonce !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(input.nonce)) throw new DeriveError('creation nonce: a non-negative decimal integer (often 0)');
    return { owners, nonce: BigInt(input.nonce), source: 'manual' };
  }
  throw new DeriveError('give createAccount calldata, an initCode, or owners + creation nonce');
}
