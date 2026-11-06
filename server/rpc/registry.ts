// The active RPC endpoint (open-source spec §3.3, M1). The base endpoint comes from the process
// environment (public default, CBPR_RPC_URL_FILE, or the loopback testchain). A custom endpoint typed
// into the UI lives only in this object's memory: never in argv, env, a file, a log, a response or the
// page URL; the UI sees scheme://host/… only. Reloading the page drops it, and so does "Clear".
// Every switch increments `epoch`: listeners (the plan service) discard anything prepared against the
// previous endpoint. The registry itself implements Upstream, so the reader and the fork proxy always
// read through whichever endpoint is active, and always through server/net/guard.ts.
import { keccak256, toHex, type Hex } from 'viem';
import { SUPPORTED } from '../../src/config/registry';
const ENTRY_POINT_V06 = SUPPORTED[0]!.entryPoint;
import { ForkError, ForkManager } from '../fork';
import { startForkProxy } from '../forkProxy';
import { HttpError } from '../http';
import { NetGuardError } from '../net/guard';
import { Reader } from '../reader';
import { openUpstream, UpstreamError, type Upstream, type UpstreamInfo, type UpstreamStats } from '../upstream';
import { probeUpstream, type CapabilityReport, type ForkCheck } from './probe';

/** Typed by the user to accept a loopback / private-network endpoint (their own node). */
export const LOCAL_EXCEPTION_PHRASE = 'MY OWN NODE';

export type SwitchReason = 'custom-set' | 'custom-cleared' | 'page-load' | 'endpoint-rechecked';
export type SwitchListener = (e: { epoch: number; reason: SwitchReason }) => void;

export interface RegistryOptions {
  expectedGenesis: Hex | null;
  forkCheck?: ForkCheck;
  /** Loopback ports that are never an RPC (this sidecar and its fork proxy). */
  denyLoopbackPorts?: () => readonly number[];
  /** Tests: builds an upstream for a custom URL instead of resolving it. */
  open?: typeof openUpstream;
}

export function anvilForkCheck(anvilBin: string): ForkCheck {
  return async (up, block, expect) => {
    const proxy = await startForkProxy(up);
    try {
      const fm = new ForkManager({ anvilBin, upstreamProxyUrl: proxy.url, hardfork: 'prague' });
      return await fm.run({ block, blockHash: expect.blockHash }, async (f) => {
        const blk = await f.rpc<{ hash?: string } | null>('eth_getBlockByNumber', [toHex(block), false]);
        const code = await f.code(ENTRY_POINT_V06);
        if (!blk || blk.hash?.toLowerCase() !== expect.blockHash.toLowerCase()) return { status: 'unsupported' as const, detail: `fork at block ${block} reports a different block hash`, code: 'forkHash', vars: { block: String(block) } };
        if (keccak256(code) !== expect.entryPointCodeHash) return { status: 'unsupported' as const, detail: 'fork state differs from direct reads (EntryPoint code)', code: 'forkState' };
        return { status: 'ok' as const, detail: `anvil forked block ${block} through the read-only proxy; block hash and EntryPoint code match`, code: 'forkOk', vars: { block: String(block) } };
      });
    } catch (e) {
      if (e instanceof ForkError && /could not be started/.test(e.message)) return { status: 'error', detail: 'anvil is not installed or not executable on this machine', code: 'anvilMissing' };
      if (e instanceof ForkError) return { status: 'unsupported', detail: `anvil could not fork from this RPC (${up.redactError(e.message).slice(0, 120)})`, code: 'forkFailed', vars: { text: up.redactError(e.message).slice(0, 120) } };
      throw e;
    } finally {
      await proxy.close();
    }
  };
}

interface Custom {
  up: Upstream;
  probe: CapabilityReport;
}

export class RpcRegistry implements Upstream {
  private custom: Custom | null = null;
  private baseProbe: CapabilityReport | null = null;
  private listeners: SwitchListener[] = [];
  private _epoch = 0;
  private learnedGenesis: Hex | null;
  /** Page-session generation: every Clear / page load bumps it, so a Use that started earlier cannot land afterwards. */
  private session = 0;

  constructor(
    private readonly base: Upstream,
    private readonly opts: RegistryOptions,
  ) {
    this.learnedGenesis = opts.expectedGenesis;
  }

  private get cur(): Upstream {
    return this.custom?.up ?? this.base;
  }

  get id(): string {
    return this.cur.id;
  }
  get info(): UpstreamInfo {
    return this.cur.info;
  }
  get stats(): UpstreamStats {
    return this.cur.stats;
  }
  get epoch(): number {
    return this._epoch;
  }
  get baseInfo(): UpstreamInfo {
    return this.base.info;
  }

