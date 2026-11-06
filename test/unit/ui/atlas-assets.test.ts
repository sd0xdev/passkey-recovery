// src/ui/site/atlas/ASSETS.md pins the shipped Demo stills by SHA-256: the table and the files must agree, so a
// recapture that skips the review-and-record step (or a doc edit that skips the files) fails here.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const ASSETS_DIR = resolve(ROOT, 'src/ui/site/assets');
const doc = readFileSync(resolve(ROOT, 'src/ui/site/atlas/ASSETS.md'), 'utf8');
const pinned = new Map([...doc.matchAll(/^\| `(demo-[a-z]+\.webp)` \| `([0-9a-f]{64})` \|/gm)].map((m) => [m[1]!, m[2]!]));
const sha = (f: string) => createHash('sha256').update(readFileSync(resolve(ASSETS_DIR, f))).digest('hex');

describe('ASSETS.md Demo still pins', () => {
  it('the table pins exactly the four shipped stills, each once', () => {
    const shipped = readdirSync(ASSETS_DIR).filter((f) => /^demo-.*\.webp$/.test(f)).sort();
    expect(shipped).toEqual(['demo-approve.webp', 'demo-check.webp', 'demo-deploy.webp', 'demo-track.webp']);
    expect([...pinned.keys()].sort()).toEqual(shipped);
  });
  it.each(['demo-check.webp', 'demo-deploy.webp', 'demo-approve.webp', 'demo-track.webp'])('%s matches its pinned SHA-256', (f) => {
    expect(sha(f)).toBe(pinned.get(f));
  });
  it('a hash that differs by one digit does not match (the comparison is exact)', () => {
    const h = pinned.get('demo-check.webp')!;
    const off = h.slice(0, -1) + (h.endsWith('0') ? '1' : '0');
    expect(sha('demo-check.webp')).not.toBe(off);
  });
});
