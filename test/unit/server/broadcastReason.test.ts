import { describe, expect, it } from 'vitest';
import { broadcastReason, classifyRejection } from '../../../server/broadcastReason';

describe('classifyRejection', () => {
  it.each([
    ['already known', 'already-known'],
    ['known transaction: 0xabc', 'already-known'],
    ['transaction already imported', 'already-known'],
    ['ALREADY KNOWN', 'already-known'],
    ['nonce too low: next nonce 8, tx nonce 7', 'ambiguous'],
    ['nonce too high', 'definite'],
    ['insufficient funds for gas * price + value', 'definite'],
    ['replacement transaction underpriced', 'definite'],
    ['transaction underpriced', 'definite'],
    ['max fee per gas less than block base fee', 'definite'],
    ['fee cap less than block base fee', 'definite'],
    ['intrinsic gas too low', 'definite'],
    ['exceeds block gas limit', 'definite'],
    ['invalid sender', 'definite'],
    ['invalid chain id for signer', 'definite'],
  ] as const)('"%s" → %s', (message, cls) => {
    expect(classifyRejection({ code: -32000, message }).cls).toBe(cls);
  });
  it('an unrecognised message → ambiguous (never "not sent")', () => {
    expect(classifyRejection({ code: -32603, message: 'internal error' }).cls).toBe('ambiguous');
  });
  it('a missing or non-string message → ambiguous', () => {
    expect([classifyRejection({}).cls, classifyRejection({ message: 42 }).cls, classifyRejection({ message: null }).cls]).toEqual(['ambiguous', 'ambiguous', 'ambiguous']);
  });
  it('the reason is fixed wording and never echoes the node text', () => {
    const echo = '0x02f86b82260f07' + 'ab'.repeat(40);
    const { reason } = classifyRejection({ code: -32000, message: `insufficient funds: tx ${echo}` });
    expect(reason).not.toContain(echo);
    expect(reason).toMatch(/insufficient funds in the gas wallet/);
  });
  it('an unrecognised node text is withheld too', () => {
    const { reason } = classifyRejection({ code: -32000, message: 'secret-looking-echo-0xdeadbeef' });
    expect(reason).not.toContain('deadbeef');
  });
  it('appends an integer JSON-RPC code', () => {
    expect(classifyRejection({ code: -32000, message: 'nonce too high' }).reason).toMatch(/\(code -32000\)$/);
  });
  it.each([['a string code', '-32000'], ['a fractional code', 1.5], ['no code', undefined]])('omits %s', (_n, code) => {
    expect(classifyRejection({ code, message: 'nonce too high' }).reason).not.toMatch(/code/);
  });
  it('"nonce too low" is matched before any other rule', () => {
    expect(classifyRejection({ message: 'nonce too low; insufficient funds' }).cls).toBe('ambiguous');
  });
  it('broadcastReason returns the classified reason', () => {
    const e = { code: -32000, message: 'already known' };
    expect(broadcastReason(e)).toBe(classifyRejection(e).reason);
  });
});
