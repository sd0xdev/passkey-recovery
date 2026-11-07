#!/usr/bin/env node
// `passkey-recovery` — the local runner (HOST-01..06, NX-01..04). Started by the user (`npm run runner`, or
// `npm exec --package <tgz> -- passkey-recovery`; not on the npm registry yet); serves the
// same UI on 127.0.0.1 (fallback) and, for an exact allowlisted website origin, the paired API. It
// packages the keyless sidecar, the pinned Anvil for fork simulation, and the native signer child (the
// only process that may hold a gas key). It binds loopback only, runs no user-supplied command, exposes
// no raw Anvil RPC, and on exit ends only the processes it started.
import { fork as forkChild, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex } from 'viem';
import { SUPPORTED } from '../../src/config/registry';
import { startSidecar } from '../sidecar';
import { Pairing, parseAllowedOrigin, PairingError, RUNNER_PROTOCOL } from '../pairing';
import type { IssuedTx, NativeSign } from '../relay';
import { AnvilPinError, resolveAnvil } from './anvil';

/** Official website origins compiled into a release (exact, https). Empty until a site is deployed. */
export const OFFICIAL_ORIGINS: readonly string[] = [];
/** 4171 is also the one full local preview (`npm run preview`); the native signer takes 4172. */
export const DEFAULT_PORT = 4171;

export interface RunnerArgs {
  port: number;
  signerPort: number;
  allowOrigins: string[];
  nativeSigner: boolean;
  storeDir: string | null;
  storeIsTest: boolean;
  /** The existing gas wallet's public manifest; null = the Terminal signer's default path. */
  gasManifest: string | null;
  allowLoopbackHttpOrigin: boolean;
  help: boolean;
  version: boolean;
}

export class ArgError extends Error {
  override name = 'ArgError';
}

export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = {}): RunnerArgs {
  const a: RunnerArgs = { port: DEFAULT_PORT, signerPort: 0, allowOrigins: [], nativeSigner: true, storeDir: null, storeIsTest: false, gasManifest: null, allowLoopbackHttpOrigin: false, help: false, version: false };
  const port = (v: string | undefined, name: string) => {
    if (!v || !/^[0-9]{2,5}$/.test(v) || Number(v) < 1024 || Number(v) > 65535) throw new ArgError(`${name} needs a port number 1024–65535`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === '--port') a.port = port(argv[++i], '--port');
    else if (k === '--signer-port') a.signerPort = port(argv[++i], '--signer-port');
    else if (k === '--allow-origin') a.allowOrigins.push(argv[++i] ?? '');
    else if (k === '--no-native-signer') a.nativeSigner = false;
    else if (k === '--gas-manifest') {
      const v = argv[++i];
      if (!v || !isAbsolute(v)) throw new ArgError('--gas-manifest needs the absolute path of the gas wallet public manifest');
      a.gasManifest = v;
    }
    else if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--version') a.version = true;
    else throw new ArgError(`unknown option ${JSON.stringify(k.slice(0, 40))} (see --help)`);
  }
  // Test-only switches come from the environment, never from flags a web page could suggest.
  if (env.CBPR_TEST_STORE_DIR) {
    a.storeDir = env.CBPR_TEST_STORE_DIR;
    a.storeIsTest = true;
  }
  a.allowLoopbackHttpOrigin = env.CBPR_TEST_ALLOW_LOOPBACK_ORIGIN === '1';
  if (!a.signerPort) a.signerPort = a.port + 1;
  if (a.signerPort === a.port) throw new ArgError('--signer-port must differ from --port');
  if (a.signerPort < 1024 || a.signerPort > 65535) throw new ArgError('--signer-port must be 1024–65535 (with --port 65535, give --signer-port explicitly)');
  return a;
}

export const HELP = `passkey-recovery — local runner for Passkey Recovery by sd0x

  passkey-recovery [--port ${DEFAULT_PORT}] [--allow-origin https://<your site>] [--no-native-signer]

  From a package file you built with npm pack (no published Release or npm registry package yet), in its folder:
    npm exec --yes --package ./passkey-recovery-<version>.tgz -- passkey-recovery [options]
  From a source checkout:  npm run runner -- [options]

  Opens the recovery tool on http://127.0.0.1:<port>/recover (this computer only).
  --allow-origin   a website that may pair with this runner (exact https origin; repeatable).
                   Pairing still needs the code printed here.
  --no-native-signer   do not start the native signer (1Password / native File gas payers off).
  --gas-manifest   the existing gas wallet's public manifest (keystore + 1Password password reference);
                   default ~/.local/share/passkey-recovery/gas-wallet-public.json. Read only when you open it.
  Ctrl-C stops the runner and every process it started.
  Keys: [p] new pairing code  [u] end all pairings  [q] quit
`;

