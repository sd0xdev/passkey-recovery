// Per-user transfer intent (M3): user-chosen source / recipient / asset / amount, exact precision,
// strict calldata both ways. All addresses SYNTHETIC.
import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  canonicalIntent, decodeTransferCall, encodeTransferCall, ERC20_TRANSFER_ABI, formatUnits, intentHash, IntentError,
  parseAddress, parseIntent, parseUnitsStrict, sameIntent, UINT256_MAX, WALLET_EXEC_ABI, type TransferIntent,
} from '../../../src/transfer/intent';
import { DEP, RCPT, SRC_A, SRC_B, USDT0 } from '../../fixtures/accounts';

const base = { source: SRC_A, recipient: RCPT };

describe('parseUnitsStrict / formatUnits', () => {
  it.each([
    ['1.5', 6, 1_500_000n],
    ['0.000001', 6, 1n],
    ['1', 18, 10n ** 18n],
    ['0.000000000000000001', 18, 1n],
    ['123456789.123456', 6, 123_456_789_123_456n],
  ])('%s with %i decimals → %s', (s, d, v) => expect(parseUnitsStrict(s, d)).toBe(v));
  it.each(['0', '0.0', '-1', '1e3', '1,000', ' 1', '01', '1.', '.5', '1.0000001'])('rejects %j for 6 decimals', (s) => expect(() => parseUnitsStrict(s, 6)).toThrow(IntentError));
  it('accepts the uint256 maximum, rejects one above', () => {
    expect(parseUnitsStrict(UINT256_MAX.toString(), 0)).toBe(UINT256_MAX);
    expect(() => parseUnitsStrict((UINT256_MAX + 1n).toString(), 0)).toThrow(/uint256/);
  });
  it('formats every digit with no rounding, round-trips, and renders negatives', () => {
    expect(formatUnits(1_689_000_001n, 6)).toBe('1689.000001');
    expect(formatUnits(12_787_000_000_000_000_000n, 18)).toBe('12.787');
    expect(parseUnitsStrict(formatUnits(98_765_432_123n, 6), 6)).toBe(98_765_432_123n);
    expect(formatUnits(-5n, 18)).toBe('-0.000000000000000005');
  });
});

describe('parseAddress', () => {
  it('accepts lowercase and valid EIP-55, returns checksummed', () => {
    expect(parseAddress(RCPT.toLowerCase(), 'r')).toBe(RCPT);
    expect(parseAddress(` ${RCPT} `, 'r')).toBe(RCPT);
  });
  it('rejects a broken mixed-case checksum and malformed input', () => {
    const good = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'; // EIP-55 test vector
    expect(parseAddress(good, 'r')).toBe(good);
    expect(() => parseAddress(good.replace('aA', 'Aa'), 'r')).toThrow(/EIP-55/);
    expect(() => parseAddress(good.slice(0, 41), 'r')).toThrow(IntentError);
    expect(() => parseAddress(42, 'r')).toThrow(IntentError);
  });
});

describe('parseIntent', () => {
  it('builds an intent only from user input: no default recipient, asset or amount', () => {
    expect(() => parseIntent(DEP, { ...base, asset: undefined, amount: '1' })).toThrow(/asset/);
    expect(() => parseIntent(DEP, { source: SRC_A, recipient: undefined, asset: 'native', amount: '1' })).toThrow(/recipient/);
    expect(() => parseIntent(DEP, { ...base, asset: 'native', amount: undefined })).toThrow(/amount/);
    expect(parseIntent(DEP, { ...base, asset: USDT0.toLowerCase(), amount: '2.5' })).toEqual({ chainId: 9745, deploymentId: DEP.id, ...base, asset: USDT0, amount: 2_500_000n });
  });
  it.each([
    ['zero address', '0x0000000000000000000000000000000000000000'],
    ['the source itself', SRC_A],
    ['the EntryPoint', DEP.entryPoint],
    ['the token contract', USDT0],
    ['the factory', DEP.factory],
  ])('refuses recipient = %s', (_n, r) => expect(() => parseIntent(DEP, { source: SRC_A, recipient: r, asset: 'native', amount: '1' })).toThrow(/recipient cannot be/));
  it('refuses an asset outside the registry', () => expect(() => parseIntent(DEP, { ...base, asset: SRC_B, amount: '1' })).toThrow(/registry/));
});

describe('strict transfer calldata', () => {
  const native: TransferIntent = parseIntent(DEP, { ...base, asset: 'native', amount: '0.25' });
  const token: TransferIntent = parseIntent(DEP, { ...base, asset: USDT0, amount: '7' });
  it.each([['native', native], ['token', token]] as const)('%s: encode → decode returns the same intent', (_n, i) => {
    expect(decodeTransferCall(DEP, i.source, encodeTransferCall(i))).toEqual(i);
  });
  it.each([
    ['trailing bytes', (encodeTransferCall(token) + '00') as Hex],
    ['approve instead of transfer', encodeFunctionData({ abi: WALLET_EXEC_ABI, functionName: 'execute', args: [USDT0, 0n, encodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), functionName: 'approve', args: [RCPT, 1n] })] })],
    ['token call carrying native value', encodeFunctionData({ abi: WALLET_EXEC_ABI, functionName: 'execute', args: [USDT0, 1n, encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: 'transfer', args: [RCPT, 1n] })] })],
    ['native call with data', encodeFunctionData({ abi: WALLET_EXEC_ABI, functionName: 'execute', args: [RCPT, 1n, '0x00'] })],
    ['executeBatch selector', '0x34fcd5be00' as Hex],
    ['zero amount', encodeFunctionData({ abi: WALLET_EXEC_ABI, functionName: 'execute', args: [RCPT, 0n, '0x'] })],
  ])('rejects %s', (_n, data) => expect(() => decodeTransferCall(DEP, SRC_A, data)).toThrow(IntentError));
});

describe('intent hash', () => {
  it('binds every field: changing any one changes the hash', () => {
    const i = parseIntent(DEP, { ...base, asset: 'native', amount: '1' });
    const variants: TransferIntent[] = [{ ...i, amount: i.amount + 1n }, { ...i, recipient: SRC_B }, { ...i, source: SRC_B }, { ...i, asset: USDT0 }, { ...i, chainId: 1 }];
    for (const v of variants) expect(intentHash(v)).not.toBe(intentHash(i));
    expect(sameIntent(i, { ...i })).toBe(true);
    expect(canonicalIntent(i)).toContain('"amount":"1000000000000000000"');
  });
});
