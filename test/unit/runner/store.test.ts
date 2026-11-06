// GAS-03: native File storage (server/runner/store.ts). Every store here lives in a fresh directory under
// os.tmpdir() opened with explicitTest (which lifts the location rules only); the real app-data dir is
// never touched. unsafeReason's location classes are checked on paths that need not exist.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultStoreDir, KeystoreStore, StoreError, unsafeReason } from '../../../server/runner/store';

const addr = () => randomBytes(20).toString('hex');
const posix = process.platform !== 'win32';
const nowhere = () => `/nonexistent-cbpr-${randomBytes(6).toString('hex')}`;

const storeErr = (f: () => unknown) => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof StoreError ? e.kind : `other:${(e as Error).message}`;
  }
};

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cbpr-store-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('defaultStoreDir', () => {
  it('macOS → ~/Library/Application Support/passkey-recovery/gas-wallets', () => {
    expect(defaultStoreDir({}, 'darwin')).toBe(join(homedir(), 'Library', 'Application Support', 'passkey-recovery', 'gas-wallets'));
  });
  it('Windows → %APPDATA%, falling back to ~/AppData/Roaming', () => {
    expect(defaultStoreDir({ APPDATA: '/synthetic/appdata' }, 'win32')).toBe(join('/synthetic/appdata', 'passkey-recovery', 'gas-wallets'));
    expect(defaultStoreDir({}, 'win32')).toBe(join(homedir(), 'AppData', 'Roaming', 'passkey-recovery', 'gas-wallets'));
  });
  it('Linux → $XDG_DATA_HOME, falling back to ~/.local/share', () => {
    expect(defaultStoreDir({ XDG_DATA_HOME: '/synthetic/xdg' }, 'linux')).toBe(join('/synthetic/xdg', 'passkey-recovery', 'gas-wallets'));
    expect(defaultStoreDir({}, 'linux')).toBe(join(homedir(), '.local', 'share', 'passkey-recovery', 'gas-wallets'));
  });
});

describe('unsafeReason', () => {
  it('an ordinary location outside tmp, git and cloud → null', () => {
    expect(unsafeReason(join(nowhere(), 'store'))).toBeNull();
  });

  it.each(['Dropbox', 'Google Drive', 'OneDrive', 'iCloud', 'Mobile Documents', 'CloudStorage'])('a %s folder → cloud-sync', (name) => {
    expect(unsafeReason(join(nowhere(), name, 'store'))).toMatch(/cloud-sync/);
  });

  it.each(['/tmp', '/private/tmp', '/var/folders'])('under %s → temporary directory (or a symlinked parent)', (t) => {
    // On macOS /tmp and /var are themselves symlinks, which the walk refuses first; either way it is refused.
    expect(unsafeReason(join(t, `cbpr-${randomBytes(4).toString('hex')}`, 'store'))).toMatch(/temporary directory|symbolic link/);
  });

  it('under os.tmpdir() as given → refused', () => {
    expect(unsafeReason(join(tmpdir(), 'cbpr-x', 'store'))).not.toBeNull();
  });

  // Regression: on macOS tmpdir() is /var/folders/…/T and its real path /private/var/folders/…/T; both
  // forms are refused.
  it('under the real path of os.tmpdir() → temporary directory', () => {
    expect(unsafeReason(join(base, 'store')) ?? 'accepted (null)').toMatch(/temporary directory/);
  });

  // Needs a git checkout outside any temporary directory; an exported source tree (scripts/release/export.mjs) is neither.
  const checkout = resolve('.');
  const realCheckout = realpathSync(checkout);
  const inTemp = [tmpdir(), realpathSync(tmpdir()), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].some((t) => realCheckout === t || realCheckout.startsWith(t + sep));
  it.runIf(existsSync(join(checkout, '.git')) && !inTemp)('inside a git repository → git (this repo; nothing is created)', () => {
    expect(unsafeReason(join(resolve('.'), 'node_modules', `.cbpr-none-${randomBytes(4).toString('hex')}`))).toMatch(/git repository/);
  });

  it('regression: the default app-data directory is accepted when the runner starts from the home directory', () => {
    const cwd = process.cwd();
    try {
      process.chdir(homedir());
      expect(unsafeReason(defaultStoreDir())).toBeNull();
    } finally {
      process.chdir(cwd);
    }
  });

  it('explicitTest lifts the location rules (a temp dir is allowed)', () => {
    expect(unsafeReason(join(base, 'store'), { explicitTest: true })).toBeNull();
  });

  it('a symlinked store dir is refused, even with explicitTest', () => {
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    expect(unsafeReason(join(base, 'link'), { explicitTest: true })).toMatch(/symbolic link \(the store itself\)/);
  });

  it('a symlinked parent is refused without explicitTest and allowed with it', () => {
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    expect(unsafeReason(join(base, 'link', 'store'))).toMatch(/symbolic link \(a parent\)/);
    expect(unsafeReason(join(base, 'link', 'store'), { explicitTest: true })).toBeNull();
  });
});

