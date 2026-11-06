// Pinned Anvil for the local runner (NX-02). The runner depends directly on Foundry's per-platform npm
// packages (optionalDependencies, no install scripts) instead of the @foundry-rs/anvil wrapper, whose
// postinstall can download a binary at install time. Before first use the binary's sha256 must equal
// the pin below (recorded from `npm pack` of 1.7.1, never executed while recording); a mismatch, a
// missing package or an unsupported platform stops the runner with a clear message.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const ANVIL_VERSION = '1.7.1';

export const ANVIL_PINS: Readonly<Record<string, { pkg: string; bin: string; sha256: string }>> = {
  'darwin-arm64': { pkg: '@foundry-rs/anvil-darwin-arm64', bin: 'bin/anvil', sha256: '5c9f9aad323062b1c0421a63595741430acaea150da3611e38c45071e4cf4e28' },
  'darwin-x64': { pkg: '@foundry-rs/anvil-darwin-amd64', bin: 'bin/anvil', sha256: '50f019761f6054085e8d1c952ce4f4c53e8bebdfac90d4993c2e0ebd8915bda2' },
  'linux-x64': { pkg: '@foundry-rs/anvil-linux-amd64', bin: 'bin/anvil', sha256: '10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b' },
  'linux-arm64': { pkg: '@foundry-rs/anvil-linux-arm64', bin: 'bin/anvil', sha256: 'bebaff5c1b6ff6f55b6f2f5f415bb5543f19b948197b5e909195e81ef1727be1' },
  'win32-x64': { pkg: '@foundry-rs/anvil-win32-amd64', bin: 'bin/anvil.exe', sha256: '5c2217d266135a6fbe5faaccccb1e9eb2ddc1d06f8aabeef5fdb16d9846e4880' },
};

export class AnvilPinError extends Error {
  override name = 'AnvilPinError';
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

export interface ResolvedAnvil {
  path: string;
  sha256: string;
  pinned: boolean;
  source: 'npm-pinned' | 'override';
}

/**
 * The pinned binary for this platform. `override` (the CBPR_ANVIL variable, development only) skips the
 * package lookup but is still hashed and reported as unpinned so the runner prints it.
 */
export async function resolveAnvil(o: { platform?: string; arch?: string; from?: string; override?: string; pins?: typeof ANVIL_PINS } = {}): Promise<ResolvedAnvil> {
  if (o.override) {
    if (!existsSync(o.override) || !statSync(o.override).isFile()) throw new AnvilPinError(`CBPR_ANVIL does not name a file`);
    return { path: o.override, sha256: await sha256File(o.override), pinned: false, source: 'override' };
  }
  const key = `${o.platform ?? process.platform}-${o.arch ?? process.arch}`;
  const pin = (o.pins ?? ANVIL_PINS)[key];
  if (!pin) throw new AnvilPinError(`no pinned Anvil for ${key}; supported: ${Object.keys(o.pins ?? ANVIL_PINS).join(', ')}`);
  const req = createRequire(o.from ?? import.meta.url);
  let pkgJson: string;
  try {
    pkgJson = req.resolve(`${pin.pkg}/package.json`);
  } catch {
    throw new AnvilPinError(`${pin.pkg}@${ANVIL_VERSION} is not installed (it is an optional dependency for ${key}; reinstall without --omit=optional)`);
  }
  const version = (req(pkgJson) as { version?: string }).version;
  if (version !== ANVIL_VERSION) throw new AnvilPinError(`${pin.pkg} is ${version}, expected ${ANVIL_VERSION}`);
  const path = join(dirname(pkgJson), pin.bin);
  if (!existsSync(path)) throw new AnvilPinError(`${pin.pkg} has no ${pin.bin}`);
  const sha256 = await sha256File(path);
  if (sha256 !== pin.sha256) throw new AnvilPinError(`Anvil binary checksum mismatch for ${key}: refusing to run it`);
  return { path, sha256, pinned: true, source: 'npm-pinned' };
}
