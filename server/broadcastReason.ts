// Fixed, allowlisted wording for a node's rejection of a signed transaction. The node's own text may echo
// the submitted transaction (signature, raw bytes), so it is never forwarded: only the matched reason and
// the numeric JSON-RPC code leave this module. Shared by the sidecar relay and the Terminal signer.
export type RejectionClass = 'already-known' | 'definite' | 'ambiguous';

const REASONS: ReadonlyArray<[RegExp, string, RejectionClass]> = [
  [/already known|known transaction|already imported/i, 'transaction already known to the node — do not resend; track it', 'already-known'],
  [/nonce too low/i, 'nonce already used — something was sent with this nonce; do not resend; track it', 'ambiguous'],
  [/nonce too high/i, 'nonce too high for the gas wallet', 'definite'],
  [/insufficient funds/i, 'insufficient funds in the gas wallet for gas × max fee', 'definite'],
  [/replacement transaction underpriced|underpriced/i, 'fee too low to replace a pending transaction', 'definite'],
  [/fee cap less than block base fee|max fee per gas less than block base fee|fee too low/i, 'max fee is below the current base fee', 'definite'],
  [/intrinsic gas too low|gas limit reached|exceeds block gas limit/i, 'gas limit rejected by the node', 'definite'],
  [/invalid sender|invalid signature|invalid chain id|chain id/i, 'signature or chain id rejected by the node', 'definite'],
];

export function classifyRejection(error: { code?: unknown; message?: unknown }): { reason: string; cls: RejectionClass } {
  const text = typeof error.message === 'string' ? error.message : '';
  const hit = REASONS.find(([re]) => re.test(text));
  const code = typeof error.code === 'number' && Number.isInteger(error.code) ? ` (code ${error.code})` : '';
  // An unrecognised rejection may still have been accepted by some peer: treat it as unknown, never as "not sent".
  return { reason: (hit?.[1] ?? 'the node rejected the transaction (its message is withheld: it may echo the signed transaction)') + code, cls: hit?.[2] ?? 'ambiguous' };
}

export function broadcastReason(error: { code?: unknown; message?: unknown }): string {
  return classifyRejection(error).reason;
}
