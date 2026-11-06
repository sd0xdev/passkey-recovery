// Process configuration from non-secret environment values (tech spec §4.4). The RPC URL itself is
// only ever read from the file CBPR_RPC_URL_FILE points at; there is no env var or flag carrying it.
// Every upstream is guarded (server/net/guard.ts): hosts are resolved lazily on first use, checked,
// and pinned. A URL typed into the UI is handled by server/rpc/registry.ts, never by this file.
import { createUpstream, readUrlFile, UpstreamError, type Upstream } from './upstream';

export const PUBLIC_RPC = 'https://rpc.plasma.to';

export function upstreamFromEnv(env: NodeJS.ProcessEnv = process.env, denyLoopbackPorts: readonly number[] = []): Upstream {
  const testchain = env.CBPR_TESTCHAIN_RPC;
  if (testchain) {
    const u = new URL(testchain);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.pathname !== '/' || u.search) throw new UpstreamError('config', 'CBPR_TESTCHAIN_RPC must be http://127.0.0.1:<port>/');
    return createUpstream({ url: testchain, source: 'testchain', resolve: { allowLocal: true, denyLoopbackPorts } });
  }
  const file = env.CBPR_RPC_URL_FILE;
  if (file) return createUpstream({ url: readUrlFile(file), source: 'file', resolve: { allowLocal: false } });
  return createUpstream({ url: PUBLIC_RPC, source: 'default', resolve: { allowLocal: false } });
}
