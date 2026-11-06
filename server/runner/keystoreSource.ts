// Existing gas wallet, chosen by the user: an encrypted v3 keystore that is either at the path a field of their
// 1Password item holds, or a file they picked in the page (its encrypted bytes come to this signer only). Both are
// untrusted input. A path is never sent by the page — it is read from the item in this process — and is opened
// read-only, without a shell, without following links, only as a small private plain file of this user. Nothing
// here writes, copies, moves or re-encrypts a wallet, and no error carries the bytes of the file it refused.
import { createHash } from 'node:crypto';
import { constants, createReadStream, fstatSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import { isAbsolute, normalize, sep } from 'node:path';

export type KeystoreSourceErrorKind = 'path' | 'missing' | 'symlink' | 'not-file' | 'permissions' | 'size' | 'format' | 'password-field' | 'wrong-password' | 'manifest-changed' | 'manifest-address' | 'changed';

export class KeystoreSourceError extends Error {
  override name = 'KeystoreSourceError';
  constructor(
    readonly kind: KeystoreSourceErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** A v3 keystore is well under 2 KiB; anything this large is not one. */
export const MAX_KEYSTORE_BYTES = 16 * 1024;

export interface KeystoreBytes {
  text: string;
  sha256: string;
}

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** The keystore location a 1Password field holds: one absolute, normalized path (surrounding whitespace aside). */
export function keystorePathOf(value: string): string {
  const p = value.trim();
  if (!p || p.length > 1024 || /[\u0000-\u001f\u007f]/.test(p) || !isAbsolute(p) || normalize(p) !== p || (p.length > 1 && p.endsWith(sep))) {
    throw new KeystoreSourceError('path', 'the field chosen for the keystore location does not hold one absolute file path');
  }
  return p;
}

/** Version-3 keystore structure only; the content is never echoed back. */
export function checkKeystoreText(text: string): void {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new KeystoreSourceError('format', 'the chosen file is not a version 3 keystore');
  }
  const c = j && typeof j === 'object' && !Array.isArray(j) ? ((j as { crypto?: unknown; Crypto?: unknown }).crypto ?? (j as { Crypto?: unknown }).Crypto) : null;
  if ((j as { version?: unknown } | null)?.version !== 3 || !c || typeof c !== 'object' || typeof (c as { kdf?: unknown }).kdf !== 'string' || typeof (c as { ciphertext?: unknown }).ciphertext !== 'string') {
    throw new KeystoreSourceError('format', 'the chosen file is not a version 3 keystore');
  }
}

const POSIX = process.platform !== 'win32';

/** Test seam only: called between the checks and the read, so a test can swap the file there. */
export interface ReadSeam {
  afterCheck?(): void;
  afterOpen?(): void;
}

/**
 * Reads the keystore at `path`, read-only (a read stream: no write API, which stays in store.ts). The path must be
 * its own real path (no link anywhere on it). Every check is made on the descriptor that is then read — a plain
 * file, the same inode the path named when it was checked, of this user, private (no group/other bits), at most
 * MAX_KEYSTORE_BYTES — and at most MAX_KEYSTORE_BYTES + 1 bytes are ever read. Opened without following a link and
 * without blocking (a FIFO swapped in is refused, not waited on). After the read the path must still name that
 * same, unmodified file. A file swapped in at any point is refused, never used.
 */
export function readKeystoreAt(path: string, seam: ReadSeam = {}): Promise<KeystoreBytes> {
  let before: Stats;
  try {
    before = statAt(path);
    checkStats(before);
  } catch (e) {
    return Promise.reject(e);
  }
  seam.afterCheck?.();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let opened: Stats | null = null;
    let failure: unknown = null;
    // Numeric open flags are passed to fs.open as is (the typings only list the string forms).
    const flags = (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)) as unknown as string;
    const s = createReadStream(path, { flags, start: 0, end: MAX_KEYSTORE_BYTES, highWaterMark: 4096 });
    const fail = (e: unknown) => {
      failure ??= e;
      s.destroy();
    };
    s.on('open', (fd: number) => {
      try {
        const st = fstatSync(fd);
        checkStats(st);
        if (st.ino !== before.ino || st.dev !== before.dev) throw new KeystoreSourceError('not-file', 'the keystore file changed while it was being opened');
        opened = st;
        seam.afterOpen?.();
      } catch (e) {
        fail(e);
      }
    });
    s.on('data', (c: Buffer | string) => {
      if (failure || typeof c === 'string') return;
      n += c.length;
      if (n > MAX_KEYSTORE_BYTES) fail(new KeystoreSourceError('size', 'the file is too large to be a keystore'));
      else chunks.push(c);
    });
    s.on('error', (e) => fail(e instanceof KeystoreSourceError ? e : fsError(e)));
    s.on('close', () => {
      const buf = Buffer.concat(chunks);
      for (const c of chunks) c.fill(0);
      try {
        if (failure) throw failure;
        if (!opened) throw new KeystoreSourceError('not-file', 'the keystore path cannot be opened as a plain file');
        const st: Stats = opened;
        const after = statAt(path);
        if (n !== st.size || after.ino !== st.ino || after.dev !== st.dev || after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw new KeystoreSourceError('not-file', 'the keystore file changed while it was being read');
        const text = buf.toString('utf8');
        checkKeystoreText(text);
        resolve({ text, sha256: sha256(text) });
      } catch (e) {
        reject(e);
      } finally {
        buf.fill(0);
      }
    });
  });
}

