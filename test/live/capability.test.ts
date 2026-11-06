// Live, manual-only (`npm run test:live`): the sidecar's own connection path against the public RPC.
// upstreamFromEnv (no CBPR_RPC_URL_FILE → https://rpc.plasma.to) → RpcRegistry with the pinned genesis →
// the capability probe with a real anvil fork through the read-only proxy, then an allowlisted readback
// of the supported-version infrastructure. Reads only: no transaction is ever sent. Output carries no URL.
import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { CHAINS } from '../../src/config/chains';
import { SUPPORTED } from '../../src/config/registry';
import { upstreamFromEnv } from '../../server/config';
import { Reader } from '../../server/reader';
import { anvilForkCheck, RpcRegistry } from '../../server/rpc/registry';

const ANVIL = process.env.CBPR_ANVIL ?? 'anvil';

describe('live public RPC through the sidecar connection path', () => {
  it('capability probe + infrastructure readback on Plasma 9745', async () => {
    const env = { ...process.env };
    delete env.CBPR_RPC_URL_FILE;
    delete env.CBPR_TESTCHAIN_RPC;
    const base = upstreamFromEnv(env, [4173]);
    expect(base.info.source).toBe('default');
    const chain = CHAINS[9745]!;
    const reg = new RpcRegistry(base, { expectedGenesis: chain.genesisHash, forkCheck: anvilForkCheck(ANVIL), denyLoopbackPorts: () => [4173] });
    const report = (await reg.probeActive()).capabilities!;
    expect(report).not.toBeNull();
    const reader = new Reader(reg, { expectedGenesis: chain.genesisHash });
    const id = await reader.verifyChain();
    const s = SUPPORTED[0]!;
    const head = (await reader.rpc('eth_getBlockByNumber', ['latest', false])) as { number: Hex; hash: Hex };
    const code = async (a: Hex) => {
      const c = (await reader.rpc('eth_getCode', [a, head.number])) as Hex;
      return c === '0x' ? null : keccak256(c);
    };
    const infra = {
      entryPoint: await code(s.entryPoint),
      singletonFactory: await code(s.singletonFactory),
      implementation: await code(s.implementation),
      factory: await code(s.factory),
    };
    const p256 = await reader.readCall({ kind: 'p256Probe' }, head.number);
    const out = {
      at: new Date().toISOString(),
      source: base.info.source,
      masked: report.masked,
      provider: report.provider,
      clientVersion: report.clientVersion,
      chainId: id.chainId,
      genesis: id.genesisHash,
      snapshot: { block: BigInt(head.number).toString(), hash: head.hash },
      capabilities: Object.fromEntries((['chain', 'read', 'consistency', 'estimate', 'stateOverride', 'fork', 'archive', 'broadcast'] as const).map((k) => [k, report[k]])),
      rateLimited: report.rateLimited,
      simulationReady: report.simulationReady,
      infra,
      infraMatchesRegistry: {
        entryPoint: infra.entryPoint === s.codeHash.entryPoint,
        singletonFactory: infra.singletonFactory === s.codeHash.singletonFactory,
        implementation: infra.implementation === null ? 'absent' : infra.implementation === s.codeHash.implementation,
        factory: infra.factory === null ? 'absent' : infra.factory === s.codeHash.factory,
      },
      p256PrecompileAnswer: p256,
    };
    console.info('LIVE_PROBE ' + JSON.stringify(out));
    expect(id.chainId).toBe(9745);
    expect(id.genesisHash).toBe(chain.genesisHash);
    expect(report.chain.status).toBe('ok');
    expect(report.read.status).toBe('ok');
    expect(report.broadcast.status).toBe('not-probed');
    expect(out.infraMatchesRegistry.entryPoint).toBe(true);
    expect(out.infraMatchesRegistry.singletonFactory).toBe(true);
  }, 180_000);
});
