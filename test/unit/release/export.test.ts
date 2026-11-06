// scripts/release/export.mjs refuses an output that is the repository, contains it, or sits inside it outside
// release-out/ — checked on path segments, so `--force` never removes a look-alike such as release-outside/.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts/release/export.mjs');
const run = (out: string) => {
  try {
    execFileSync(process.execPath, [SCRIPT, out, '--force'], { cwd: ROOT, stdio: 'pipe' });
    return 0;
  } catch (e) {
    return (e as { status: number }).status;
  }
};

describe('export.mjs output boundary', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Only folders this test creates are passed with --force: a regressed guard must never be able to remove real
  // repository content. The repository itself and its parent are refused by the same inside() check.
  it.each(['release-outside', 'release-out-secrets'])('refuses the look-alike %s with exit 2 and removes nothing', (rel) => {
    const out = resolve(ROOT, rel);
    expect(existsSync(out)).toBe(false);
    mkdirSync(out);
    made.push(out);
    const marker = join(out, 'marker');
    writeFileSync(marker, 'kept');
    expect(run(out)).toBe(2);
    expect(existsSync(marker)).toBe(true);
  });

  it('accepts a folder outside the repository and writes the manifest', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'cbpr-export-')), 'public');
    made.push(resolve(out, '..'));
    expect(run(out)).toBe(0);
    expect(existsSync(join(out, 'MANIFEST.sha256'))).toBe(true);
  });

  // The public .npmrc is generated, never copied: the working copy's .npmrc is untracked and may carry registry or
  // auth lines, so it is not allowlisted, and the export writes exactly the two pinned settings and lists them in
  // the manifest under their real digest.
  it('generates .npmrc with only the pinned npm settings and covers it in the manifest', () => {
    const allowlist = JSON.parse(readFileSync(join(ROOT, 'scripts/release/public-allowlist.json'), 'utf8')) as { include: string[] };
    expect(allowlist.include).not.toContain('.npmrc');
    const out = join(mkdtempSync(join(tmpdir(), 'cbpr-export-')), 'public');
    made.push(resolve(out, '..'));
    expect(run(out)).toBe(0);
    const body = 'engine-strict=true\nsave-exact=true\n';
    expect(readFileSync(join(out, '.npmrc'), 'utf8')).toBe(body);
    const manifest = readFileSync(join(out, 'MANIFEST.sha256'), 'utf8').split('\n');
    expect(manifest).toContain(`${createHash('sha256').update(body).digest('hex')}  .npmrc`);
    // Every exported file is in the manifest and nothing else is: the generated file is accounted for like a copy.
    const listed = manifest.filter(Boolean).map((l) => l.slice(66)).sort();
    // Manifest names always use '/', while relative() uses the host separator — normalize so the test holds on Windows.
    const onDisk = readdirSync(out, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name !== 'MANIFEST.sha256')
      .map((d) => relative(out, join(d.parentPath, d.name)).split(sep).join('/'))
      .sort();
    expect(listed).toEqual(onDisk);
  });
});
