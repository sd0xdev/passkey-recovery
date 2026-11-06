// Native File storage (GAS-03, local runner): encrypted v3 keystores in the OS app-data directory. The
// directory is created 0700 and every file 0600; a new file is written to an O_EXCL temp name and then
// hard-linked to its final name, so an existing keystore is never overwritten. Symlinks are refused, and
// so are directories inside a repository, a temp directory or a cloud-sync folder — unless a test passes
// an explicit directory. This module stores only already-encrypted JSON; it never sees a password.
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

export class StoreError extends Error {
  override name = 'StoreError';
  constructor(
    readonly kind: 'unsafe-dir' | 'exists' | 'not-found' | 'malformed' | 'io',
    message: string,
  ) {
    super(message);
  }
}

const NAME = /^gas-[0-9a-f]{40}\.json$/;
const CLOUD = /(Mobile Documents|CloudStorage|Dropbox|Google Drive|OneDrive|iCloud)/i;

export function defaultStoreDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'passkey-recovery', 'gas-wallets');
  if (platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'passkey-recovery', 'gas-wallets');
  return join(env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'passkey-recovery', 'gas-wallets');
}

/** Why a directory may not hold keystores, or null when it may. `explicitTest` lifts the location rules only. */
export function unsafeReason(dir: string, o: { explicitTest?: boolean } = {}): string | null {
  const abs = resolve(dir);
  // Walk up: no component may be a symlink (a link could point the store anywhere).
  for (let p = abs; ; p = dirname(p)) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink() && !(o.explicitTest && p !== abs)) return `a path component is a symbolic link (${p === abs ? 'the store itself' : 'a parent'})`;
    if (dirname(p) === p) break;
  }
  if (o.explicitTest) return null;
  const real = existsSync(abs) ? realpathSync(abs) : abs;
  if (CLOUD.test(real)) return 'the directory is inside a cloud-sync folder';
  const tmp = tmpdir();
  for (const t of [tmp, existsSync(tmp) ? realpathSync(tmp) : tmp, '/tmp', '/private/tmp', '/var/folders', '/private/var/folders']) if (real === t || real.startsWith(t + sep)) return 'the directory is inside a temporary directory';
  for (let p = real; dirname(p) !== p; p = dirname(p)) if (existsSync(join(p, '.git'))) return 'the directory is inside a git repository';
  return null;
}

export class KeystoreStore {
  readonly dir: string;
  constructor(dir: string, o: { explicitTest?: boolean } = {}) {
    this.dir = resolve(dir);
    const why = unsafeReason(this.dir, o);
    if (why) throw new StoreError('unsafe-dir', `refusing to keep gas keystores here: ${why}`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(this.dir);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new StoreError('unsafe-dir', 'the store is not a plain directory');
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new StoreError('unsafe-dir', 'the store directory must be private (mode 0700)');
  }

  list(): Array<{ file: string; address: string }> {
    if (!existsSync(this.dir)) return [];
    this.ensureDir();
    return readdirSync(this.dir)
      .filter((n) => NAME.test(n))
      .filter((n) => {
        const st = lstatSync(join(this.dir, n));
        return st.isFile() && !st.isSymbolicLink();
      })
      .map((n) => ({ file: n, address: `0x${n.slice(4, 44)}` }));
  }

  read(file: string): string {
    if (!NAME.test(file)) throw new StoreError('not-found', 'unknown keystore name');
    const p = join(this.dir, file);
    if (!existsSync(p)) throw new StoreError('not-found', 'no such keystore');
    const st = lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) throw new StoreError('malformed', 'not a plain file');
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new StoreError('malformed', 'keystore file must be mode 0600');
    return readFileSync(p, 'utf8');
  }

  /** Atomic create-only write of an encrypted keystore for `address` (lowercase hex, no 0x). */
  create(address: string, json: string): string {
    if (!/^[0-9a-f]{40}$/.test(address)) throw new StoreError('malformed', 'address must be 40 lowercase hex');
    this.ensureDir();
    const file = `gas-${address}.json`;
    const final = join(this.dir, file);
    if (existsSync(final)) throw new StoreError('exists', 'a keystore for this address already exists; it is never overwritten');
    const tmp = join(this.dir, `.tmp-${randomBytes(8).toString('hex')}`);
    let fd: number | null = null;
    try {
      fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
      writeSync(fd, json);
      fsyncSync(fd);
      closeSync(fd);
      fd = null;
      linkSync(tmp, final);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new StoreError('exists', 'a keystore for this address already exists; it is never overwritten');
      throw new StoreError('io', 'could not write the keystore');
    } finally {
      if (fd !== null) closeSync(fd);
      if (existsSync(tmp)) unlinkSync(tmp);
    }
    return file;
  }
}
