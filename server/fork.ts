// Disposable anvil forks for simulation (tech spec §4.3). Each job gets a fresh fork pinned to one
// block, reached only through the read-only proxy, bound to 127.0.0.1, killed afterwards; one job at
// a time. The fork client exposes no setCode and no storage writes, refuses to impersonate any account
// a job marks as a real user wallet, and impersonates the EntryPoint only for the labelled execution-only sim.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { getAddress, toHex, type Address, type Hex } from 'viem';

export class ForkError extends Error {
  override name = 'ForkError';
}

export interface ForkOptions {
  anvilBin: string;
  upstreamProxyUrl: string;
  hardfork: string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

export type ImpersonationPurpose = 'outer-sender' | 'execution-only' | 'synthetic';

export class Fork {
  private id = 0;
  private readonly impersonated = new Set<string>();
  /** Addresses whose balance must never be edited on the fork (the user's account, the EntryPoint, the user's gas wallet). */
  readonly protectedBalances = new Set<string>();
  /** Real user wallets: never impersonated (a fork run must prove the signature, not bypass it). */
  private readonly neverImpersonate = new Set<string>();
  private entryPoint: string | null = null;

  constructor(
    readonly url: string,
    readonly block: bigint,
    private readonly proc: ChildProcess | null,
  ) {}

  /** Declares the job's real accounts: `wallets` are never impersonated or funded; `entryPoint` only for execution-only. */
  guard(o: { wallets: Address[]; entryPoint: Address; gasWallet?: Address | null }): void {
    for (const w of o.wallets) {
      this.neverImpersonate.add(getAddress(w));
      this.protectedBalances.add(getAddress(w));
    }
    this.entryPoint = getAddress(o.entryPoint);
    this.protectedBalances.add(this.entryPoint);
    if (o.gasWallet) this.protectedBalances.add(getAddress(o.gasWallet));
  }

  async rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (/setCode|setStorageAt|anvil_setNonce|anvil_reset|anvil_dumpState|anvil_loadState/i.test(method)) throw new ForkError(`${method} is not used by this tool`);
    const res = await fetch(this.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }) });
    const b = (await res.json()) as { result?: T; error?: { message?: string; data?: unknown } };
    if (b.error) {
      const e = new ForkError(`fork ${method}: ${String(b.error.message ?? 'error').slice(0, 300)}`);
      (e as ForkError & { data?: unknown }).data = b.error.data;
      throw e;
    }
    return b.result as T;
  }

  async impersonate(addr: Address, purpose: ImpersonationPurpose): Promise<void> {
    const a = getAddress(addr);
    if (this.entryPoint === null) throw new ForkError('fork job did not declare its accounts (guard) before impersonating');
    if (this.neverImpersonate.has(a)) throw new ForkError('the user\'s wallet is never impersonated');
    if (a === this.entryPoint && purpose !== 'execution-only') throw new ForkError('the EntryPoint is impersonated only for the labelled execution-only simulation');
    await this.rpc('anvil_impersonateAccount', [a]);
    this.impersonated.add(a);
  }

  /** Funds a synthetic fork-only account. Refuses protected accounts (real wallet, EntryPoint, user gas wallet). */
  async fundSynthetic(addr: Address, wei: bigint): Promise<void> {
    const a = getAddress(addr);
    if (this.entryPoint === null) throw new ForkError('fork job did not declare its accounts (guard) before funding');
    if (this.protectedBalances.has(a)) throw new ForkError(`balance of ${a} is never edited on the fork`);
    await this.rpc('anvil_setBalance', [a, toHex(wei)]);
  }

  /** Next fork block charges no base fee, so a fee-free call can run without editing any balance. */
  async zeroFeeNextBlock(): Promise<void> {
    await this.rpc('anvil_setNextBlockBaseFeePerGas', ['0x0']);
  }

  async send(tx: { from: Address; to: Address; data: Hex; value?: bigint; gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }): Promise<Hex> {
    if (!this.impersonated.has(getAddress(tx.from))) throw new ForkError('sender not impersonated');
    const p: Record<string, string> = { from: tx.from, to: tx.to, data: tx.data, value: toHex(tx.value ?? 0n) };
    if (tx.gas !== undefined) p.gas = toHex(tx.gas);
    if (tx.maxFeePerGas !== undefined) p.maxFeePerGas = toHex(tx.maxFeePerGas);
    if (tx.maxPriorityFeePerGas !== undefined) p.maxPriorityFeePerGas = toHex(tx.maxPriorityFeePerGas);
    return this.rpc<Hex>('eth_sendTransaction', [p]);
  }

  async receipt(hash: Hex): Promise<{ status: string; gasUsed: string; effectiveGasPrice?: string; logs: Array<{ address: string; topics: Hex[]; data: Hex }>; blockNumber: string }> {
    for (let i = 0; i < 100; i++) {
      const r = await this.rpc<{ status: string; gasUsed: string; effectiveGasPrice?: string; logs: Array<{ address: string; topics: Hex[]; data: Hex }>; blockNumber: string } | null>('eth_getTransactionReceipt', [hash]);
      if (r) return r;
      await new Promise((res) => setTimeout(res, 50));
    }
    throw new ForkError('fork receipt not produced');
  }

  async estimate(tx: { from: Address; to: Address; data: Hex; value?: bigint }): Promise<bigint> {
    return BigInt(await this.rpc<Hex>('eth_estimateGas', [{ from: tx.from, to: tx.to, data: tx.data, value: toHex(tx.value ?? 0n) }]));
  }

  async call(to: Address, data: Hex, from?: Address): Promise<Hex> {
    return this.rpc<Hex>('eth_call', [{ to, data, ...(from ? { from } : {}) }, 'latest']);
  }

  async balance(a: Address): Promise<bigint> {
    return BigInt(await this.rpc<Hex>('eth_getBalance', [a, 'latest']));
  }

  async code(a: Address): Promise<Hex> {
    return this.rpc<Hex>('eth_getCode', [a, 'latest']);
  }

  async storage(a: Address, slot: Hex): Promise<Hex> {
    return this.rpc<Hex>('eth_getStorageAt', [a, slot, 'latest']);
  }

  async close(): Promise<void> {
    const p = this.proc;
    // A signal-killed child has exitCode null but signalCode set; its 'exit' already fired, so waiting would hang the queue.
    if (!p || p.pid === undefined || p.exitCode !== null || p.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => {
        if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
      }, 2000);
      // Last resort: never block the ForkManager queue on an exit event that does not arrive.
      const giveUp = setTimeout(() => resolve(), 5000);
      p.once('exit', () => {
        clearTimeout(kill);
        clearTimeout(giveUp);
        resolve();
      });
      p.kill('SIGTERM');
    });
  }
}

