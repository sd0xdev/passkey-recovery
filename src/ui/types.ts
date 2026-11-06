// JSON shapes the sidecar returns (bigints arrive as decimal strings). Display data only: every value
// that matters is re-derived by the sidecar and the Terminal signer, never trusted from the browser.
import type { Address, Hex } from 'viem';
import type { TrackingRecord } from './trackingStore';

export type U = string;

export interface DiagCheck {
  id: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
  ok: boolean;
  detail: string;
}

/** Mirrors `OwnerInfo` in src/wallet/derive.ts (the sidecar's JSON). passkey: 0x + 128 hex (x‖y). */
export interface OwnerInfo {
  index: number;
  kind: string;
  value: Hex;
}

export interface Diagnosis {
  account: Address;
  chainId: number;
  deploymentId: string;
  block: U;
  checks: DiagCheck[];
  passkeyOwners: OwnerInfo[];
  derivation: { source: string; nonce: string; localMatch: boolean; factoryMatch: boolean | null } | null;
  balances: { native: U; tokens: Record<string, U | null>; deposit: U; nonce: U };
  blockers: string[];
  needs: Array<'implementation' | 'factory' | 'account'>;
  supported: boolean;
  /** Only the creation evidence of a not-yet-deployed account is missing: one more input, then check again. */
  needsEvidence?: boolean;
}

export interface DeployPlanStep {
  key: 'implementation' | 'factory' | 'account';
  to: Address;
  data: Hex;
  inputHash: Hex;
  creates: Address;
  state: 'done' | 'needed';
  gasLimit: U | null;
  maxCostWei: U | null;
}

export interface DeployPlan {
  account: Address;
  block: U;
  fees: { maxFeePerGas: U; maxPriorityFeePerGas: U };
  steps: DeployPlanStep[];
  totalMaxCostWei: U;
  gasWallet: { address: Address; balance: U; nonce: U } | null;
  gasWalletSufficient: boolean | null;
  complete: boolean;
}

export type StepVerdict = { state: 'not-found' | 'mismatch' | 'pending' | 'reverted' | 'confirmed-no-code' | 'confirmed'; detail: string; block?: U; confirmations?: U };

export type PlanState = 'previewed' | 'sim-failed' | 'signed' | 'sending' | 'sent' | 'unknown' | 'discarded';

export interface TransferPlan {
  id: string;
  state: PlanState;
  createdAt: number;
  validUntil: number;
  intent: { chainId: number; deploymentId: string; source: Address; recipient: Address; asset: 'native' | Address; amount: U };
  intentHash: Hex;
  asset: { symbol: string; decimals: number; id: 'native' | Address };
  ownerIndex: number;
  gasWallet: Address;
  op: { nonce: U; callGasLimit: U; verificationGasLimit: U; preVerificationGas: U; maxFeePerGas: U };
  userOpHash: Hex;
  snapshotBlock: U;
  fees: { maxFeePerGas: U; maxPriorityFeePerGas: U };
  signable: boolean;
  notSignableReason: string | null;
  execOnly: { problems: string[] };
  prefundWei: U;
  reserveWei: U;
  feeSummary: { networkGasLimit: U; networkMaxWei: U; networkFinal: boolean; walletMaxWei: U; reserveWei: U };
  recipientInfo: { hasCode: boolean; native: U; token: U | null };
  signedSim: { success: boolean; problems: string[]; forkBlock: U; outerGasLimit: U; actualGasCost: U } | null;
  send: { requestedAt: number; txHash: Hex | null; outcome: string; via: 'browser-wallet' | 'terminal-signer' } | null;
  handoff: { expiresAt: number } | null;
  tracking: TrackingRecord | null;
  discardReason: string | null;
}

export interface SendRequest {
  plan: TransferPlan;
  /** null when the network fee cap rose above the one shown: nothing was issued; confirm the new figure. */
  tx: { from: Address; to: Address; data: Hex; value: Hex; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; chainId: Hex; nonce?: Hex } | null;
  feeRaised?: { shownMaxFeePerGas: U; maxFeePerGas: U; shownNetworkMaxWei: U; networkMaxWei: U };
}

export type TrackState = 'pending' | 'unknown' | 'mismatch' | 'reverted' | 'inner-failed' | 'confirmed' | 'final' | 'reorged';

export interface TrackResult {
  state: TrackState;
  detail: string;
  txHash: Hex | null;
  block: U | null;
  confirmations: U | null;
  finalityDepth: number;
  scan: { cursor: U; head: U; complete: boolean } | null;
  /** bundler: the outer tx's from (paid the network fee); beneficiary: who handleOps paid the wallet fee to. */
  receipt: { gasUsed: U; effectiveGasPrice: U | null; outerFeeWei: U | null; actualGasCost: U; actualGasUsed: U; amount: string; symbol: string; sender: Address; recipient: Address; bundler: Address | null; beneficiary: Address | null } | null;
  /** null when the tracker does not know the account's full address (check it in step 1). */
  nonceNow: U | null;
  /** The nonce at the finality depth below the head; null when unknown. */
  nonceFinal: U | null;
}

export interface SidecarConfig {
  mode: 'mainnet' | 'testchain';
  port: number;
}
