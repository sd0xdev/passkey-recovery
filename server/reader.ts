// Allowlisted reads against the upstream (tech spec §4.2, M3 generalisation). Every snapshot is pinned
// to one block. The allowlist is closed by *shape*, not by address: each eth_call payload is decoded by
// its selector and must re-encode to the identical bytes, and only view functions of the supported
// deployment are admitted (token balanceOf, EntryPoint getNonce(key 0)/balanceOf, wallet owner reads,
// factory getAddress/initCodeHash, one fixed P256 probe). Every call carrying a UserOp (handleOps,
// simulate*) is absent by construction — signed data never leaves this machine through the reader.
// eth_getLogs is admitted only for EntryPoint UserOperationEvent by one userOpHash over ≤ 2000 blocks.
// Chain identity is chainId + genesis hash, re-checked on every snapshot; every snapshot re-reads its
// block header at the end and fails if the hash moved (reorg or split backends).
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { ERC1967_IMPLEMENTATION_SLOT, SUPPORTED, tokenAssets, type SupportedDeployment } from '../src/config/registry';
import { EP_ABI, ERC20_READ_ABI, FACTORY_ABI, USER_OP_EVENT_TOPIC, WALLET_READ_ABI } from './abi';
import { P256_PROBE } from './p256probe';
import { UpstreamError, type Upstream } from './upstream';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const TAG = /^0x[0-9a-f]{1,16}$/;
const DATA = /^0x([0-9a-fA-F]{2})*$/;
export const MAX_LOG_RANGE = 2000n;

/** Synthetic accounts used only by the capability probe; never funded, never a real user's address. */
export const PROBE_FROM: Address = '0x00000000000000000000000000000000000c0de1';
export const PROBE_TO: Address = '0x00000000000000000000000000000000000c0de2';
/** PUSH1 1 PUSH1 0 MSTORE PUSH1 32 PUSH1 0 RETURN — returns uint256(1) when the state override is honoured. */
export const PROBE_OVERRIDE_CODE: Hex = '0x600160005260206000f3';
export const PROBE_ESTIMATE = { from: PROBE_FROM, to: PROBE_TO, value: '0x0' } as const;

export type CallSpec =
  | { kind: 'tokenBalance'; token: Address; owner: Address }
  | { kind: 'epNonce'; account: Address }
  | { kind: 'epDeposit'; account: Address }
  | { kind: 'ownerAtIndex'; account: Address; index: bigint }
  | { kind: 'nextOwnerIndex'; account: Address }
  | { kind: 'removedOwnersCount'; account: Address }
  | { kind: 'factoryGetAddress'; owners: Hex[]; nonce: bigint }
  | { kind: 'initCodeHash' }
  | { kind: 'p256Probe' };

/** Builds the exact {to, data} for an allowlisted view call. */
export function encodeCall(dep: SupportedDeployment, c: CallSpec): { to: Address; data: Hex } {
  const lo = (to: Address, data: Hex) => ({ to: getAddress(to), data: data.toLowerCase() as Hex });
  switch (c.kind) {
    case 'tokenBalance':
      return lo(c.token, encodeFunctionData({ abi: ERC20_READ_ABI, functionName: 'balanceOf', args: [c.owner] }));
    case 'epNonce':
      return lo(dep.entryPoint, encodeFunctionData({ abi: EP_ABI, functionName: 'getNonce', args: [c.account, 0n] }));
    case 'epDeposit':
      return lo(dep.entryPoint, encodeFunctionData({ abi: EP_ABI, functionName: 'balanceOf', args: [c.account] }));
    case 'ownerAtIndex':
      return lo(c.account, encodeFunctionData({ abi: WALLET_READ_ABI, functionName: 'ownerAtIndex', args: [c.index] }));
    case 'nextOwnerIndex':
      return lo(c.account, encodeFunctionData({ abi: WALLET_READ_ABI, functionName: 'nextOwnerIndex' }));
    case 'removedOwnersCount':
      return lo(c.account, encodeFunctionData({ abi: WALLET_READ_ABI, functionName: 'removedOwnersCount' }));
    case 'factoryGetAddress':
      return lo(dep.factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: 'getAddress', args: [c.owners, c.nonce] }));
    case 'initCodeHash':
      return lo(dep.factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: 'initCodeHash' }));
    case 'p256Probe':
      return lo(P256_PROBE.to, P256_PROBE.data);
  }
}