/** A plain file of this user, private (POSIX), small enough to be a keystore. */
function checkStats(st: Stats) {
  if (!st.isFile()) throw new KeystoreSourceError('not-file', 'the keystore path is not a plain file');
  if (POSIX && (st.mode & 0o077) !== 0) throw new KeystoreSourceError('permissions', 'the keystore file must be private to you (mode 0600)');
  if (POSIX && typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new KeystoreSourceError('permissions', 'the keystore file belongs to another user');
  if (st.size > MAX_KEYSTORE_BYTES) throw new KeystoreSourceError('size', 'the file is too large to be a keystore');
}

/** lstat of `path` once its real path is itself: a link anywhere on the path is refused before anything is read. */
function statAt(path: string): Stats {
  try {
    if (realpathSync(path) !== path) throw new KeystoreSourceError('symlink', 'the keystore path goes through a symbolic link');
    return lstatSync(path);
  } catch (e) {
    throw e instanceof KeystoreSourceError ? e : fsError(e);
  }
}

/** A file the user picked in the page: its name is display only; its text must be a small v3 keystore. */
export function uploadedKeystore(name: unknown, text: unknown): KeystoreBytes & { name: string } {
  if (typeof text !== 'string' || !text) throw new KeystoreSourceError('format', 'no keystore file was chosen');
  if (Buffer.byteLength(text, 'utf8') > MAX_KEYSTORE_BYTES) throw new KeystoreSourceError('size', 'the file is too large to be a keystore');
  checkKeystoreText(text);
  const shown = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f/\\]/g, '').slice(0, 120) : '';
  return { name: shown || 'keystore', text, sha256: sha256(text) };
}

/** The sha256 of the file at `path` now, or null when it cannot be read as a keystore any more. */
export async function currentSha256(path: string): Promise<string | null> {
  try {
    return (await readKeystoreAt(path)).sha256;
  } catch {
    return null;
  }
}

function fsError(e: unknown): KeystoreSourceError {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new KeystoreSourceError('missing', 'there is no file at the keystore path');
  if (code === 'ELOOP') return new KeystoreSourceError('symlink', 'the keystore path is a symbolic link');
  if (code === 'EACCES' || code === 'EPERM') return new KeystoreSourceError('permissions', 'the runner may not read the keystore file');
  return new KeystoreSourceError('not-file', 'the keystore path cannot be opened as a plain file');
}