/** The only --fork-url anvil is ever given: this process's loopback read-only proxy (forkProxy.ts). */
export const FORK_PROXY_URL_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}\/[0-9a-f]{32}$/;

export class ForkManager {
  private queue: Promise<unknown> = Promise.resolve();
  /** Live forks, so a shutdown can end an in-flight one instead of orphaning its anvil. */
  private readonly live = new Set<Fork>();
  private closed = false;
  constructor(private readonly opts: ForkOptions) {
    // anvil's upstream connection would bypass the SSRF guard: it may only read through the proxy.
    if (!FORK_PROXY_URL_RE.test(opts.upstreamProxyUrl)) throw new ForkError('anvil may only fork through the local read-only proxy');
  }

  // `--accounts 0`: anvil's built-in dev accounts would be credited 10,000 native on the fork, silently
  // overriding the real balance of any of those well-known addresses (a gas wallet among them) and making
  // the signed simulation pass where the real send could not pay. The fork invents no balances.
  private async open(block: bigint, blockHash: Hex): Promise<Fork> {
    const port = await freePort();
    const args = ['--fork-url', this.opts.upstreamProxyUrl, '--fork-block-number', block.toString(), '--hardfork', this.opts.hardfork, '--host', '127.0.0.1', '--port', String(port), '--no-storage-caching', '--accounts', '0', '--silent'];
    const proc = spawn(this.opts.anvilBin, args, { stdio: 'ignore' });
    const url = `http://127.0.0.1:${port}`;
    const fork = new Fork(url, block, proc);
    this.live.add(fork);
    proc.once('exit', () => this.live.delete(fork));
    let exited = false;
    let spawnError: string | null = null;
    proc.once('exit', () => (exited = true));
    // A missing or non-executable binary emits 'error' (not 'exit'); unhandled it would crash the sidecar.
    proc.once('error', (e: NodeJS.ErrnoException) => {
      exited = true;
      spawnError = e.code ?? 'spawn error';
    });
    for (let i = 0; i < 120; i++) {
      if (spawnError) throw new ForkError(`anvil could not be started (${spawnError})`);
      if (exited) throw new ForkError('anvil exited during startup');
      try {
        const n = BigInt(await fork.rpc<Hex>('eth_blockNumber'));
        if (n !== block) throw new ForkError(`fork started at ${n}, expected ${block}`);
        // The same height is not the same block: a reorg after the snapshot (or while the job waited in the
        // queue) would fork a different branch than the reads the plan was built from.
        const got = ((await fork.rpc<{ hash?: string } | null>('eth_getBlockByNumber', [toHex(block), false]))?.hash ?? '').toLowerCase();
        if (got !== blockHash.toLowerCase()) throw new ForkError(`fork started at block ${block} with a different hash than the snapshot (reorg): retry`);
        return fork;
      } catch (e) {
        if (e instanceof ForkError && (e.message.startsWith('fork started') || e.message.includes('different hash'))) {
          await fork.close();
          throw e;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await fork.close();
    throw new ForkError('anvil did not become ready');
  }

  /**
   * Runs one job on a fresh fork at the snapshot's block — the block number AND its hash, so a fork never
   * runs on another branch than the reads it pairs with. Jobs are serialized; the fork is always torn down.
   */
  run<T>(at: { block: bigint; blockHash: Hex }, job: (f: Fork) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      if (this.closed) throw new ForkError('the runner is shutting down');
      const f = await this.open(at.block, at.blockHash);
      try {
        return await job(f);
      } finally {
        await f.close();
      }
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Shutdown: refuses new jobs and ends every live fork. */
  async closeAll(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.live].map((f) => f.close()));
    this.live.clear();
  }

  get liveCount(): number {
    return this.live.size;
  }
}
