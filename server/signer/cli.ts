// Terminal entry for the optional local gas-wallet signer (tech spec §5, M3 advanced path). Run by the
// user in their own Terminal: `npm run signer -- <status|deploy|send>`. deploy/send are interactive
// only — they refuse without a TTY, have no --yes flag, and print no secret. Errors are reduced to
// name + message (no stacks, no URL). `withdraw` is kept as an alias of `send`.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { CHAINS } from '../../src/config/chains';
import { SUPPORTED } from '../../src/config/registry';
import type { Address } from 'viem';
import { formatUnits, parseAddress } from '../../src/transfer/intent';
import { loadInfraSteps } from '../bytecodeRegistry';
import { upstreamFromEnv } from '../config';
import { ForkManager } from '../fork';
import { startForkProxy } from '../forkProxy';
import { Reader } from '../reader';
import { deploymentVerdict } from '../state';
import { loadManifest, runDeploy, runSend, type Io } from './core';
import { realOp } from './op';

const USAGE = `Usage: npm run signer -- <status|deploy|send> [options]
  status  --account <0x…>                  read-only: deployment state, balances, gas wallet
  deploy  --account <0x…> [--evidence f]   one deployment step per run, typed confirmation
  send                                     type the browser's one-time hand-off code, check, simulate, confirm, send one transfer
Options: --manifest <path> (gas wallet public manifest)  --sidecar-port 4173`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : undefined;
}

async function main(): Promise<number> {
  const raw = process.argv[2];
  const cmd = raw === 'withdraw' ? 'send' : raw;
  if (!cmd || !['status', 'deploy', 'send'].includes(cmd)) {
    process.stdout.write(USAGE + '\n');
    return 2;
  }
  if (process.argv.some((a) => /^--?(y|yes|force|non-interactive)$/.test(a))) {
    process.stdout.write('This tool has no automatic confirmation option.\n');
    return 2;
  }
  const dep = SUPPORTED[0]!;
  const up = upstreamFromEnv();
  const testchain = up.info.source === 'testchain';
  const reader = new Reader(up, { expectedGenesis: testchain ? null : CHAINS[dep.chainId]!.genesisHash, deployment: dep });
  const manifest = loadManifest(arg('--manifest') ?? join(homedir(), '.local/share/passkey-recovery/gas-wallet-public.json'), dep.chainId);
  const fmt = (v: bigint | null | undefined, d: number) => (v === null || v === undefined ? '?' : formatUnits(v, d));
  process.stdout.write(`RPC: ${up.info.provider} (${up.info.source}) · gas wallet ${manifest.address}\n`);
  const account = arg('--account');
  if (cmd === 'status') {
    if (!account) throw new Error('--account is required');
    const s = await reader.snapshot(parseAddress(account, 'account'), { gasWallet: manifest.address });
    const v = deploymentVerdict(dep, s);
    process.stdout.write(`${dep.chainName} chainId ${s.chainId} · block ${s.block}\n`);
    process.stdout.write(`deployment: implementation ${v.targets.implementation} · factory ${v.targets.factory} · account ${v.targets.account} · ${v.complete ? 'verified' : 'not complete'}${v.stops.length ? ' · stop: ' + v.stops.map((x) => x.detail).join('; ') : ''}\n`);
    for (const a of dep.assets) process.stdout.write(`  ${a.symbol.padEnd(8)} ${fmt(a.native ? s.balances.native : s.balances.tokens[a.id as Address], a.decimals)}\n`);
    process.stdout.write(`  EntryPoint deposit ${formatUnits(s.deposit, 18)} · UserOp nonce ${s.nonce}\n`);
    process.stdout.write(`gas wallet ${formatUnits(s.gasWallet!.balance, 18)} · tx nonce ${s.gasWallet!.nonce}\n`);
    return 0;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write('deploy/send only run in an interactive Terminal (each transaction needs a typed confirmation).\n');
    return 2;
  }
  if (up.info.source !== 'file' && !testchain) {
    process.stdout.write('Set CBPR_RPC_URL_FILE to the file holding your RPC URL (sending uses only your own endpoint).\n');
    return 2;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: Io = { print: (l) => process.stdout.write(l + '\n'), ask: (q) => rl.question(q) };
  const proxy = await startForkProxy(up);
  const forks = new ForkManager({ anvilBin: process.env.CBPR_ANVIL ?? 'anvil', upstreamProxyUrl: proxy.url, hardfork: 'prague' });
  const port = Number(arg('--sidecar-port') ?? '4173');
  const claim = async (code: string) => {
    const r = await fetch(`http://127.0.0.1:${port}/signer/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cbpr-signer': '1' }, body: JSON.stringify({ code }) });
    const j = (await r.json()) as { error?: string };
    if (!r.ok) throw new Error(`sidecar: ${j.error ?? r.status}`);
    return j;
  };
  try {
    const deps = { up, reader, forks, infra: loadInfraSteps(dep, process.cwd()), op: realOp(), io, manifest, claim };
    if (cmd === 'deploy') {
      if (!account) throw new Error('--account is required');
      const evPath = arg('--evidence');
      const evidence = evPath ? (JSON.parse(readFileSync(evPath, 'utf8')) as Record<string, unknown>) : undefined;
      await runDeploy(deps, parseAddress(account, 'account'), evidence);
    } else await runSend(deps);
    return 0;
  } finally {
    rl.close();
    await proxy.close();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stdout.write(`Stopped: ${e instanceof Error ? `${e.name}: ${e.message}` : 'error'}\n`);
    process.exit(1);
  },
);
