// HOST-01: the local runner's argument parsing (server/runner/runner.ts parseArgs, exported). main() is not
// exercised here: it forks the signer child, starts the sidecar and resolves Anvil.
import { describe, expect, it } from 'vitest';
import { ArgError, DEFAULT_PORT, HELP, OFFICIAL_ORIGINS, parseArgs } from '../../../server/runner/runner';

const argErr = (argv: string[], env = {}) => {
  try {
    parseArgs(argv, env);
    return null;
  } catch (e) {
    return e instanceof ArgError ? e.message : `other:${(e as Error).message}`;
  }
};

describe('parseArgs', () => {
  it('no arguments → defaults: port 4171, signer on port + 1, native signer on, no store override', () => {
    expect(parseArgs([])).toEqual({ port: DEFAULT_PORT, signerPort: DEFAULT_PORT + 1, allowOrigins: [], nativeSigner: true, storeDir: null, storeIsTest: false, gasManifest: null, allowLoopbackHttpOrigin: false, help: false, version: false });
  });

  it('--port moves the signer with it unless --signer-port is given', () => {
    expect(parseArgs(['--port', '5000'])).toMatchObject({ port: 5000, signerPort: 5001 });
    expect(parseArgs(['--port', '5000', '--signer-port', '6000'])).toMatchObject({ port: 5000, signerPort: 6000 });
  });

  it.each([['abc'], ['80'], ['1023'], ['65536'], ['70000'], ['123456'], ['-1'], ['5000.5'], [undefined]])('--port %j → ArgError', (v) => {
    expect(argErr(v === undefined ? ['--port'] : ['--port', v])).toMatch(/--port needs a port number 1024–65535/);
  });

  it('the port bounds 1024 and 65535 are accepted', () => {
    expect(parseArgs(['--port', '1024']).port).toBe(1024);
    expect(parseArgs(['--port', '65534']).signerPort).toBe(65535);
  });

  it('--signer-port equal to --port → ArgError', () => {
    expect(argErr(['--port', '5000', '--signer-port', '5000'])).toMatch(/must differ/);
  });

  // Regression: the derived signer port (port + 1) is range-checked.
  it('--port 65535 never yields an out-of-range signer port', () => {
    let r: ReturnType<typeof parseArgs> | null = null;
    try {
      r = parseArgs(['--port', '65535']);
    } catch (e) {
      expect(e).toBeInstanceOf(ArgError);
    }
    if (r) expect(r.signerPort).toBeLessThanOrEqual(65535);
  });

  it('--allow-origin is repeatable and kept verbatim (validated later by main)', () => {
    expect(parseArgs(['--allow-origin', 'https://a.example', '--allow-origin', 'https://b.example']).allowOrigins).toEqual(['https://a.example', 'https://b.example']);
    expect(parseArgs(['--allow-origin']).allowOrigins).toEqual(['']);
  });

  it('--no-native-signer, --help, -h and --version set their flags', () => {
    expect(parseArgs(['--no-native-signer']).nativeSigner).toBe(false);
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--version']).version).toBe(true);
  });

  it('--gas-manifest takes an absolute path only (the existing gas wallet’s public manifest)', () => {
    expect(parseArgs(['--gas-manifest', '/Users/synthetic/gas-wallet-public.json']).gasManifest).toBe('/Users/synthetic/gas-wallet-public.json');
    expect(() => parseArgs(['--gas-manifest', 'gas-wallet-public.json'])).toThrow(ArgError);
    expect(() => parseArgs(['--gas-manifest'])).toThrow(ArgError);
  });

  it('an unknown option → ArgError quoting at most 40 characters of it', () => {
    const msg = argErr([`--${'x'.repeat(100)}`])!;
    expect(msg).toMatch(/^unknown option "--x+" \(see --help\)$/);
    expect(msg).toContain(`"--${'x'.repeat(38)}"`);
  });

  it('test-only store switches come only from the environment, never from flags', () => {
    expect(argErr(['--store-dir', '/synthetic'])).toMatch(/unknown option/);
    expect(parseArgs([], { CBPR_TEST_STORE_DIR: '/synthetic/store' })).toMatchObject({ storeDir: '/synthetic/store', storeIsTest: true });
  });

  it('CBPR_TEST_ALLOW_LOOPBACK_ORIGIN must be exactly "1"', () => {
    expect(parseArgs([], { CBPR_TEST_ALLOW_LOOPBACK_ORIGIN: '1' }).allowLoopbackHttpOrigin).toBe(true);
    expect(parseArgs([], { CBPR_TEST_ALLOW_LOOPBACK_ORIGIN: 'true' }).allowLoopbackHttpOrigin).toBe(false);
  });

  it('the default env is empty: the caller’s process.env is not consulted', () => {
    const before = process.env.CBPR_TEST_STORE_DIR;
    process.env.CBPR_TEST_STORE_DIR = '/synthetic/leak';
    try {
      expect(parseArgs([]).storeDir).toBeNull();
    } finally {
      if (before === undefined) delete process.env.CBPR_TEST_STORE_DIR;
      else process.env.CBPR_TEST_STORE_DIR = before;
    }
  });

  it('no official website origin is compiled in yet', () => expect(OFFICIAL_ORIGINS).toEqual([]));
});

describe('HELP (NX-04: where and how to run it)', () => {
  it('regression: shows only start commands that work today (tarball npm exec, source npm run runner), never a registry npx entry', () => {
    expect(HELP).toContain('npm exec --yes --package ./passkey-recovery-<version>.tgz -- passkey-recovery');
    expect(HELP).toContain('npm run runner -- [options]');
    expect(HELP).toContain('no published Release or npm registry package yet');
    expect(HELP).not.toMatch(/\bnpx\b/);
    expect(HELP).toContain('this computer only');
  });

  it('regression: the default port is 4171 (the one local preview), the signer 4172, and --help says so', () => {
    expect(DEFAULT_PORT).toBe(4171);
    expect(parseArgs([]).signerPort).toBe(4172);
    expect(HELP).toContain('[--port 4171]');
    expect(HELP).not.toContain('4310');
  });
});
