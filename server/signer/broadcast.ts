// The ONLY place in this repository that submits a transaction to a real network (tech spec §5.4).
// Imported solely by the Terminal signer after the user's typed confirmation; the sidecar bundle
// never contains it (test: sidecar bundle scan). It refuses the public default RPC: broadcasts go
// to the user's own endpoint (file-configured) or a loopback testchain.
import { keccak256, type Hex } from 'viem';
import { broadcastReason } from '../broadcastReason';
import { UpstreamError, type Upstream } from '../upstream';

export { broadcastReason } from '../broadcastReason';

export async function broadcastRaw(up: Upstream, raw: Hex): Promise<Hex> {
  if (!(up.info.source === 'file' || up.info.source === 'testchain')) throw new UpstreamError('not-allowed', 'broadcast requires the user-configured RPC (CBPR_RPC_URL_FILE) or a loopback testchain');
  const local = keccak256(raw);
  const text = await up.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }));
  let b: { result?: unknown; error?: { code?: unknown; message?: unknown } };
  try {
    b = JSON.parse(text);
  } catch {
    throw new UpstreamError('bad-response', 'broadcast response is not JSON');
  }
  if (b.error) throw new UpstreamError('rpc-error', `broadcast rejected: ${broadcastReason(b.error)}`);
  if (typeof b.result !== 'string' || b.result.toLowerCase() !== local.toLowerCase()) throw new UpstreamError('bad-response', 'RPC returned a hash that is not keccak256 of the signed transaction');
  return local;
}
