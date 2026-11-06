// keystoreSource (server/runner/keystoreSource.ts): the untrusted keystore location / picked file of the existing
// gas wallet. Every file is a SYNTHETIC keystore (throwaway key, low scrypt cost) in a fresh temp dir.
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKeystoreText, currentSha256, keystorePathOf, KeystoreSourceError, MAX_KEYSTORE_BYTES, readKeystoreAt, uploadedKeystore } from '../../../server/runner/keystoreSource';
import { encryptKeystore } from '../../fixtures/keystore';

let dir: string;
let ks: string;
let text: string;
beforeEach(() => {
  // realpath: macOS tmpdir() is itself behind a link (/var → /private/var), which the reader refuses by design.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'cbpr-ks-src-')));
  chmodSync(dir, 0o700);
  text = encryptKeystore(randomBytes(32), 'synthetic pass');
  ks = join(dir, 'gas-keystore.json');
  writeFileSync(ks, text, { mode: 0o600 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const akind = async (f: () => Promise<unknown>) => {
  try {
    await f();
  } catch (e) {
    if (e instanceof KeystoreSourceError) return { kind: e.kind, message: e.message };
    throw e;
  }
  return null;
};
const kindOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof KeystoreSourceError) return { kind: e.kind, message: e.message };
    throw e;
  }
  return null;
};

describe('keystorePathOf', () => {
  it('one absolute normalized path → itself (surrounding whitespace dropped)', () => {
    expect(keystorePathOf(`  ${ks}\n`)).toBe(ks);
  });
  it.each([
    ['empty', ''],
    ['relative', 'keystore.json'],
    ['home shorthand', '~/keystore.json'],
    ['a .. segment', '/Users/someone/../etc/keystore.json'],
    ['a double slash', '//Users/someone/keystore.json'],
    ['a trailing slash', '/Users/someone/keys/'],
    ['two paths', '/a/keystore.json\n/b/keystore.json'],
    ['a NUL', '/a/key\u0000store.json'],
    ['too long', `/${'a'.repeat(1100)}`],
    ['a URL', 'file:///etc/passwd'],
  ])('%s → path', (_, v) => {
    expect(kindOf(() => keystorePathOf(v))?.kind).toBe('path');
  });
});

describe('readKeystoreAt', () => {
  it('a private plain v3 keystore of this user → its exact text and sha256', async () => {
    const r = await readKeystoreAt(ks);
    expect(r.text).toBe(text);
    expect(r.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect(await currentSha256(ks)).toBe(r.sha256);
  });

  it('the same words as data: a file named like a system path but private and v3 is read', async () => {
    const named = join(dir, 'etc-passwd.json');
    writeFileSync(named, text, { mode: 0o600 });
    expect((await readKeystoreAt(named)).text).toBe(text);
  });

  it('a symbolic link to a valid keystore → symlink (the target is not read)', async () => {
    const link = join(dir, 'link.json');
    symlinkSync(ks, link);
    expect((await akind(() => readKeystoreAt(link)))?.kind).toBe('symlink');
  });

  it('a link in a parent directory → symlink', async () => {
    const sub = join(dir, 'real');
    mkdirSync(sub, { mode: 0o700 });
    writeFileSync(join(sub, 'k.json'), text, { mode: 0o600 });
    symlinkSync(sub, join(dir, 'alias'));
    expect((await akind(() => readKeystoreAt(join(dir, 'alias', 'k.json'))))?.kind).toBe('symlink');
  });

  it.each([
    ['readable by group and others (0644)', 0o644],
    ['readable by group (0640)', 0o640],
    ['writable by others (0602)', 0o602],
  ])('%s → permissions', async (_, mode) => {
    chmodSync(ks, mode);
    expect((await akind(() => readKeystoreAt(ks)))?.kind).toBe('permissions');
  });

  it('a directory → not-file', async () => {
    const d = join(dir, 'd.json');
    mkdirSync(d, { mode: 0o700 });
    expect((await akind(() => readKeystoreAt(d)))?.kind).toBe('not-file');
  });

  it('a FIFO → not-file, without blocking on it', async () => {
    const fifo = join(dir, 'pipe.json');
    execFileSync('/usr/bin/mkfifo', ['-m', '600', fifo]);
    expect((await akind(() => readKeystoreAt(fifo)))?.kind).toBe('not-file');
  });

  it('missing → missing', async () => {
    expect((await akind(() => readKeystoreAt(join(dir, 'gone.json'))))?.kind).toBe('missing');
  });

  it(`larger than ${MAX_KEYSTORE_BYTES} bytes → size`, async () => {
    writeFileSync(ks, `${text}${' '.repeat(MAX_KEYSTORE_BYTES)}`, { mode: 0o600 });
    expect((await akind(() => readKeystoreAt(ks)))?.kind).toBe('size');
  });

  it('a private file that is not a keystore → format, and the error carries none of its content', async () => {
    const secret = `SYNTHETIC-SECRET-${randomBytes(6).toString('hex')}`;
    writeFileSync(ks, `127.0.0.1 localhost ${secret}\n`, { mode: 0o600 });
    const e = await akind(() => readKeystoreAt(ks));
    expect(e?.kind).toBe('format');
    expect(e?.message).not.toContain(secret);
    expect(e?.message).not.toContain('localhost');
  });

  it('a system file (/etc/hosts) is refused before any byte is parsed', async () => {
    expect(['permissions', 'symlink']).toContain((await akind(() => readKeystoreAt('/etc/hosts')))?.kind);
  });

  it('replaced after it was read → currentSha256 differs; removed → null', async () => {
    const first = (await readKeystoreAt(ks)).sha256;
    const swap = join(dir, 'swap.json');
    writeFileSync(swap, encryptKeystore(randomBytes(32), 'synthetic pass'), { mode: 0o600 });
    renameSync(swap, ks);
    expect(await currentSha256(ks)).not.toBe(first);
    rmSync(ks);
    expect(await currentSha256(ks)).toBeNull();
  });

  it('never writes: the file bytes and mode are unchanged after a read', async () => {
    await readKeystoreAt(ks);
    expect(readFileSync(ks, 'utf8')).toBe(text);
  });
  // Regression (review): the checks bind to the descriptor that is read, so a file swapped in after the checks — even
  // one restored before the post-read check — is refused, never returned.
  const other = (mode: number) => {
    const b = join(dir, `other-${mode.toString(8)}.json`);
    writeFileSync(b, encryptKeystore(randomBytes(32), 'synthetic pass'), { mode });
    chmodSync(b, mode);
    return b;
  };
  it('swapped for another private keystore after the checks → not-file (another inode is not read)', async () => {
    const b = other(0o600);
    const e = await akind(() => readKeystoreAt(ks, { afterCheck: () => renameSync(b, ks) }));
    expect(e?.kind).toBe('not-file');
  });
  it('swapped for a shared (0644) keystore after the checks and restored right after the open → refused, not returned', async () => {
    const b = other(0o644);
    const keep = join(dir, 'keep.json');
    const e = await akind(() =>
      readKeystoreAt(ks, {
        afterCheck: () => (renameSync(ks, keep), renameSync(b, ks)),
        afterOpen: () => renameSync(keep, ks),
      }),
    );
    expect(['permissions', 'not-file']).toContain(e?.kind);
  });
  it('the same file modified while it is read → not-file', async () => {
    const e = await akind(() => readKeystoreAt(ks, { afterOpen: () => appendFileSync(ks, ' ') }));
    expect(e?.kind).toBe('not-file');
  });
  it('swapped for a large file after the checks → refused; at most MAX + 1 bytes are read', async () => {
    const big = join(dir, 'big.json');
    writeFileSync(big, ' '.repeat(4 * 1024 * 1024), { mode: 0o600 });
    const e = await akind(() => readKeystoreAt(ks, { afterCheck: () => renameSync(big, ks) }));
    expect(['size', 'not-file']).toContain(e?.kind);
  });
});

describe('checkKeystoreText / uploadedKeystore', () => {
  it.each([
    ['not JSON', 'not json'],
    ['version 1', JSON.stringify({ version: 1, crypto: { kdf: 'scrypt', ciphertext: 'aa' } })],
    ['no crypto', JSON.stringify({ version: 3 })],
    ['an array', '[3]'],
    ['a raw private key', `0x${'11'.repeat(32)}`],
  ])('%s → format', (_, t) => {
    expect(kindOf(() => checkKeystoreText(t))?.kind).toBe('format');
  });

  it('a picked v3 keystore → its text, sha256 and a display-only name (no slashes or control characters)', () => {
    const u = uploadedKeystore('../../etc/\u0007wallet.json', text);
    expect(u).toEqual({ name: '....etcwallet.json', text, sha256: createHash('sha256').update(text).digest('hex') });
  });

  it('no name → "keystore"; a long name is cut to 120 characters', () => {
    expect(uploadedKeystore(undefined, text).name).toBe('keystore');
    expect(uploadedKeystore('k'.repeat(300), text).name).toHaveLength(120);
  });

  it.each([
    ['nothing', undefined, 'format'],
    ['an empty file', '', 'format'],
    ['an oversized file', `${text}${' '.repeat(MAX_KEYSTORE_BYTES)}`, 'size'],
    ['not a keystore', 'hello', 'format'],
  ])('%s → %s', (_, t, kind) => {
    expect(kindOf(() => uploadedKeystore('k.json', t))?.kind).toBe(kind);
  });
});