/** Decodes an eth_call {to, data} back into an allowlisted CallSpec, or null. Exported for tests. */
export function classifyCall(dep: SupportedDeployment, to: string, data: string): CallSpec | null {
  if (!ADDR.test(to) || !DATA.test(data)) return null;
  const target = getAddress(to.toLowerCase());
  const d = data.toLowerCase() as Hex;
  const tryDecode = <A extends readonly unknown[]>(abi: A) => {
    try {
      return decodeFunctionData({ abi: abi as never, data: d }) as { functionName: string; args?: readonly unknown[] };
    } catch {
      return null;
    }
  };
  const candidates: CallSpec[] = [];
  if (target === getAddress(P256_PROBE.to)) candidates.push({ kind: 'p256Probe' });
  if (tokenAssets(dep).some((t) => getAddress(t.id) === target)) {
    const f = tryDecode(ERC20_READ_ABI);
    if (f?.functionName === 'balanceOf') candidates.push({ kind: 'tokenBalance', token: target, owner: f.args![0] as Address });
  }
  if (target === getAddress(dep.entryPoint)) {
    const f = tryDecode(EP_ABI);
    if (f?.functionName === 'getNonce' && f.args![1] === 0n) candidates.push({ kind: 'epNonce', account: f.args![0] as Address });
    if (f?.functionName === 'balanceOf') candidates.push({ kind: 'epDeposit', account: f.args![0] as Address });
  }
  if (target === getAddress(dep.factory)) {
    const f = tryDecode(FACTORY_ABI);
    if (f?.functionName === 'getAddress') candidates.push({ kind: 'factoryGetAddress', owners: [...(f.args![0] as Hex[])], nonce: f.args![1] as bigint });
    if (f?.functionName === 'initCodeHash') candidates.push({ kind: 'initCodeHash' });
  }
  const w = tryDecode(WALLET_READ_ABI);
  if (w?.functionName === 'ownerAtIndex' && (w.args![0] as bigint) < BigInt(dep.maxOwners)) candidates.push({ kind: 'ownerAtIndex', account: target, index: w.args![0] as bigint });
  if (w?.functionName === 'nextOwnerIndex') candidates.push({ kind: 'nextOwnerIndex', account: target });
  if (w?.functionName === 'removedOwnersCount') candidates.push({ kind: 'removedOwnersCount', account: target });
  // Canonical only: the candidate must re-encode to exactly the bytes asked for (no trailing data, no dirty padding).
  return candidates.find((c) => { const e = encodeCall(dep, c); return e.to === target && e.data === d; }) ?? null;
}

