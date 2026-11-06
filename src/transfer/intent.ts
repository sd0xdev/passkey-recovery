// Per-user transfer intent (M3). Source account, recipient, asset and amount are all chosen by the user;
// there are no defaults. Shared by the browser and the sidecar: the sidecar re-parses every field and
// re-derives the calldata from the intent, never from anything the browser computed. An intent is
// immutable once previewed — its hash binds the preview, the signature request and the send request.
import { decodeFunctionData, encodeFunctionData, getAddress, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { assetOf, infraAddresses, type AssetInfo, type SupportedDeployment } from '../config/registry';

export class IntentError extends Error {
  override name = 'IntentError';
}

export const WALLET_EXEC_ABI = parseAbi(['function execute(address target, uint256 value, bytes data)']);
export const ERC20_TRANSFER_ABI = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
export const SELECTOR_EXECUTE = '0xb61d27f6';
export const SELECTOR_TRANSFER = '0xa9059cbb';
export const UINT256_MAX = (1n << 256n) - 1n;

export interface TransferIntent {
  chainId: number;
  deploymentId: string;
  source: Address;
  recipient: Address;
  /** 'native' or the token address. */
  asset: 'native' | Address;
  /** Base units. */
  amount: bigint;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** 0x + 40 hex; mixed case must be valid EIP-55. Returns the checksummed form. */
export function parseAddress(input: unknown, field: string): Address {
  if (typeof input !== 'string') throw new IntentError(`${field}: expected 0x followed by 40 hex characters`);
  const s = input.trim();
  if (!ADDR_RE.test(s)) throw new IntentError(`${field}: expected 0x followed by 40 hex characters`);
  const body = s.slice(2);
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  const sum = getAddress(s.toLowerCase());
  if (mixed && sum !== s) throw new IntentError(`${field}: EIP-55 checksum mismatch — re-check every character`);
  return sum;
}

export function parseUnitsStrict(input: unknown, decimals: number): bigint {
  if (typeof input !== 'string') throw new IntentError('amount must be a decimal string');
  const re = decimals === 0 ? /^(0|[1-9][0-9]{0,77})$/ : new RegExp(`^(0|[1-9][0-9]{0,77})(\\.[0-9]{1,${decimals}})?$`);
  if (!re.test(input)) throw new IntentError(`amount: digits with at most ${decimals} decimals (no sign, spaces, commas or exponent)`);
  const [whole, frac = ''] = input.split('.') as [string, string?];
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (units === 0n) throw new IntentError('amount must be greater than 0');
  if (units > UINT256_MAX) throw new IntentError('amount exceeds uint256');
  return units;
}

/** Exact decimal rendering of base units: every digit, no rounding, no grouping. */
export function formatUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const frac = decimals === 0 ? '' : (u % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${u / base}${frac ? '.' + frac : ''}`;
}

export function forbiddenRecipientReason(dep: SupportedDeployment, source: Address, recipient: Address): string | null {
  if (BigInt(recipient) === 0n) return 'the zero address';
  if (recipient === source) return 'the source account itself';
  if (infraAddresses(dep).includes(recipient)) return 'an infrastructure or token contract (funds would be stuck)';
  return null;
}

/** Validates untrusted input into an intent for one supported deployment. */
export function parseIntent(dep: SupportedDeployment, input: { source: unknown; recipient: unknown; asset: unknown; amount: unknown }): TransferIntent {
  const source = parseAddress(input.source, 'source account');
  const recipient = parseAddress(input.recipient, 'recipient');
  const why = forbiddenRecipientReason(dep, source, recipient);
  if (why) throw new IntentError(`recipient cannot be ${why}`);
  if (typeof input.asset !== 'string') throw new IntentError('asset: choose one of the supported assets');
  const info = assetOf(dep, input.asset);
  if (!info) throw new IntentError('asset: not in the supported registry for this chain');
  return { chainId: dep.chainId, deploymentId: dep.id, source, recipient, asset: info.id, amount: parseUnitsStrict(input.amount, info.decimals) };
}

export function intentAsset(dep: SupportedDeployment, i: TransferIntent): AssetInfo {
  const a = assetOf(dep, i.asset);
  if (!a) throw new IntentError('asset not supported');
  return a;
}

export function encodeTransferCall(i: TransferIntent): Hex {
  if (i.asset === 'native') return encodeFunctionData({ abi: WALLET_EXEC_ABI, functionName: 'execute', args: [i.recipient, i.amount, '0x'] });
  const inner = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [i.recipient, i.amount] });
  return encodeFunctionData({ abi: WALLET_EXEC_ABI, functionName: 'execute', args: [i.asset, 0n, inner] });
}

/** Strict inverse: anything that does not re-encode to identical bytes is rejected (batch, approve, padding…). */
export function decodeTransferCall(dep: SupportedDeployment, source: Address, callData: Hex): TransferIntent {
  const data = callData.toLowerCase() as Hex;
  if (!data.startsWith(SELECTOR_EXECUTE)) throw new IntentError(`selector ${data.slice(0, 10)} is not execute(address,uint256,bytes)`);
  let args;
  try {
    args = decodeFunctionData({ abi: WALLET_EXEC_ABI, data }).args;
  } catch {
    throw new IntentError('malformed execute() arguments');
  }
  const [target, value, inner] = args;
  const token = assetOf(dep, target);
  let partial: { recipient: Address; asset: TransferIntent['asset']; amount: bigint };
  if (token && !token.native) {
    if (value !== 0n) throw new IntentError('token call must carry 0 native value');
    if (!inner.toLowerCase().startsWith(SELECTOR_TRANSFER)) throw new IntentError(`inner selector ${inner.slice(0, 10)} is not transfer(address,uint256)`);
    let t;
    try {
      t = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: inner }).args;
    } catch {
      throw new IntentError('malformed transfer() arguments');
    }
    partial = { recipient: getAddress(t[0]), asset: token.id, amount: t[1] };
  } else {
    if (inner !== '0x') throw new IntentError('native transfer must have empty data');
    partial = { recipient: getAddress(target), asset: 'native', amount: value };
  }
  const intent: TransferIntent = { chainId: dep.chainId, deploymentId: dep.id, source: getAddress(source), ...partial };
  const why = forbiddenRecipientReason(dep, intent.source, intent.recipient);
  if (why) throw new IntentError(`recipient is ${why}`);
  if (intent.amount === 0n) throw new IntentError('zero amount');
  if (encodeTransferCall(intent).toLowerCase() !== data) throw new IntentError('non-canonical encoding (extra or altered bytes)');
  return intent;
}

/** Canonical JSON (fixed key order, amounts as decimal strings): what the intent hash commits to. */
export function canonicalIntent(i: TransferIntent): string {
  return JSON.stringify({ v: 'cbpr-intent-v1', chainId: i.chainId, deploymentId: i.deploymentId, source: i.source, recipient: i.recipient, asset: i.asset, amount: i.amount.toString() });
}

export function intentHash(i: TransferIntent): Hex {
  return keccak256(toHex(canonicalIntent(i)));
}

/**
 * What a tracking record keeps in place of an address (architecture §6.3; no full addresses at rest):
 * keccak256 of the 20 address bytes — case-independent — plus a short display form (first/last 6 hex).
 */
export function addressDigest(a: Address): Hex {
  return keccak256(getAddress(a));
}
export function addressShort(a: Address): string {
  const c = getAddress(a);
  return `${c.slice(0, 8)}…${c.slice(-6)}`;
}
export const recipientDigest = addressDigest;
export const recipientShort = addressShort;

export function sameIntent(a: TransferIntent, b: TransferIntent): boolean {
  return canonicalIntent(a) === canonicalIntent(b);
}
