// scripts/design/budget-lib.mjs: the PERF-1 byte budgets pass at the limit and fail one byte past it.
import { describe, expect, it } from 'vitest';
import { BASE, BASE_FONTS, LIMITS, checkBudget, fontName } from '../../../scripts/design/budget-lib.mjs';

const fonts = ['atkinson-hyperlegible-next-latin-ext-700-normal-CBw-mJf_.woff2', 'atkinson-hyperlegible-mono-latin-400-normal-Cmjm2dBj.woff'];

describe('checkBudget', () => {
  it('JS growth and visuals exactly at the limits, pre-Atlas fonts only → ok', () => {
    const r = checkBudget({ entryJsGzip: BASE.entryJsGzip + LIMITS.addedJsGzip, visualBytes: LIMITS.visualBytes, fonts });
    expect(r.ok).toBe(true);
    expect(r.failures).toEqual([]);
  });
  it('one byte over either limit → fails, naming it', () => {
    const r = checkBudget({ entryJsGzip: BASE.entryJsGzip + LIMITS.addedJsGzip + 1, visualBytes: LIMITS.visualBytes + 1, fonts });
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(2);
  });
  it('a font outside the pre-Atlas set → fails and lists it', () => {
    const r = checkBudget({ entryJsGzip: BASE.entryJsGzip, visualBytes: 0, fonts: [...fonts, 'inter-latin-400-normal-AbCdEf12.woff2'] });
    expect(r.ok).toBe(false);
    expect(r.addedFonts).toEqual(['inter-latin-400-normal.woff2']);
  });
});

describe('fontName', () => {
  it('drops the 8-char hash, including one with - or _ in it; every base font is woff2 + woff', () => {
    expect(fontName(fonts[0]!)).toBe('atkinson-hyperlegible-next-latin-ext-700-normal.woff2');
    expect(BASE_FONTS).toHaveLength(20);
  });
});