/** Throws unless (method, params) is a read this server is allowed to send upstream. Exported for tests. */
export function assertReadAllowed(method: string, params: unknown[], dep: SupportedDeployment = SUPPORTED[0]!): void {
  const deny = (why: string): never => {
    throw new UpstreamError('not-allowed', `${method}: ${why}`);
  };
  const tagOk = (t: unknown) => typeof t === 'string' && TAG.test(t);
  const addrOk = (a: unknown) => typeof a === 'string' && ADDR.test(a);
  switch (method) {
    case 'eth_chainId':
    case 'eth_blockNumber':
    case 'eth_maxPriorityFeePerGas':
      if (params.length !== 0) deny('takes no params');
      return;
    case 'eth_getBlockByNumber':
      if (params.length !== 2 || !(tagOk(params[0]) || params[0] === 'latest') || params[1] !== false) deny('expects [blockTag, false]');
      return;
    case 'eth_getBalance':
    case 'eth_getTransactionCount':
    case 'eth_getCode':
      if (params.length !== 2 || !addrOk(params[0]) || !tagOk(params[1])) deny('expects [address, hexBlock]');
      return;
    case 'eth_getStorageAt':
      if (params.length !== 3 || !addrOk(params[0]) || params[1] !== ERC1967_IMPLEMENTATION_SLOT || !tagOk(params[2])) deny('only the ERC-1967 implementation slot');
      return;
    case 'eth_call': {
      const c = params[0] as { to?: unknown; data?: unknown } | null;
      if (params.length === 3) {
        const o = params[2] as Record<string, { code?: unknown }> | null;
        const ok = typeof c === 'object' && c !== null && Object.keys(c).sort().join() === 'data,to' && c.to === PROBE_TO && c.data === '0x' && tagOk(params[1]) &&
          typeof o === 'object' && o !== null && Object.keys(o).join() === PROBE_TO && Object.keys(o[PROBE_TO] ?? {}).join() === 'code' && o[PROBE_TO]!.code === PROBE_OVERRIDE_CODE;
        if (!ok) deny('state override only for the fixed capability-probe payload');
        return;
      }
      if (params.length !== 2 || typeof c !== 'object' || c === null || Object.keys(c).sort().join() !== 'data,to' || !tagOk(params[1])) deny('expects [{to,data}, hexBlock]');
      if (typeof c!.to !== 'string' || typeof c!.data !== 'string' || classifyCall(dep, c!.to, c!.data) === null) deny('payload not allowlisted');
      return;
    }
    case 'eth_estimateGas': {
      const c = params[0] as Record<string, unknown> | null;
      const ok = params.length === 1 && typeof c === 'object' && c !== null && Object.keys(c).sort().join() === 'from,to,value' && c.from === PROBE_ESTIMATE.from && c.to === PROBE_ESTIMATE.to && c.value === '0x0';
      if (!ok) deny('only the fixed capability-probe payload');
      return;
    }
    case 'eth_getTransactionByHash':
    case 'eth_getTransactionReceipt':
      if (params.length !== 1 || typeof params[0] !== 'string' || !HASH.test(params[0])) deny('expects [txHash]');
      return;
    case 'eth_getLogs': {
      const f = params[0] as Record<string, unknown> | null;
      const ok = params.length === 1 && typeof f === 'object' && f !== null && Object.keys(f).sort().join() === 'address,fromBlock,toBlock,topics' &&
        typeof f.address === 'string' && ADDR.test(f.address) && getAddress(f.address) === getAddress(dep.entryPoint) && tagOk(f.fromBlock) && tagOk(f.toBlock) &&
        Array.isArray(f.topics) && f.topics.length === 2 && f.topics[0] === USER_OP_EVENT_TOPIC && typeof f.topics[1] === 'string' && HASH.test(f.topics[1]);
      if (!ok) deny('only EntryPoint UserOperationEvent by userOpHash');
      const from = BigInt(f!.fromBlock as string), to = BigInt(f!.toBlock as string);
      if (to < from || to - from + 1n > MAX_LOG_RANGE) deny(`block range must be 1..${MAX_LOG_RANGE}`);
      return;
    }
    default:
      deny('method not allowlisted');
  }
}

export interface OwnerSlot {
  index: number;
  /** Raw owner bytes, lower-case; '0x' for a removed slot. */
  bytes: Hex;
}

