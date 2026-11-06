// The state each stage of opening an existing gas wallet shows (PM-01, 2026-11-02 PM revision). Pure, so the
// rule "the current stage is not busy until a request really started" is unit-tested apart from the panel.

/**
 * done / next — before and after the current stage. The current stage says what is really happening:
 * input — nothing started; the user's turn (fill in or choose below);
 * working — a request to the runner's signer is running that does not wait on 1Password;
 * waiting — a request is running that waits for the user to approve in the 1Password desktop app;
 * queued — a request was asked for but is not sent yet: the signer still has to answer an earlier one (the lock of a
 *   way left, an earlier unlock);
 * failed — the last request failed; the reason is shown below.
 */
export type StageState = 'done' | 'next' | 'input' | 'queued' | 'working' | 'waiting' | 'failed';

export interface StageActivity {
  /** A signer request that waits on 1Password (reading the item, opening the keystore) is running. */
  waiting: boolean;
  /** Any other signer request (finding the manifest keystore) is running. */
  working: boolean;
  /** The last request failed and nothing has started since. */
  failed: boolean;
  /** A request waits, unsent, for the signer to answer an earlier one. */
  queued?: boolean;
}

export function stageState(index: number, at: number, a: StageActivity): StageState {
  if (index < at) return 'done';
  if (index > at) return 'next';
  if (a.queued) return 'queued';
  if (a.waiting) return 'waiting';
  if (a.working) return 'working';
  return a.failed ? 'failed' : 'input';
}

export const STAGE_MARK: Record<StageState, string> = { done: '✓', input: '●', queued: '⋯', working: '◌', waiting: '◐', next: '○', failed: '✕' };
