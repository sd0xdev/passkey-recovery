#!/usr/bin/env node
// Rebuilds the third-party contract bytecode this repository carries from its upstream source and compares it byte by byte.
//   node scripts/release/rebuild-contracts.mjs [--out report.json]
// Needs git, forge (only to export the Coinbase Smart Wallet standard-JSON input) and network access to github.com,
// binaries.soliditylang.org and registry.npmjs.org. Everything is fetched into a fresh temporary directory; every download
// is checked against the pinned hash below before it is used. What the comparison means: THIRD_PARTY_NOTICES.md § Contract bytecode.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const PINS = {
  smartWallet: { repo: 'https://github.com/coinbase/smart-wallet.git', tag: 'v1.1.0', commit: 'a8c6456f3a6d5d2dea08d6336b3be13395cacd42' },
  submodules: {
    'lib/account-abstraction': 'abff2aca61a8f0934e533d0d352978055fddbd96',
    'lib/solady': 'c4c96607cb3aa3807b14c81ae2015bcba061f8fc',
    'lib/webauthn-sol': '619f20ab0f074fef41066ee4ab24849a913263b2',
    'lib/webauthn-sol/lib/FreshCryptoLib': '76f3f135b7b27d2aa519f265b56bfc49a2573ab5',
    'lib/webauthn-sol/lib/openzeppelin-contracts': '5705e8208bc92cd82c7bcdfeac8dbc7377767d96',
  },
  entryPoint: { repo: 'https://github.com/eth-infinitism/account-abstraction.git', tag: 'v0.6.0', commit: 'abff2aca61a8f0934e533d0d352978055fddbd96' },
  // yarn.lock of account-abstraction v0.6.0 resolves @openzeppelin/contracts@^4.2.0 to 4.8.0 with this sha1.
  openzeppelin: { url: 'https://registry.npmjs.org/@openzeppelin/contracts/-/contracts-4.8.0.tgz', sha1: '6854c37df205dd2c056bdfa1b853f5d732109109' },
  solc: {
    '0.8.23': { file: 'soljson-v0.8.23+commit.f704f362.js', sha256: '9c681b165c8647867589c0a5ecdc8692637a935928a2b1bbea2ff4a1f4976985' },
    '0.8.17': { file: 'soljson-v0.8.17+commit.8df45f5f.js', sha256: '617828e63be485c7cc2dbcbdd5a22b582b40fafaa41016ad595637b83c90656c' },
  },
  // Canonical EntryPoint v0.6 SenderCreator, the only immutable in the EntryPoint runtime code.
  senderCreator: '7fc98430eaedbb6070b35b39d798725049088348',
};

const work = mkdtempSync(join(tmpdir(), 'cbpr-rebuild-'));
const run = (cmd, args, cwd = work) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).toString();
const hash = (alg, buf) => createHash(alg).update(buf).digest('hex');
const hex = (s) => Buffer.from(s.replace(/^0x/, ''), 'hex');

async function download(url, alg, expected) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const got = hash(alg, buf);
  if (got !== expected) throw new Error(`${url}: ${alg} ${got} does not match the pinned ${expected}`);
  return buf;
}

async function solc(version) {
  const pin = PINS.solc[version];
  const file = join(work, pin.file);
  writeFileSync(file, await download(`https://binaries.soliditylang.org/bin/${pin.file}`, 'sha256', pin.sha256));
  const soljson = createRequire(import.meta.url)(file);
  const compile = soljson.cwrap('solidity_compile', 'string', ['string', 'number', 'number']);
  return (input) => {
    const out = JSON.parse(compile(JSON.stringify(input), 0, 0));
    const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
    if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
    return out;
  };
}

function clone({ repo, tag, commit }, dir) {
  run('git', ['clone', '-q', '--depth', '1', '--branch', tag, repo, dir]);
  const head = run('git', ['rev-parse', 'HEAD'], dir).trim();
  if (head !== commit) throw new Error(`${repo}@${tag} is ${head}, expected ${commit}`);
  return head;
}

/** Bytes where the CBOR metadata trailer sits (its length is the last two bytes of the code). */
const metadataRange = (code) => {
  const len = code.readUInt16BE(code.length - 2);
  return [code.length - 2 - len, code.length];
};

function compareInitcode(deployed, rebuilt) {
  const executable = metadataRange(rebuilt)[0];
  const ctorArgs = deployed.subarray(rebuilt.length);
  const diff = [];
  for (let i = 0; i < rebuilt.length; i++) if (deployed[i] !== rebuilt[i]) diff.push(i);
  return {
    length: { deployed: deployed.length, rebuilt: rebuilt.length, constructorArgs: ctorArgs.length },
    executableIdentical: deployed.subarray(0, executable).equals(rebuilt.subarray(0, executable)),
    metadataIdentical: deployed.subarray(executable, rebuilt.length).equals(rebuilt.subarray(executable)),
    differingBytesOutsideMetadata: diff.filter((i) => i < executable).length,
    constructorArgs: `0x${ctorArgs.toString('hex')}`,
    rebuiltSha256: hash('sha256', rebuilt),
  };
}