export interface AccountSnapshot {
  chainId: number;
  block: bigint;
  blockHash: Hex;
  timestamp: bigint;
  baseFee: bigint;
  priorityFee: bigint;
  infraCode: { entryPoint: Hex | null; singletonFactory: Hex | null; implementation: Hex | null; factory: Hex | null };
  account: Address;
  accountCode: Hex | null;
  accountImplementation: Address | null;
  owners: OwnerSlot[] | null;
  nextOwnerIndex: bigint | null;
  removedOwnersCount: bigint | null;
  /** Native balance and every registry token (null = unreadable / token has no code). */
  balances: { native: bigint; tokens: Record<Address, bigint | null> };
  deposit: bigint;
  nonce: bigint;
  p256Probe: Hex;
  recipient: { address: Address; code: Hex | null; native: bigint; tokens: Record<Address, bigint | null> } | null;
  gasWallet: { address: Address; balance: bigint; nonce: bigint } | null;
}

export interface ReaderOptions {
  /** Genesis hash the upstream must report for block 0. null = learn it from the first endpoint (testchain). */
  expectedGenesis?: Hex | null;
  deployment?: SupportedDeployment;
}

export class Reader {
  private expectedGenesis: Hex | null;
  private verifiedFor: string | null = null;
  readonly dep: SupportedDeployment;
  constructor(
    private readonly up: Upstream,
    opts: ReaderOptions = {},
  ) {
    this.expectedGenesis = opts.expectedGenesis ?? null;
    this.dep = opts.deployment ?? SUPPORTED[0]!;
  }

  get upstreamId(): string {
    return this.up.id;
  }

  /** chainId + genesis hash of the endpoint as it answers now. */
  async verifyChain(): Promise<{ chainId: number; genesisHash: Hex }> {
    const id = this.up.id;
    const chainId = await this.chainId();
    if (chainId !== this.dep.chainId) throw new UpstreamError('chain-mismatch', `upstream chainId ${chainId} is not ${this.dep.chainId}`);
    const g = (await this.rpc('eth_getBlockByNumber', ['0x0', false])) as { hash?: unknown } | null;
    if (!g || typeof g.hash !== 'string' || !HASH.test(g.hash)) throw new UpstreamError('bad-response', 'genesis block header missing');
    const genesisHash = g.hash.toLowerCase() as Hex;
    if (this.expectedGenesis === null) this.expectedGenesis = genesisHash;
    if (genesisHash !== this.expectedGenesis.toLowerCase()) throw new UpstreamError('chain-mismatch', `upstream reports chainId ${chainId} but a different genesis block: not the expected chain`);
    this.verifiedFor = id;
    return { chainId, genesisHash };
  }

  get chainVerified(): boolean {
    return this.verifiedFor === this.up.id;
  }

  async rpc(method: string, params: unknown[] = []): Promise<unknown> {
    assertReadAllowed(method, params, this.dep);
    return this.up.call(method, params);
  }

