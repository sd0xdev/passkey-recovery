// Offline SYNTHETIC testchain: a plain anvil (no fork, no network) with chainId 9745 and the Prague
// hardfork (no P256 precompile, like Plasma). Only the two infrastructure contracts that already exist
// on Plasma (EntryPoint v0.6, Safe Singleton Factory) are installed from a hash-pinned fixture; the
// wallet, implementation and factory are deployed for real through the evidence transactions.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { SUPPORTED } from '../../src/config/registry';

const DEP = SUPPORTED[0]!;
const ENTRY_POINT_V06 = DEP.entryPoint;
const SAFE_SINGLETON_FACTORY = DEP.singletonFactory;
const INFRA_CODE_HASH = { entryPoint: DEP.codeHash.entryPoint, singleton: DEP.codeHash.singletonFactory };

export interface Testchain {
  url: string;
  rpc<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  setBalance(a: Address, wei: bigint): Promise<void>;
  setCode(a: Address, code: Hex): Promise<void>;
  stop(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

export function infraCode(): { entryPoint: Hex; singleton: Hex } {
  const j = JSON.parse(readFileSync('test/fixtures/infra-code.json', 'utf8')) as { entryPoint: Hex; singleton: Hex };
  if (keccak256(j.entryPoint) !== INFRA_CODE_HASH.entryPoint || keccak256(j.singleton) !== INFRA_CODE_HASH.singleton) throw new Error('infra-code fixture hash mismatch');
  return j;
}

/** `extraArgs` lets a test start a second, distinguishable chain (e.g. another genesis timestamp). */
export async function startTestchain(port?: number, extraArgs: readonly string[] = []): Promise<Testchain> {
  const p = port ?? (await freePort());
  const proc: ChildProcess = spawn('anvil', ['--chain-id', '9745', '--hardfork', 'prague', '--host', '127.0.0.1', '--port', String(p), '--accounts', '1', '--silent', '--base-fee', '8', ...extraArgs], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${p}/`;
  let id = 0;
  const rpc = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const b = (await r.json()) as { result?: T; error?: { message: string } };
    if (b.error) throw new Error(b.error.message);
    return b.result as T;
  };
  for (let i = 0; ; i++) {
    try {
      await rpc('eth_chainId');
      break;
    } catch {
      if (i > 100) throw new Error('testchain did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const tc: Testchain = {
    url,
    rpc,
    setBalance: async (a, wei) => void (await rpc('anvil_setBalance', [a, toHex(wei)])),
    setCode: async (a, code) => void (await rpc('anvil_setCode', [a, code])),
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill('SIGTERM');
      }),
  };
  const infra = infraCode();
  await tc.setCode(ENTRY_POINT_V06, infra.entryPoint);
  await tc.setCode(SAFE_SINGLETON_FACTORY, infra.singleton);
  return tc;
}

/** Sends deployment steps (registry infra, createAccount) from anvil's own dev account (test setup only). */
export async function deployEvidence(tc: Testchain, steps: Array<{ key: string; to: Address; data: Hex }>): Promise<void> {
  const [dev] = await tc.rpc<Address[]>('eth_accounts');
  for (const s of steps) {
    const hash = await tc.rpc<Hex>('eth_sendTransaction', [{ from: dev, to: s.to, data: s.data, gas: '0x5b8d80' }]);
    let r: { status: Hex } | null = null;
    for (let i = 0; i < 100 && !r; i++) {
      r = await tc.rpc<{ status: Hex } | null>('eth_getTransactionReceipt', [hash]);
      if (!r) await new Promise((ok) => setTimeout(ok, 100));
    }
    if (r?.status !== '0x1') throw new Error(`testchain deploy step ${s.key} failed (status ${r?.status ?? 'none'})`);
  }
}