  call(method: string, params: unknown[]): Promise<unknown> {
    return this.cur.call(method, params);
  }
  /** The text is redacted with the secrets of the endpoint that produced it, even if a switch happens meanwhile. */
  async raw(body: string): Promise<string> {
    const u = this.cur;
    return u.redact(await u.raw(body));
  }
  redact(text: string): string {
    return this.cur.redact(text);
  }
  redactError(text: string): string {
    return this.cur.redactError(text);
  }
  repin(): Promise<void> {
    return this.cur.repin();
  }

  onSwitch(fn: SwitchListener): void {
    this.listeners.push(fn);
  }

  /** Last capability report for the active endpoint (null until probed). */
  capabilities(): CapabilityReport | null {
    return this.custom ? this.custom.probe : this.baseProbe;
  }

  state() {
    return {
      epoch: this._epoch,
      active: this.custom ? ('custom' as const) : ('base' as const),
      upstream: this.cur.info,
      base: this.base.info,
      capabilities: this.capabilities(),
      rateLimited: this.cur.stats.rateLimited,
      localExceptionPhrase: LOCAL_EXCEPTION_PHRASE,
    };
  }

  private emit(reason: SwitchReason) {
    this._epoch++;
    for (const l of this.listeners) l({ epoch: this._epoch, reason });
  }

  private async openCandidate(body: Record<string, unknown>): Promise<Upstream> {
    const url = body.url;
    if (typeof url !== 'string') throw new HttpError(400, 'url (string) required');
    const allowLocal = body.allowLocal === true;
    if (allowLocal && body.confirm !== LOCAL_EXCEPTION_PHRASE) throw new HttpError(400, `to use a node on this machine or your network, type the confirmation "${LOCAL_EXCEPTION_PHRASE}"`);
    try {
      return await (this.opts.open ?? openUpstream)(url.trim(), 'custom', { allowLocal, denyLoopbackPorts: this.opts.denyLoopbackPorts?.() ?? [] });
    } catch (e) {
      if (e instanceof NetGuardError) throw new HttpError(400, e.message);
      if (e instanceof UpstreamError) throw new HttpError(400, e.message);
      throw new HttpError(400, 'RPC URL rejected');
    }
  }

  /**
   * The genesis every endpoint must report. Mainnet pins it from CHAINS; the testchain (null) learns it once
   * from the BASE endpoint, so a custom endpoint can never redefine which chain is "expected".
   */
  private async genesis(): Promise<Hex> {
    if (this.learnedGenesis) return this.learnedGenesis;
    try {
      this.learnedGenesis = (await new Reader(this.base, { expectedGenesis: null }).verifyChain()).genesisHash;
    } catch {
      throw new HttpError(503, 'the default RPC endpoint could not be verified, so no other endpoint can be checked against it; try again');
    }
    return this.learnedGenesis;
  }

  private async probe(up: Upstream): Promise<CapabilityReport> {
    return probeUpstream(up, { expectedGenesis: await this.genesis(), ...(this.opts.forkCheck ? { forkCheck: this.opts.forkCheck } : {}) });
  }

  /** Checks a candidate without switching to it. The URL is dropped when this returns. */
  async test(body: Record<string, unknown>): Promise<CapabilityReport> {
    return this.probe(await this.openCandidate(body));
  }

  /** Checks a candidate and, if it is the right chain and readable, makes it the active endpoint. */
  async use(body: Record<string, unknown>) {
    const session = this.session;
    const up = await this.openCandidate(body);
    const probe = await this.probe(up);
    if (session !== this.session) throw new HttpError(409, 'not used: the page was reloaded or the endpoint cleared while this was being checked');
    if (probe.chain.status !== 'ok') throw new HttpError(409, `not used: ${probe.chain.detail || 'chain identity could not be verified'}`);
    if (probe.read.status !== 'ok') throw new HttpError(409, `not used: basic reads failed (${probe.read.detail})`);
    this.custom = { up, probe };
    this.emit('custom-set');
    return this.state();
  }

  clear(reason: 'custom-cleared' | 'page-load' = 'custom-cleared') {
    this.session++;
    if (this.custom) {
      this.custom = null;
      this.emit(reason);
    }
    return this.state();
  }

  /** Re-resolves the active host (explicit re-check) and probes it again. */
  async probeActive() {
    const u = this.cur;
    await u.repin();
    // Re-resolving may land on another backend: plans read from the previous one are discarded, as on a switch.
    this.emit('endpoint-rechecked');
    const report = await this.probe(u);
    if (this.custom?.up === u) this.custom.probe = report;
    else if (u === this.base) this.baseProbe = report;
    return this.state();
  }
}