  private async hex(method: string, params: unknown[] = []): Promise<Hex> {
    const r = await this.rpc(method, params);
    if (typeof r !== 'string' || !/^0x[0-9a-fA-F]*$/.test(r)) throw new UpstreamError('bad-response', `${method}: result is not hex`);
    return r as Hex;
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.hex('eth_chainId')));
  }

  async readCall(c: CallSpec, tag: Hex): Promise<Hex> {
    return this.hex('eth_call', [encodeCall(this.dep, c), tag]);
  }

  async uintCall(c: CallSpec, tag: Hex): Promise<bigint | null> {
    const r = await this.readCall(c, tag);
    return r === '0x' ? null : BigInt(r);
  }

  async code(a: Address, tag: Hex): Promise<Hex | null> {
    const c = await this.hex('eth_getCode', [getAddress(a), tag]);
    return c === '0x' ? null : keccak256(c);
  }

  async head(): Promise<{ number: bigint; hash: Hex; timestamp: bigint; baseFee: bigint }> {
    const b = (await this.rpc('eth_getBlockByNumber', ['latest', false])) as Record<string, string> | null;
    if (!b || typeof b.number !== 'string' || typeof b.hash !== 'string') throw new UpstreamError('bad-response', 'block header missing');
    return { number: BigInt(b.number), hash: b.hash as Hex, timestamp: BigInt(b.timestamp ?? '0x0'), baseFee: BigInt(b.baseFeePerGas ?? '0x0') };
  }

  async blockHash(n: bigint): Promise<Hex | null> {
    const b = (await this.rpc('eth_getBlockByNumber', [toHex(n), false])) as { hash?: string } | null;
    return b && typeof b.hash === 'string' ? (b.hash.toLowerCase() as Hex) : null;
  }

  /** Owner slots 0..nextOwnerIndex-1 of a deployed wallet ('0x' marks a removed slot). */
  async owners(account: Address, tag: Hex): Promise<{ owners: OwnerSlot[]; next: bigint; removed: bigint } | null> {
    const next = await this.uintCall({ kind: 'nextOwnerIndex', account }, tag);
    const removed = await this.uintCall({ kind: 'removedOwnersCount', account }, tag);
    if (next === null || removed === null) return null;
    const n = next > BigInt(this.dep.maxOwners) ? BigInt(this.dep.maxOwners) : next;
    const owners: OwnerSlot[] = [];
    for (let i = 0n; i < n; i++) {
      const r = await this.readCall({ kind: 'ownerAtIndex', account, index: i }, tag);
      const bytes = r === '0x' ? '0x' : ((decodeFunctionResult({ abi: WALLET_READ_ABI, functionName: 'ownerAtIndex', data: r }) as Hex).toLowerCase() as Hex);
      owners.push({ index: Number(i), bytes });
    }
    return { owners, next, removed };
  }

  /** Consistent snapshot of one account at one block. Throws on wrong chain or a moved block hash. */
  async snapshot(account: Address, opts: { gasWallet?: Address | null; recipient?: Address | null; at?: bigint | 'latest' } = {}): Promise<AccountSnapshot> {
    const upId = this.up.id;
    const { chainId } = await this.verifyChain();
    const at = opts.at ?? 'latest';
    const blk = (await this.rpc('eth_getBlockByNumber', [at === 'latest' ? 'latest' : toHex(at), false])) as Record<string, string> | null;
    if (!blk || typeof blk.number !== 'string' || typeof blk.hash !== 'string') throw new UpstreamError('bad-response', 'block header missing');
    const block = BigInt(blk.number);
    const tag = toHex(block);
    const dep = this.dep;
    const acct = getAddress(account);
    const [ep, sf, impl, fac, accountCode] = await Promise.all([dep.entryPoint, dep.singletonFactory, dep.implementation, dep.factory, acct].map((a) => this.code(a, tag)));
    let accountImplementation: Address | null = null;
    let own: Awaited<ReturnType<Reader['owners']>> = null;
    if (accountCode) {
      const slot = await this.hex('eth_getStorageAt', [acct, ERC1967_IMPLEMENTATION_SLOT, tag]);
      accountImplementation = BigInt(slot) === 0n ? null : getAddress('0x' + slot.slice(-40));
      own = await this.owners(acct, tag);
    }
    const tokenBalances = async (owner: Address) => {
      const out: Record<Address, bigint | null> = {};
      for (const t of tokenAssets(dep)) out[t.id] = await this.uintCall({ kind: 'tokenBalance', token: t.id, owner }, tag);
      return out;
    };
    const balances = { native: BigInt(await this.hex('eth_getBalance', [acct, tag])), tokens: await tokenBalances(acct) };
    let recipient: AccountSnapshot['recipient'] = null;
    if (opts.recipient) {
      const r = getAddress(opts.recipient);
      recipient = { address: r, code: await this.code(r, tag), native: BigInt(await this.hex('eth_getBalance', [r, tag])), tokens: await tokenBalances(r) };
    }
    let gasWallet: AccountSnapshot['gasWallet'] = null;
    if (opts.gasWallet) {
      const g = getAddress(opts.gasWallet);
      gasWallet = { address: g, balance: BigInt(await this.hex('eth_getBalance', [g, tag])), nonce: BigInt(await this.hex('eth_getTransactionCount', [g, tag])) };
    }
    const prio = BigInt(await this.hex('eth_maxPriorityFeePerGas'));
    const deposit = (await this.uintCall({ kind: 'epDeposit', account: acct }, tag)) ?? 0n;
    const nonce = (await this.uintCall({ kind: 'epNonce', account: acct }, tag)) ?? 0n;
    const p256Probe = await this.readCall({ kind: 'p256Probe' }, tag);
    const end = (await this.rpc('eth_getBlockByNumber', [tag, false])) as Record<string, string> | null;
    if (this.up.id !== upId) throw new UpstreamError('inconsistent', 'the RPC endpoint changed during the snapshot; retry');
    if (!end || end.hash !== blk.hash) throw new UpstreamError('inconsistent', `block ${block} changed hash during the snapshot (reorg or inconsistent RPC backends); retry`);
    return {
      chainId,
      block,
      blockHash: blk.hash as Hex,
      timestamp: BigInt(blk.timestamp ?? '0x0'),
      baseFee: BigInt(blk.baseFeePerGas ?? '0x0'),
      priorityFee: prio,
      infraCode: { entryPoint: ep!, singletonFactory: sf!, implementation: impl!, factory: fac! },
      account: acct,
      accountCode: accountCode!,
      accountImplementation,
      owners: own?.owners ?? null,
      nextOwnerIndex: own?.next ?? null,
      removedOwnersCount: own?.removed ?? null,
      balances,
      deposit,
      nonce,
      p256Probe,
      recipient,
      gasWallet,
    };
  }

  async tx(hash: Hex): Promise<Record<string, unknown> | null> {
    return (await this.rpc('eth_getTransactionByHash', [hash])) as Record<string, unknown> | null;
  }

  async receipt(hash: Hex): Promise<Record<string, unknown> | null> {
    return (await this.rpc('eth_getTransactionReceipt', [hash])) as Record<string, unknown> | null;
  }

  async balanceAt(addr: Address, block: bigint): Promise<bigint> {
    return BigInt(await this.hex('eth_getBalance', [addr, toHex(block)]));
  }

  async txCount(addr: Address, tag: Hex): Promise<bigint> {
    return BigInt(await this.hex('eth_getTransactionCount', [getAddress(addr), tag]));
  }

  /** UserOperationEvent logs for one userOpHash in [from, to] (≤ MAX_LOG_RANGE blocks). */
  async userOpEvents(userOpHash: Hex, from: bigint, to: bigint): Promise<Array<{ blockNumber: bigint; blockHash: Hex; transactionHash: Hex; topics: Hex[]; data: Hex }>> {
    const r = await this.rpc('eth_getLogs', [{ address: getAddress(this.dep.entryPoint), topics: [USER_OP_EVENT_TOPIC, userOpHash.toLowerCase()], fromBlock: toHex(from), toBlock: toHex(to) }]);
    if (!Array.isArray(r)) throw new UpstreamError('bad-response', 'eth_getLogs: result is not an array');
    return r.map((l: Record<string, unknown>) => {
      if (typeof l.blockNumber !== 'string' || typeof l.transactionHash !== 'string' || !Array.isArray(l.topics) || typeof l.data !== 'string' || typeof l.blockHash !== 'string') throw new UpstreamError('bad-response', 'eth_getLogs: malformed log');
      if (typeof l.address !== 'string' || getAddress(l.address) !== getAddress(this.dep.entryPoint)) throw new UpstreamError('bad-response', 'eth_getLogs: log from another address');
      return { blockNumber: BigInt(l.blockNumber), blockHash: l.blockHash.toLowerCase() as Hex, transactionHash: l.transactionHash.toLowerCase() as Hex, topics: l.topics as Hex[], data: l.data as Hex };
    });
  }
}
