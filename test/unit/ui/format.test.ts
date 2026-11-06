// Money and address display: exact base-unit text (no floats), every decimal in the confirmation form,
// full checksummed addresses in 4-character groups.
import { describe, expect, it } from 'vitest';
import { addressGroups, addressLabel, exact, fixed, mmss, readable, shortAddress } from '../../../src/ui/format';

const A = '0x5fbdb2315678afecb367f032d93f642f64180aa3';

describe('format', () => {
  it('addressGroups: checksummed, 10 groups of 4; label read group by group', () => {
    expect(addressGroups(A)).toEqual(['5FbD', 'B231', '5678', 'afec', 'b367', 'f032', 'd93F', '642f', '6418', '0aa3']);
    expect(addressLabel(A)).toBe('0x 5FbD, B231, 5678, afec, b367, f032, d93F, 642f, 6418, 0aa3');
    expect(() => addressGroups('0x1234')).toThrow();
  });

  it('exact keeps every significant digit of extreme values (no float rounding)', () => {
    expect(exact('1', 18)).toBe('0.000000000000000001');
    expect(exact(2n ** 256n - 1n, 18)).toBe('115792089237316195423570985008687907853269984665640564039457.584007913129639935');
    expect(exact('0', 6)).toBe('0');
  });

  it('fixed shows every decimal place; readable groups the integer part only', () => {
    expect(fixed('250000000', 6)).toBe('250.000000');
    expect(fixed('5', 0)).toBe('5');
    expect(readable('1234567000001', 6)).toBe('1,234,567.000001');
  });

  it('shortAddress / mmss edges', () => {
    expect(shortAddress(A)).toBe('0x5fbd…0aa3');
    expect(shortAddress('0x12')).toBe('0x12');
    expect([mmss(0), mmss(-5), mmss(61_001), mmss(600_000)]).toEqual(['0:00', '0:00', '1:02', '10:00']);
  });
});
