// The words a step header shows (design guidelines §13.4, UX-1). Pure: derived from the latest answer per
// tracked record and the open plan, never from which step happens to be "current".
import { trackSettled } from './trackPoll';
import type { TrackResult, TransferPlan } from './types';

export type TrackWord = 'progress' | 'final' | 'attention';

/**
 * Track's word from each record's latest result: any record without a settled answer → in progress; every
 * record final → all final; settled, but at least one failed or was superseded → needs attention.
 */
export function trackWord(items: ReadonlyArray<{ result: TrackResult | undefined; nonce: string; hash?: string }>, current: string | null = null): TrackWord {
  // The transfer Move is sending now (PM-09): until its own record is in and settled, earlier records being
  // final says nothing about it.
  if (current !== null && !items.some((i) => i.hash === current)) return 'progress';
  if (items.some((i) => !i.result || !trackSettled(i.result, i.nonce))) return 'progress';
  return items.every((i) => i.result!.state === 'final') ? 'final' : 'attention';
}

export type MoveWord = 'choose' | 'progress' | 'ready' | 'sent';

/**
 * Move's word: nothing open → choose a transfer; "ready to send" only at the verified send gate (signed and
 * the signed transfer simulated successfully); sent → sent (Track follows it from there).
 */
export function moveWord(plan: Pick<TransferPlan, 'state' | 'signedSim'> | null): MoveWord {
  if (!plan || plan.state === 'discarded') return 'choose';
  if (plan.state === 'sent') return 'sent';
  return plan.state === 'signed' && plan.signedSim?.success ? 'ready' : 'progress';
}

export type CheckWord = 'needsRunner' | 'reading' | 'result' | 'start';

/**
 * Check's word while it is the current step (PM finding 3): "in progress" only while it really reads. No
 * runner answers → needs the runner; reading → reading the chain; an answer on screen → see the result; else
 * start here.
 */
export function checkWord(s: { connected: boolean; reading: boolean; hasResult: boolean }): CheckWord {
  if (!s.connected) return 'needsRunner';
  if (s.reading) return 'reading';
  return s.hasResult ? 'result' : 'start';
}

export type DeployRun = 'idle' | 'awaiting' | 'sent' | 'unknown' | 'rejected' | 'changed' | 'failed';
export type DeployWord = 'needsGas' | 'planning' | 'gasPayer' | 'inBlock' | 'attention' | 'yourTurn';

/**
 * Deploy's word while it is the current step (PM-01, 2026-11-02): a busy word only while something really runs.
 * A send handed to the gas payer and not answered → waiting for the gas payer; sent and not yet settled in a
 * block → waiting for the block; refused, changed, failed, an unknown outcome or a settled step that reverted or
 * did not match → needs attention; planning → planning; no gas payer ready → choose one; otherwise the next
 * action is the user's → your turn.
 */
export function deployWord(s: { gasReady: boolean; planning: boolean; run: DeployRun; settled: boolean; settledBad: boolean }): DeployWord {
  if (s.run === 'awaiting') return 'gasPayer';
  if (s.run === 'sent' && !s.settled) return 'inBlock';
  if (s.run === 'rejected' || s.run === 'changed' || s.run === 'failed' || s.run === 'unknown' || (s.run === 'sent' && s.settledBad)) return 'attention';
  if (s.planning) return 'planning';
  return s.gasReady ? 'yourTurn' : 'needsGas';
}
