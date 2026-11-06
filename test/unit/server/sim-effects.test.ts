// The simulation gate accepts a transfer only when its whole effect on the account is the requested one.
// A recipient contract's callback could pull another registry token (USDT0 through an old allowance)
// while the requested XPL transfer itself is exact: that side effect must be refused. The same words as
// an ordinary transfer (other token untouched) must pass.
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress, parseAbi, type Hex } from 'viem';
import { SUPPORTED, tokenAssets } from '../../../src/config/registry';
import { checkEffects, deltasOf, otherTokensOf, type Balances } from '../../../server/sim';
import type { TransferIntent } from '../../../src/transfer/intent';

const dep = SUPPORTED[0]!;
const USDT0 = getAddress(tokenAssets(dep)[0]!.id);
const SOURCE = getAddress('0x3f1e2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c');
const RCPT = getAddress('0x9a8b7c6d5e4f30211203f4e5d6c7b8a990817263');
const ERC20 = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const XPL = 10n ** 16n;
const native: TransferIntent = { chainId: dep.chainId, deploymentId: dep.id, source: SOURCE, recipient: RCPT, asset: 'native', amount: XPL } as TransferIntent;

const bal = (recipient: bigint, accountNative: bigint, usdt0: bigint): Balances => ({ recipient, accountNative, accountAsset: accountNative, deposit: 0n, nonce: 7n, otherTokens: [{ token: USDT0, balance: usdt0 }] });
const pull = (value: bigint) => ({ address: USDT0, topics: encodeEventTopics({ abi: ERC20, eventName: 'Transfer', args: { from: SOURCE, to: RCPT } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [value]) });

describe('checkEffects: other registry tokens must stay untouched', () => {
  it('a native transfer is checked against every registry token; a token transfer against the others', () => {
    expect(otherTokensOf(dep, native)).toEqual([USDT0]);
    expect(otherTokensOf(dep, { ...native, asset: USDT0 } as TransferIntent)).toEqual([]);
  });

  it('exact XPL transfer, USDT0 balance unchanged and no USDT0 Transfer → no problems', () => {
    const d = deltasOf(bal(0n, 5n * XPL, 3_000_000n), bal(XPL, 4n * XPL, 3_000_000n));
    expect(checkEffects(native, d, [], 0n)).toEqual([]);
  });

  it('exact XPL transfer while the recipient pulled USDT0 from the account → refused (balance and event)', () => {
    const d = deltasOf(bal(0n, 5n * XPL, 3_000_000n), bal(XPL, 4n * XPL, 1_750_000n));
    const p = checkEffects(native, d, [pull(1_250_000n)], 0n);
    expect(p.some((x) => /changed by -1250000/.test(x))).toBe(true);
    expect(p.some((x) => /Transfer of token .* out of the account/.test(x))).toBe(true);
  });

  it('a USDT0 Transfer out of the account is refused even if the balance ends up unchanged (pulled and refunded)', () => {
    const d = deltasOf(bal(0n, 5n * XPL, 3_000_000n), bal(XPL, 4n * XPL, 3_000_000n));
    expect(checkEffects(native, d, [pull(1n)], 0n)).toHaveLength(1);
  });
});
