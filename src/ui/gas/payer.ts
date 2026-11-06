// One gas payer per page (GAS-01..05): the browser wallet the user picked (EIP-6963, OKX first), the File
// key in this page, or the runner's native signer (1Password item or native File). Deploy and Move ask
// this module to send the one transaction the runner issued; every path reports the same three outcomes
// as src/wallet/eip1193.ts: rejected (nothing sent), a hash, or no-hash (may be on chain — track it).
import { getAddress, type Address, type Hex } from 'viem';
import { sendExact, type Eip1193, type PreparedTx, type SendOutcome } from '../../wallet/eip1193';
import { signWithFileWallet } from '../../wallet/fileWallet';
import { isSignRefusal, type SignRefusal } from '../../config/signerApi';
import { api, ApiError, signerApi } from '../api';
import type { MsgKey } from '../i18n';

export type PayerMode = 'wallet' | 'browser-file' | 'native-op' | 'native-keystore' | 'native-file';
export type Via = 'browser-wallet' | 'browser-file' | 'native-signer';

export interface GasPayer {
  mode: PayerMode;
  via: Via;
  /** The full gas wallet address (shown in full in every mode), or null before one is chosen. */
  address: Address | null;
  /** Wallet: connected on the right chain. Others: unlocked and the derived address confirmed. */
  ready: boolean;
  /** Bumped on every change of mode, provider, account, item, field or key: old plans are void. */
  epoch: number;
  provider: Eip1193 | null;
}

export const viaOf = (m: PayerMode): Via => (m === 'wallet' ? 'browser-wallet' : m === 'browser-file' ? 'browser-file' : 'native-signer');

const big = (h: string) => BigInt(h);

/** Tells the runner the payer changed: it voids every plan built for the previous one (GAS-04). */
export async function announcePayerChange(reason: string, o: { lockNative?: boolean } = {}): Promise<void> {
  await api('/api/gas/changed', { reason }).catch(() => undefined);
  // Leaving a native mode ends its unlocked key too (the runner's signer would otherwise keep it).
  if (o.lockNative) await signerApi('/gas/lock').catch(() => undefined);
}

/** Deploy step: wallet → the wallet's own send (src/wallet/eip1193.ts); File / native → issue, sign, relay (server/deployRelay.ts). */
export async function sendDeploy(payer: GasPayer, step: { account: Address; key: string; tx: PreparedTx }, chainId: number, stillWanted: () => boolean): Promise<SendOutcome & { reason?: string; reasonCode?: SignRefusal }> {
  if (payer.via === 'browser-wallet') {
    if (!payer.provider) throw new ApiError(0, 'no browser wallet is selected');
    return sendExact(payer.provider, step.tx, chainId, stillWanted);
  }
  const issued = await api<{ issueId: string; tx: { from: Address; to: Address; data: Hex; nonce: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; chainId: Hex } }>('/api/deploy/issue', {
    account: step.account,
    key: step.key,
    gasWallet: step.tx.from,
    via: payer.via,
    gas: big(step.tx.gas).toString(),
    maxFeePerGas: big(step.tx.maxFeePerGas).toString(),
    maxPriorityFeePerGas: big(step.tx.maxPriorityFeePerGas).toString(),
  });
  if (!stillWanted()) {
    await api('/api/deploy/abort', { issueId: issued.issueId }).catch(() => undefined);
    return { outcome: 'rejected' };
  }
  let raw: Hex | undefined;
  if (payer.via === 'browser-file') {
    try {
      raw = await signWithFileWallet({ from: getAddress(issued.tx.from), chainId: Number(big(issued.tx.chainId)), to: getAddress(issued.tx.to), data: issued.tx.data, nonce: Number(big(issued.tx.nonce)), gas: big(issued.tx.gas), maxFeePerGas: big(issued.tx.maxFeePerGas), maxPriorityFeePerGas: big(issued.tx.maxPriorityFeePerGas) });
    } catch (e) {
      await api('/api/deploy/abort', { issueId: issued.issueId }).catch(() => undefined);
      return { outcome: 'rejected', reason: e instanceof Error ? e.message : 'the File key could not sign' };
    }
  }
  return relayed(() => api<{ outcome: 'hash' | 'rejected' | 'no-hash'; txHash?: Hex; reason?: string }>('/api/deploy/send', { issueId: issued.issueId, via: payer.via, ...(raw ? { raw } : {}) }));
}

