// NX-02: the pinned Anvil lookup (server/runner/anvil.ts). Nothing here executes a binary: files are only
// hashed. Hermetic cases build a fake package under a temp node_modules and point `from` at it.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ANVIL_PINS, ANVIL_VERSION, AnvilPinError, resolveAnvil, sha256File } from '../../../server/runner/anvil';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cbpr-anvil-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** A fake `@cbpr-test/anvil-fake` package with a synthetic (non-executable) "binary". */
function fakePackage(o: { version?: string; bin?: Buffer | null } = {}) {
  const pkgDir = join(dir, 'node_modules', '@cbpr-test', 'anvil-fake');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@cbpr-test/anvil-fake', version: o.version ?? ANVIL_VERSION }));
  const bin = o.bin === undefined ? randomBytes(256) : o.bin;
  if (bin) writeFileSync(join(pkgDir, 'bin', 'anvil'), bin);
  const from = join(dir, 'entry.mjs');
  writeFileSync(from, '');
  return { from, bin, path: join(pkgDir, 'bin', 'anvil') };
}
const pinsFor = (hash: string) => ({ 'synth-os': { pkg: '@cbpr-test/anvil-fake', bin: 'bin/anvil', sha256: hash } });

describe('ANVIL_PINS', () => {
  it('pins exactly the five supported platforms', () => {
    expect(Object.keys(ANVIL_PINS).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  });
  it('every pin is a lowercase 64-hex sha256 of a @foundry-rs package binary', () => {
    for (const [k, p] of Object.entries(ANVIL_PINS)) {
      expect(p.sha256, k).toMatch(/^[0-9a-f]{64}$/);
      expect(p.pkg, k).toMatch(/^@foundry-rs\/anvil-/);
      expect(p.bin, k).toBe(k.startsWith('win32') ? 'bin/anvil.exe' : 'bin/anvil');
    }
  });
  it('no two platforms share a checksum', () => {
    expect(new Set(Object.values(ANVIL_PINS).map((p) => p.sha256)).size).toBe(5);
  });
});

describe('sha256File', () => {
  it('equals the in-memory sha256', async () => {
    const b = randomBytes(70_000);
    writeFileSync(join(dir, 'f'), b);
    expect(await sha256File(join(dir, 'f'))).toBe(sha(b));
  });
  it('rejects for a missing file', async () => {
    await expect(sha256File(join(dir, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('resolveAnvil — override (CBPR_ANVIL, development only)', () => {
  it('a file is hashed and reported as unpinned override', async () => {
    const b = randomBytes(128);
    writeFileSync(join(dir, 'anvil'), b);
    expect(await resolveAnvil({ override: join(dir, 'anvil') })).toEqual({ path: join(dir, 'anvil'), sha256: sha(b), pinned: false, source: 'override' });
  });
  it('a missing path → AnvilPinError', async () => {
    await expect(resolveAnvil({ override: join(dir, 'nope') })).rejects.toBeInstanceOf(AnvilPinError);
  });
  it('a directory → AnvilPinError', async () => {
    await expect(resolveAnvil({ override: dir })).rejects.toThrow(/does not name a file/);
  });
});

describe('resolveAnvil — pinned package', () => {
  it('an unsupported platform → AnvilPinError listing the supported ones', async () => {
    await expect(resolveAnvil({ platform: 'freebsd', arch: 'x64' })).rejects.toThrow(/no pinned Anvil for freebsd-x64; supported: darwin-arm64/);
  });

  it('a matching fake package → pinned npm-pinned', async () => {
    const p = fakePackage();
    expect(await resolveAnvil({ platform: 'synth', arch: 'os', from: p.from, pins: pinsFor(sha(p.bin!)) })).toEqual({ path: p.path, sha256: sha(p.bin!), pinned: true, source: 'npm-pinned' });
  });

  it('a checksum mismatch → refuses to run it', async () => {
    const p = fakePackage();
    await expect(resolveAnvil({ platform: 'synth', arch: 'os', from: p.from, pins: pinsFor('0'.repeat(64)) })).rejects.toThrow(/checksum mismatch for synth-os/);
  });

  it('another package version → AnvilPinError naming both versions', async () => {
    const p = fakePackage({ version: '0.0.1' });
    await expect(resolveAnvil({ platform: 'synth', arch: 'os', from: p.from, pins: pinsFor(sha(p.bin!)) })).rejects.toThrow(`is 0.0.1, expected ${ANVIL_VERSION}`);
  });

  it('a package without its binary → AnvilPinError', async () => {
    const p = fakePackage({ bin: null });
    await expect(resolveAnvil({ platform: 'synth', arch: 'os', from: p.from, pins: pinsFor('0'.repeat(64)) })).rejects.toThrow(/has no bin\/anvil/);
  });

  it('a package that is not installed → AnvilPinError mentioning optional dependencies', async () => {
    writeFileSync(join(dir, 'entry.mjs'), '');
    await expect(resolveAnvil({ platform: 'synth', arch: 'os', from: join(dir, 'entry.mjs'), pins: pinsFor('0'.repeat(64)) })).rejects.toThrow(/is not installed .*--omit=optional/);
  });

  const here = `${process.platform}-${process.arch}`;
  it.runIf(here === 'darwin-arm64')('the installed @foundry-rs/anvil-darwin-arm64 verifies against its pin (hash only, never executed)', async () => {
    const r = await resolveAnvil();
    expect(r).toMatchObject({ pinned: true, source: 'npm-pinned', sha256: ANVIL_PINS['darwin-arm64']!.sha256 });
    expect(r.path).toMatch(/@foundry-rs[/\\]anvil-darwin-arm64[/\\]bin[/\\]anvil$/);
  });

  it.runIf(here === 'darwin-arm64')('the installed package against a wrong pin → checksum mismatch', async () => {
    const pins = { ...ANVIL_PINS, 'darwin-arm64': { ...ANVIL_PINS['darwin-arm64']!, sha256: 'f'.repeat(64) } };
    await expect(resolveAnvil({ pins })).rejects.toThrow(/checksum mismatch for darwin-arm64/);
  });
});