async function smartWallet(report) {
  const dir = join(work, 'smart-wallet');
  report.smartWallet = { source: { ...PINS.smartWallet, verifiedHead: clone(PINS.smartWallet, dir) }, submodules: {} };
  run('git', ['submodule', 'update', '--init', '--recursive', '-q'], dir);
  for (const [path, want] of Object.entries(PINS.submodules)) {
    const got = run('git', ['rev-parse', 'HEAD'], join(dir, path)).trim();
    if (got !== want) throw new Error(`${path} is ${got}, expected ${want}`);
    report.smartWallet.submodules[path] = got;
  }
  const compile = await solc('0.8.23');
  const registry = JSON.parse(readFileSync(join(root, 'registry/coinbase-smart-wallet-v1.1/infra-deployment.json'), 'utf8'));
  const targets = { implementation: 'src/CoinbaseSmartWallet.sol:CoinbaseSmartWallet', factory: 'src/CoinbaseSmartWalletFactory.sol:CoinbaseSmartWalletFactory' };
  for (const [target, id] of Object.entries(targets)) {
    // forge only exports the exact standard-JSON input of the deploy profile; the compiler run is solc itself.
    const input = JSON.parse(run('forge', ['verify-contract', '--show-standard-json-input', '--compiler-version', '0.8.23', '--profile', 'deploy', `0x${'00'.repeat(19)}01`, id], dir));
    input.settings.outputSelection = { '*': { '*': ['evm.bytecode.object'] } };
    const [file, name] = id.split(':');
    const rebuilt = hex(compile(input).contracts[file][name].evm.bytecode.object);
    const step = registry.steps.find((s) => s.target === target);
    const deployed = hex(step.input).subarray(32); // Safe Singleton Factory input: 32-byte salt, then the init code
    report.smartWallet[target] = { settings: { optimizer: input.settings.optimizer, viaIR: input.settings.viaIR, evmVersion: input.settings.evmVersion }, ...compareInitcode(deployed, rebuilt) };
  }
}

async function entryPoint(report) {
  const dir = join(work, 'account-abstraction');
  report.entryPoint = { source: { ...PINS.entryPoint, verifiedHead: clone(PINS.entryPoint, dir) } };
  const ozDir = join(work, 'openzeppelin');
  mkdirSync(ozDir);
  writeFileSync(join(ozDir, 'oz.tgz'), await download(PINS.openzeppelin.url, 'sha1', PINS.openzeppelin.sha1));
  run('tar', ['-xzf', 'oz.tgz'], ozDir);
  const sources = {};
  const load = (name) => {
    if (sources[name]) return;
    const path = name.startsWith('@openzeppelin/contracts/') ? join(ozDir, 'package', name.slice('@openzeppelin/contracts/'.length)) : join(dir, name);
    const content = readFileSync(path, 'utf8');
    sources[name] = { content };
    for (const m of content.matchAll(/^import\s+(?:[^"']*from\s+)?["']([^"']+)["']/gm)) load(m[1].startsWith('.') ? posix.normalize(posix.join(posix.dirname(name), m[1])) : m[1]);
  };
  load('contracts/core/EntryPoint.sol');
  // hardhat.config.ts of v0.6.0: the EntryPoint override compiles with 0.8.17, optimizer 1000000 runs, viaIR.
  const settings = { optimizer: { enabled: true, runs: 1000000 }, viaIR: true, outputSelection: { '*': { '*': ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } };
  const out = (await solc('0.8.17'))({ language: 'Solidity', sources, settings }).contracts['contracts/core/EntryPoint.sol'].EntryPoint.evm.deployedBytecode;
  const rebuilt = hex(out.object);
  const fixture = hex(JSON.parse(readFileSync(join(root, 'test/fixtures/infra-code.json'), 'utf8')).entryPoint);
  const ranges = Object.values(out.immutableReferences).flat();
  const inImmutable = (i) => ranges.some((r) => i >= r.start && i < r.start + r.length);
  const diff = [];
  for (let i = 0; i < Math.max(rebuilt.length, fixture.length); i++) if (rebuilt[i] !== fixture[i]) diff.push(i);
  const values = [...new Set(ranges.map((r) => fixture.subarray(r.start, r.start + r.length).toString('hex')))];
  report.entryPoint.runtime = {
    sources: Object.keys(sources).length,
    length: { fixture: fixture.length, rebuilt: rebuilt.length },
    differingBytesOutsideImmutables: diff.filter((i) => !inImmutable(i)).length,
    immutableValues: values,
    immutableIsCanonicalSenderCreator: values.length === 1 && values[0] === PINS.senderCreator.padStart(64, '0'),
    fixtureSha256: hash('sha256', fixture),
  };
}

const report = { generatedAt: new Date().toISOString(), tool: 'scripts/release/rebuild-contracts.mjs' };
let failed = false;
try {
  await smartWallet(report);
  await entryPoint(report);
  const sw = report.smartWallet;
  const ep = report.entryPoint.runtime;
  failed = !(sw.implementation.executableIdentical && sw.factory.executableIdentical && ep.differingBytesOutsideImmutables === 0 && ep.length.fixture === ep.length.rebuilt && ep.immutableIsCanonicalSenderCreator);
  report.result = failed ? 'mismatch' : 'match';
} catch (e) {
  failed = true;
  report.result = 'error';
  report.error = String(e instanceof Error ? e.message : e);
} finally {
  rmSync(work, { recursive: true, force: true });
}
const outIdx = process.argv.indexOf('--out');
const text = `${JSON.stringify(report, null, 2)}\n`;
if (outIdx > 0) {
  mkdirSync(dirname(resolve(process.argv[outIdx + 1])), { recursive: true });
  writeFileSync(process.argv[outIdx + 1], text);
}
process.stdout.write(text);
process.exit(failed ? 1 : 0);