/** The native signer's refusal class (src/config/signerApi.ts), when the runner sent one: the page shows its own copy. */
const refusalCode = (e: ApiError): { reasonCode?: SignRefusal } => (isSignRefusal(e.code) ? { reasonCode: e.code } : {});
/** The translated text of a refusal: the code's copy when there is one, else the runner's English reason. */
export const refusalText = (t: (k: MsgKey) => string, r: { reason?: string; reasonCode?: SignRefusal }): string => (r.reasonCode ? t(`gas.err.${r.reasonCode}` as MsgKey) : (r.reason ?? ''));

/** The runner's answer to a relay: a refusal before any bytes left (4xx) is "rejected"; a lost answer is unknown. */
async function relayed(call: () => Promise<{ outcome: 'hash' | 'rejected' | 'no-hash'; txHash?: Hex; reason?: string }>): Promise<SendOutcome & { reason?: string; reasonCode?: SignRefusal }> {
  try {
    const r = await call();
    if (r.outcome === 'hash' && r.txHash) return { outcome: 'hash', txHash: r.txHash };
    if (r.outcome === 'rejected') return { outcome: 'rejected', ...(r.reason ? { reason: r.reason } : {}) };
    return { outcome: 'no-hash', reason: r.reason ?? 'the runner could not confirm the broadcast' };
  } catch (e) {
    // A definite refusal by the runner (the bytes did not match, the issue expired, the signer refused)
    // means nothing left; any other failure means the bytes may have reached the network.
    if (e instanceof ApiError && e.kind === 'http' && e.status >= 400 && e.status < 500) return { outcome: 'rejected', reason: e.message, ...refusalCode(e) };
    return { outcome: 'no-hash', reason: e instanceof Error ? e.message : 'no answer from the runner' };
  }
}

/** The transfer's outer transaction for File / native payers. The wallet path stays in MoveStep. */
export async function relayTransfer<P>(payer: GasPayer, planId: string, tx: { from: Address; to: Address; data: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; chainId: Hex; nonce?: Hex }, stillWanted: () => boolean): Promise<{ plan: P | null; outcome: SendOutcome; reason?: string; reasonCode?: SignRefusal }> {
  if (!stillWanted()) {
    const plan = await api<P>('/api/transfer/signer-aborted', { planId }).catch(() => null);
    return { plan, outcome: { outcome: 'rejected' } };
  }
  let raw: Hex | undefined;
  if (payer.via === 'browser-file') {
    if (!tx.nonce) throw new ApiError(0, 'the runner did not issue a nonce for this payer');
    try {
      raw = await signWithFileWallet({ from: getAddress(tx.from), chainId: Number(big(tx.chainId)), to: getAddress(tx.to), data: tx.data, nonce: Number(big(tx.nonce)), gas: big(tx.gas), maxFeePerGas: big(tx.maxFeePerGas), maxPriorityFeePerGas: big(tx.maxPriorityFeePerGas) });
    } catch (e) {
      const plan = await api<P>('/api/transfer/signer-aborted', { planId }).catch(() => null);
      return { plan, outcome: { outcome: 'rejected' }, reason: e instanceof Error ? e.message : 'could not sign' };
    }
  }
  try {
    const r = await api<{ plan: P; relay: { outcome: 'hash' | 'rejected' | 'no-hash'; txHash?: Hex; reason?: string } }>('/api/transfer/relay', { planId, via: payer.via, ...(raw ? { raw } : {}) });
    const o: SendOutcome = r.relay.outcome === 'hash' && r.relay.txHash ? { outcome: 'hash', txHash: r.relay.txHash } : r.relay.outcome === 'rejected' ? { outcome: 'rejected' } : { outcome: 'no-hash', reason: r.relay.reason ?? 'unknown' };
    return { plan: r.plan, outcome: o, ...(r.relay.reason ? { reason: r.relay.reason } : {}) };
  } catch (e) {
    if (e instanceof ApiError && e.kind === 'http' && e.status >= 400 && e.status < 500) {
      // Refused before any bytes left (mismatch, signer locked or refused): the plan says what it is now.
      const plan = await api<P>('/api/transfer/signer-aborted', { planId }).catch(() => null);
      return { plan, outcome: { outcome: 'rejected' }, reason: e.message, ...refusalCode(e) };
    }
    return { plan: null, outcome: { outcome: 'no-hash', reason: e instanceof Error ? e.message : 'no answer from the runner' } };
  }
}
