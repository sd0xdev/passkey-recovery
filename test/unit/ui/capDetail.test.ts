// RPC capability details are shown in the page language (EN / 繁中): every code the probe emits has a
// message in both languages, its vars fill every placeholder, and an unknown code falls back to the English
// detail instead of a missing key.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { format, MESSAGES, type MsgKey } from '../../../src/ui/i18n';
import { capDetail } from '../../../src/ui/RpcSettings';

const emitted = ['server/rpc/probe.ts', 'server/rpc/registry.ts'].flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/code: (?:[^,]*\? )?'([a-zA-Z]+)'(?: : '([a-zA-Z]+)')?/g)].flatMap((m) => [m[1]!, ...(m[2] ? [m[2]] : [])]));

describe('capability detail codes', () => {
  it('the probe emits codes (scan control)', () => expect(new Set(emitted).size).toBeGreaterThanOrEqual(15));
  it.each([...new Set(emitted)])('%s has an EN and a 繁中 message', (code) => {
    const key = `capd.${code}` as MsgKey;
    expect(MESSAGES.en[key]).toBeTruthy();
    expect(MESSAGES['zh-Hant-TW'][key]).toBeTruthy();
  });
  it('a known code → translated with its vars; 繁中 differs from EN', () => {
    const cap = { status: 'ok' as const, detail: 'head 5, 3s old', code: 'readOk', vars: { block: '5', age: 3 } };
    expect(capDetail((k, v) => format(MESSAGES.en[k], v), cap)).toBe('Head block 5, 3s old.');
    expect(capDetail((k, v) => format(MESSAGES['zh-Hant-TW'][k], v), cap)).toBe('最新區塊 5，距今 3 秒。');
  });
  it('an unknown or missing code → the English detail as sent', () => {
    const t = (k: MsgKey, v?: Record<string, string | number>) => format(MESSAGES['zh-Hant-TW'][k], v);
    expect(capDetail(t, { status: 'error', detail: 'from a newer runner', code: 'somethingNew' })).toBe('from a newer runner');
    expect(capDetail(t, { status: 'error', detail: 'plain' })).toBe('plain');
  });
});
