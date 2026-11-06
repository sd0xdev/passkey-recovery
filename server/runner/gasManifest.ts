// Existing gas wallet (the Terminal signer's format, server/signer/core.ts loadManifest): a public manifest that
// names a local encrypted v3 keystore, its pinned sha256 and the 1Password reference of its password. The
// runner's native signer reads the manifest from the path the runner was started with — never a path a page
// sends — checks the keystore file, and takes the password from the 1Password item the user's Private Link names,
// which must be the item the reference names. Nothing here writes, moves or re-encrypts the wallet.
import { createHash } from 'node:crypto';
import { constants, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { getAddress, type Address } from 'viem';
import { OP_REF_RE } from '../signer/op';
import type { PrivateLink } from './op1p';

export type ManifestErrorKind = 'missing' | 'malformed' | 'chain' | 'keystore' | 'changed' | 'link' | 'password-field' | 'wrong-password' | 'address' | 'stale';

export class ManifestError extends Error {
  override name = 'ManifestError';
  constructor(
    readonly kind: ManifestErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** Where the Terminal signer keeps the public manifest (server/signer/cli.ts) — the default here too. */
export const defaultManifestPath = () => join(homedir(), '.local', 'share', 'passkey-recovery', 'gas-wallet-public.json');

export interface GasManifest {
  address: Address;
  chainId: number;
  /** Absolute path of the encrypted keystore. */
  keystore: string;
  keystoreSha256: string;
  /** Where the password is: `op://<vault>/<item>/<field>`, split. */
  password: { vault: string; item: string; field: string };
}

/** A plain file (no symlink at the last component), at most `max` bytes. Read-only: nothing here writes. */
function readPlain(path: string, max: number, onMissing: () => ManifestError, onBad: (why: string) => ManifestError, privateOnly: boolean): string {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw onMissing();
  }
  if (st.isSymbolicLink() || !st.isFile()) throw onBad('it is not a plain file');
  if (privateOnly && process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw onBad('it must be private to you (mode 0600)');
  if (st.size > max) throw onBad('it is larger than expected');
  let buf: Buffer;
  try {
    // O_NOFOLLOW: a symlink swapped in after the check above is refused, not followed.
    buf = readFileSync(path, { flag: constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) });
  } catch {
    throw onBad('it cannot be read');
  }
  if (buf.length > max) throw onBad('it is larger than expected');
  return buf.toString('utf8');
}

/** Loads and checks the public manifest. Only public data is in it; the password reference is not a secret. */
export function loadGasManifest(path: string, chainId: number): GasManifest {
  const text = readPlain(
    path,
    16 * 1024,
    () => new ManifestError('missing', 'no existing gas wallet manifest was found where this runner looks for it'),
    (why) => new ManifestError('malformed', `the gas wallet manifest cannot be used: ${why}`),
    false,
  );
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ManifestError('malformed', 'the gas wallet manifest is not JSON');
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new ManifestError('malformed', 'the gas wallet manifest is not an object');
  if (typeof m.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(m.address)) throw new ManifestError('malformed', 'the manifest address is malformed');
  if (m.chainId !== chainId) throw new ManifestError('chain', `the manifest is for another chain than ${chainId}`);
  if (typeof m.keystore !== 'string' || !isAbsolute(m.keystore)) throw new ManifestError('malformed', 'the manifest does not name the keystore by an absolute path');
  if (typeof m.keystoreSha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(m.keystoreSha256)) throw new ManifestError('malformed', 'the manifest has no keystore sha256');
  if (typeof m.passwordReference !== 'string' || !OP_REF_RE.test(m.passwordReference)) throw new ManifestError('malformed', 'the manifest password reference is not op://<vault id>/<item id>/password');
  const [vault, item, field] = m.passwordReference.slice('op://'.length).split('/') as [string, string, string];
  return { address: getAddress(m.address), chainId, keystore: m.keystore, keystoreSha256: m.keystoreSha256.toLowerCase(), password: { vault, item, field } };
}

/** The encrypted keystore text, after the Terminal signer's own checks: private file, pinned sha256. */
export function readPinnedKeystore(m: GasManifest): string {
  const text = readPlain(
    m.keystore,
    64 * 1024,
    () => new ManifestError('keystore', 'the keystore file the manifest names is not there'),
    (why) => new ManifestError('keystore', `the keystore file cannot be used: ${why}`),
    true,
  );
  if (createHash('sha256').update(text).digest('hex') !== m.keystoreSha256) throw new ManifestError('changed', 'the keystore file differs from the one the manifest pinned');
  return text;
}

/** The Private Link must name the item the manifest's password reference names (its account comes from the link). */
export function checkPasswordLink(m: GasManifest, link: PrivateLink): void {
  if (link.vault !== m.password.vault || link.item !== m.password.item) throw new ManifestError('link', 'this Private Link is not the 1Password item that holds this keystore’s password');
}

