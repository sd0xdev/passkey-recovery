// Bilingual copy (design guidelines §10, tech spec §3.8): both languages carry every key, and each
// translation keeps exactly the placeholders of the English source (a dropped {host} would hide data).
import { describe, expect, it } from 'vitest';
import { format, MESSAGES } from '../../../src/ui/i18n';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n messages', () => {
  it('繁中 has exactly the English keys, none empty', () => {
    expect(Object.keys(MESSAGES['zh-Hant-TW']).sort()).toEqual(Object.keys(MESSAGES.en).sort());
    expect(Object.entries(MESSAGES['zh-Hant-TW']).filter(([, v]) => !v.trim())).toEqual([]);
  });

  it('every translation keeps the same placeholders as English', () => {
    const drift = Object.keys(MESSAGES.en).filter((k) => placeholders(MESSAGES.en[k as keyof typeof MESSAGES.en]).join() !== placeholders(MESSAGES['zh-Hant-TW'][k as keyof typeof MESSAGES.en]).join());
    expect(drift).toEqual([]);
  });

  it('format fills known placeholders and leaves unknown ones visible', () => {
    expect(format('Now using {host}', { host: 'https://rpc.example.org/…' })).toBe('Now using https://rpc.example.org/…');
    expect(format('rate limited {n} times', {})).toBe('rate limited {n} times');
  });
});
