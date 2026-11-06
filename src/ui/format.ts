// Display rules for money and addresses (design guidelines §8). Amounts are exact — base units through
// formatUnits, never floats, never rounded. Addresses are full checksummed text in 4-character groups
// wherever a value is being confirmed; elsewhere first 6 + last 4.
import { getAddress } from 'viem';
import { formatUnits } from '../transfer/intent';

/** "0x" then 4-character groups of the checksummed address (10 groups). */
export function addressGroups(a: string): string[] {
  const c = getAddress(a.toLowerCase());
  return c.slice(2).match(/.{1,4}/g)!;
}

/** Text a screen reader speaks group by group: "0x A1b2, C3d4, …". */
export function addressLabel(a: string): string {
  return `0x ${addressGroups(a).join(', ')}`;
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** Exact decimal text of base units; a trailing ".0" is kept off, every significant digit stays. */
export function exact(units: bigint | string, decimals: number): string {
  return formatUnits(typeof units === 'string' ? BigInt(units) : units, decimals);
}

/** Integer part grouped with thin spaces for reading; the fraction is untouched (still exact). */
export function readable(units: bigint | string, decimals: number): string {
  const s = exact(units, decimals);
  const [i, f] = s.split('.');
  const grouped = i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f ? `${grouped}.${f}` : grouped;
}

export function mmss(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const blockText = (b: bigint | string | number) => Number(b).toLocaleString('en-US');

/** Every decimal place of the asset (250.000000 USDT0): the confirmation form of an amount. */
export function fixed(units: bigint | string, decimals: number): string {
  const u = typeof units === 'string' ? BigInt(units) : units;
  if (decimals === 0) return u.toString();
  const base = 10n ** BigInt(decimals);
  return `${u / base}.${(u % base).toString().padStart(decimals, '0')}`;
}
