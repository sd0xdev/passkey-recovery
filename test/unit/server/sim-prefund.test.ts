// The signed simulation checks the account's native change against what the EntryPoint could take as
// prefund. That allowance is computed from the signed op and the deposit before execution; deriving it from
// the observed debit would let any extra native outflow (a recipient callback calling execute() through an
// address owner, say) pass as "prefund".
import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { SUPPORTED } from '../../../src/config/registry';
import type { TransferIntent } from '../../../src/transfer/intent';
import type { UserOperationV06 } from '../../../src/userop/hash';
import { checkEffects, depositProblems, prefundOf, walletPrefund, type Deltas } from '../../../server/sim';

const dep = SUPPORTED[0]!;
const SOURCE = getAddress('0x3f1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c');
const RCPT = getAddress('0x9a8b7c6d5e4f30211203f4e5d6c7b8a990817263');
const op = { sender: SOURCE, nonce: 7n, initCode: '0x', callData: '0x', callGasLimit: 100_000n, verificationGasLimit: 400_000n, preVerificationGas: 60_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000n, paymasterAndData: '0x', signature: '0x' } as UserOperationV06;
const intent = { chainId: dep.chainId, deploymentId: dep.id, source: SOURCE, recipient: RCPT, asset: 'native', amount: 10n ** 16n } as TransferIntent;
const PREFUND = prefundOf(op); // 560000 gas × 2 gwei
const COST = 300_000_000_000_000n;

describe('signed simulation: native allowance comes from the op, not from the observed debit', () => {
  it('empty deposit → the wallet owes the whole prefund; a deposit covering it → nothing', () => {
    expect(walletPrefund(op, 0n)).toBe(PREFUND);
    expect(walletPrefund(op, PREFUND - 5n)).toBe(5n);
    expect(walletPrefund(op, PREFUND + 1n)).toBe(0n);
  });

  it('exact transfer: account pays amount + prefund, deposit ends at prefund − gas → no problems', () => {
    const paid = walletPrefund(op, 0n);
    const d: Deltas = { recipient: intent.amount, accountNative: -intent.amount - paid, accountAsset: -intent.amount - paid, otherTokens: [] };
    expect([...depositProblems(0n, paid - COST, paid, COST), ...checkEffects(intent, d, [], paid)]).toEqual([]);
  });

  it('an extra 1250000 wei leaves the account on top of amount + prefund → refused', () => {
    const paid = walletPrefund(op, 0n);
    const d: Deltas = { recipient: intent.amount, accountNative: -intent.amount - paid - 1_250_000n, accountAsset: 0n, otherTokens: [] };
    expect(checkEffects(intent, d, [], paid).some((p) => /account native delta/.test(p))).toBe(true);
  });

  it('the deposit moved by anything but prefund in and gas out → refused', () => {
    expect(depositProblems(0n, 649_900n, 650_000n, 100n)).toEqual([]);
    expect(depositProblems(0n, 649_900n + 1_250_000n, 650_000n, 100n)).toHaveLength(1);
  });
});