const out = (s: string) => process.stdout.write(s + '\n');

function packageRoot(): string {
  // dist-server/runner.mjs → package root (holds dist/, registry/, package.json).
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  let args: RunnerArgs;
  try {
    args = parseArgs(argv, env);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const root = packageRoot();
  const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
  if (args.help) return out(HELP), 0;
  if (args.version) return out(version), 0;
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    process.stderr.write('the UI build (dist/) is missing from this package\n');
    return 1;
  }
  let origins: string[];
  try {
    origins = [...new Set([...OFFICIAL_ORIGINS, ...args.allowOrigins.map((o) => parseAllowedOrigin(o, { allowLoopbackHttp: args.allowLoopbackHttpOrigin }))])];
  } catch (e) {
    process.stderr.write(`--allow-origin: ${e instanceof PairingError ? e.message : 'invalid'}\n`);
    return 2;
  }
  let anvil;
  try {
    anvil = await resolveAnvil({ ...(env.CBPR_ANVIL ? { override: env.CBPR_ANVIL } : {}) });
  } catch (e) {
    process.stderr.write(`${e instanceof AnvilPinError ? e.message : 'could not locate Anvil'}\n`);
    return 1;
  }

  const pairing = new Pairing(origins);
  const selfOrigin = `http://127.0.0.1:${args.port}`;
  const children = new Set<ChildProcess>();
  let signer: ChildProcess | null = null;
  let signSeq = 0;
  const pendingSign = new Map<number, (r: Awaited<ReturnType<NativeSign>>) => void>();
  let onPayerChanged: (reason: string) => void = () => undefined;
  let sessionCheck: (origin: string, session?: string, pair?: string) => boolean = () => false;

  if (args.nativeSigner) {
    const entry = join(dirname(fileURLToPath(import.meta.url)), 'signer-service.mjs');
    // A minimal environment: the child needs PATH/HOME for `op` and the app-data directory, nothing else.
    const childEnv: NodeJS.ProcessEnv = { PATH: env.PATH ?? '', HOME: env.HOME ?? '', ...(env.APPDATA ? { APPDATA: env.APPDATA } : {}), ...(env.XDG_DATA_HOME ? { XDG_DATA_HOME: env.XDG_DATA_HOME } : {}), ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}) };
    signer = forkChild(entry, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: childEnv });
    children.add(signer);
    signer.on('exit', () => {
      children.delete(signer!);
      for (const r of pendingSign.values()) r({ ok: false, reason: 'the native signer stopped', code: 'sign-stopped' });
      pendingSign.clear();
      onPayerChanged('signer-stopped');
      signer = null;
    });
    const ready = new Promise<{ storeDir: string | null; storeError: string | null }>((res, rej) => {
      signer!.on('message', (raw) => {
        const m = raw as { t: string; id?: number; result?: Awaited<ReturnType<NativeSign>>; reason?: string; origin?: string; session?: string; pair?: string; storeDir?: string | null; storeError?: string | null };
        if (m.t === 'ready') res({ storeDir: m.storeDir ?? null, storeError: m.storeError ?? null });
        else if (m.t === 'failed') rej(new Error(m.reason ?? 'native signer failed'));
        else if (m.t === 'signed' && m.id !== undefined) (pendingSign.get(m.id)?.(m.result!), pendingSign.delete(m.id));
        else if (m.t === 'payer-changed') onPayerChanged(typeof m.reason === 'string' ? m.reason : 'changed');
        else if (m.t === 'auth' && m.id !== undefined) signer?.send({ t: 'auth-reply', id: m.id, ok: sessionCheck(m.origin ?? '', m.session, m.pair) });
      });
    });
    signer.send({ t: 'init', port: args.signerPort, allowedOrigins: [selfOrigin, ...origins], storeDir: args.storeDir, storeIsTest: args.storeIsTest, gasManifest: args.gasManifest, chainId: SUPPORTED[0]!.chainId, opBin: env.CBPR_TEST_OP_BIN ?? 'op', kdfN: env.CBPR_TEST_KDF_N ? Number(env.CBPR_TEST_KDF_N) : null });
    try {
      const r = await ready;
      out(r.storeError ? `native File storage: off (${r.storeError})` : `native File storage: ${r.storeDir}`);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      signer?.kill('SIGTERM');
      return 1;
    }
  }

  const nativeSign: NativeSign | undefined = args.nativeSigner
    ? (tx: IssuedTx) =>
        new Promise((res) => {
          if (!signer?.connected) return res({ ok: false, reason: 'the native signer is not running', code: 'sign-stopped' });
          const id = ++signSeq;
          pendingSign.set(id, res);
          const s = (v: bigint) => v.toString();
          signer.send({ t: 'sign', id, tx: { chainId: tx.chainId, from: tx.from, to: tx.to, data: tx.data as Hex, nonce: s(tx.nonce), gas: s(tx.gas), maxFeePerGas: s(tx.maxFeePerGas), maxPriorityFeePerGas: s(tx.maxPriorityFeePerGas) } });
          setTimeout(() => pendingSign.delete(id) && res({ ok: false, reason: 'the native signer did not answer', code: 'sign-timeout' }), 15_000);
        })
    : undefined;

  let side: Awaited<ReturnType<typeof startSidecar>>;
  try {
    side = await startSidecar({ port: args.port, root, dist: join(root, 'dist'), anvilBin: anvil.path, pairing, version, ...(nativeSign ? { nativeSigner: nativeSign, nativeSignerUrl: `http://127.0.0.1:${args.signerPort}` } : {}) });
  } catch (e) {
    process.stderr.write(`could not start on 127.0.0.1:${args.port} (${(e as NodeJS.ErrnoException).code ?? (e as Error).name})\n`);
    for (const c of children) c.kill('SIGTERM');
    return 1;
  }
  sessionCheck = (origin, session, pair) => (origin === selfOrigin ? session === side.cfg.sessionToken : pairing.check(origin, pair));
  onPayerChanged = (reason) => {
    side.transfers.payerChanged({ reason: reason.replace(/[^a-z-]/g, '').slice(0, 40) || 'changed' });
    side.deployRelay.voidAll();
  };

  out(`Passkey Recovery runner ${version} (protocol ${RUNNER_PROTOCOL}) — mode ${side.mode}`);
  out(`Anvil ${anvil.pinned ? `pinned ${anvil.sha256.slice(0, 16)}…` : `UNPINNED override ${anvil.sha256.slice(0, 16)}…`}`);
  out(`Open on this computer: ${selfOrigin}/recover`);
  if (origins.length) {
    out(`Websites allowed to pair: ${origins.join(', ')}`);
    pairing.onNewCode((code, exp) => out(`Pairing code: ${code}  (valid until ${new Date(exp).toLocaleTimeString()}, single use)`));
    pairing.newCode();
  } else out('No website may pair (start with --allow-origin to allow one). The local page needs no pairing.');
  out('Keys: [p] new pairing code  [u] end all pairings  [q] quit — or Ctrl-C');

  let stopping = false;
  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    out(`stopping (${why})…`);
    pairing.revokeAll();
    for (const c of children) {
      if (c.connected) c.send({ t: 'stop' });
      setTimeout(() => c.kill('SIGKILL'), 2000).unref();
    }
    await side.close().catch(() => undefined);
    await side.forks.closeAll().catch(() => undefined);
    await Promise.all([...children].map((c) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once('exit', () => r())))));
    out('stopped; no process started by the runner is left running.');
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void stop(sig));
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', (l) => {
      const k = l.trim().toLowerCase();
      if (k === 'p') origins.length ? pairing.newCode() : out('no website is allowed to pair');
      else if (k === 'u') (pairing.revokeAll(), out('all pairings ended'));
      else if (k === 'q') void stop('quit');
    });
  }
  return -1;
}

const isMain = process.argv[1] !== undefined && /runner\.(m?js|ts)$|passkey-recovery$/.test(process.argv[1]);
if (isMain)
  void main().then(
    (code) => code >= 0 && process.exit(code),
    () => {
      process.stderr.write('the runner failed to start\n');
      process.exit(1);
    },
  );