describe('KeystoreStore', () => {
  const open = (sub = 'store') => new KeystoreStore(join(base, sub), { explicitTest: true });

  it('the constructor refuses an unsafe location with unsafe-dir', () => {
    // A cloud-sync path (need not exist; the constructor creates nothing). The same path in test mode is allowed.
    const p = join(nowhere(), 'Dropbox', 'store');
    expect(storeErr(() => new KeystoreStore(p))).toBe('unsafe-dir');
    expect(storeErr(() => new KeystoreStore(p, { explicitTest: true }))).toBeNull();
  });

  it('the constructor refuses a symlinked store dir even in test mode', () => {
    mkdirSync(join(base, 'real'));
    symlinkSync(join(base, 'real'), join(base, 'link'));
    expect(storeErr(() => new KeystoreStore(join(base, 'link'), { explicitTest: true }))).toBe('unsafe-dir');
  });

  it('list() on a store that does not exist yet → [] and creates nothing', () => {
    const s = open();
    expect(s.list()).toEqual([]);
    expect(existsSync(s.dir)).toBe(false);
  });

  it.runIf(posix)('create() makes the dir 0700 and the file 0600, under gas-<address>.json, leaving no temp file', () => {
    const s = open();
    const a = addr();
    const file = s.create(a, '{"version":3}');
    expect(file).toBe(`gas-${a}.json`);
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.dir, file)).mode & 0o777).toBe(0o600);
    expect(readdirSync(s.dir)).toEqual([file]);
  });

  it('create() then read() round-trips the JSON; list() reports the address', () => {
    const s = open();
    const a = addr();
    s.create(a, '{"version":3,"synthetic":true}');
    expect(s.read(`gas-${a}.json`)).toBe('{"version":3,"synthetic":true}');
    expect(s.list()).toEqual([{ file: `gas-${a}.json`, address: `0x${a}` }]);
  });

  it('create() never overwrites an existing keystore → exists, original content kept', () => {
    const s = open();
    const a = addr();
    s.create(a, '{"first":1}');
    expect(storeErr(() => s.create(a, '{"second":2}'))).toBe('exists');
    expect(s.read(`gas-${a}.json`)).toBe('{"first":1}');
  });

  it('create() refuses to write through a dangling symlink at the final name → exists', () => {
    const s = open();
    const a = addr();
    s.list();
    mkdirSync(s.dir, { mode: 0o700 });
    symlinkSync(join(base, 'target-that-does-not-exist'), join(s.dir, `gas-${a}.json`));
    expect(storeErr(() => s.create(a, '{}'))).toBe('exists');
    expect(existsSync(join(base, 'target-that-does-not-exist'))).toBe(false);
  });

  it.each(['ABCDEF'.repeat(6) + 'abcd', 'abc', `0x${addr()}`, `${addr()}0`])('create() refuses address %j → malformed', (a) => {
    expect(storeErr(() => open().create(a, '{}'))).toBe('malformed');
  });

  it.runIf(posix)('an existing store dir that is not private (0755) is refused → unsafe-dir', () => {
    const s = open();
    mkdirSync(s.dir);
    chmodSync(s.dir, 0o755);
    expect(storeErr(() => s.list())).toBe('unsafe-dir');
    expect(storeErr(() => s.create(addr(), '{}'))).toBe('unsafe-dir');
  });

  it.runIf(posix)('read() refuses a keystore file that is not 0600 → malformed', () => {
    const s = open();
    const a = addr();
    s.create(a, '{}');
    chmodSync(join(s.dir, `gas-${a}.json`), 0o644);
    expect(storeErr(() => s.read(`gas-${a}.json`))).toBe('malformed');
  });

  it('read() refuses a symlink at a valid name → malformed', () => {
    const s = open();
    const a = addr();
    s.create(a, '{}');
    const other = addr();
    symlinkSync(join(s.dir, `gas-${a}.json`), join(s.dir, `gas-${other}.json`));
    expect(storeErr(() => s.read(`gas-${other}.json`))).toBe('malformed');
  });

  it.each(['../gas-0000000000000000000000000000000000000000.json', 'gas-ABC.json', 'keystore.json', `gas-${'a'.repeat(40)}.json.bak`])('read() refuses the name %j → not-found', (n) => {
    expect(storeErr(() => open().read(n))).toBe('not-found');
  });

  it('read() of a valid but absent name → not-found', () => {
    expect(storeErr(() => open().read(`gas-${addr()}.json`))).toBe('not-found');
  });

  it('list() ignores non-matching names, directories and symlinks', () => {
    const s = open();
    const a = addr();
    s.create(a, '{}');
    writeFileSync(join(s.dir, 'notes.txt'), 'x', { mode: 0o600 });
    writeFileSync(join(s.dir, `gas-${'A'.repeat(40)}.json`), '{}', { mode: 0o600 });
    writeFileSync(join(s.dir, '.tmp-0011223344556677'), '{}', { mode: 0o600 });
    mkdirSync(join(s.dir, `gas-${addr()}.json`));
    symlinkSync(join(s.dir, `gas-${a}.json`), join(s.dir, `gas-${addr()}.json`));
    expect(s.list().map((x) => x.file)).toEqual([`gas-${a}.json`]);
  });
});
