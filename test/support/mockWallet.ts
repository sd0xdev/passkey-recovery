// SYNTHETIC injected EIP-1193 wallet for the browser e2e. `window.ethereum.request` forwards to the
// test (page.exposeFunction), which answers account/chain questions itself and passes
// eth_sendTransaction to the offline anvil, where anvil's own unlocked dev account signs it — standing in
// for the user's wallet confirming the transaction. The test can make the next send be rejected (4001),
// be sent and then answer with an error (no hash), or be sent and never answer (hold, for a reload
// mid-step), to drive the interruption paths. No real wallet,
// no real key, no network.
import type { Page } from '@playwright/test';
import type { E2eWorld } from './e2e-constants';

export type NextSend = 'ok' | 'reject' | 'no-hash' | 'hold' | 'defer';

export interface MockWallet {
  /** What the next eth_sendTransaction does (then resets to 'ok'). */
  next(mode: NextSend): void;
  /** Every method the page asked for, in order. */
  calls: string[];
  /** Transactions actually broadcast to the testchain. */
  sent: Array<{ to: string; data: string; hash: string }>;
  /**
   * Holds eth_chainId answers (the send's pre-flight check) until the returned function is called: every
   * one by default; with `once`, only the next one — later checks (a newer attempt) answer at once.
   */
  holdChainId(opts?: { once?: boolean }): () => void;
  /**
   * Each 'defer' send waits, broadcasting nothing, until the test answers it (oldest first): 'reject'
   * answers 4001, as if the user declined it in the wallet long after it was asked.
   */
  answerDeferred(how: 'reject'): void;
  /** How many deferred sends are still waiting for an answer. */
  deferred(): number;
  /** Switches the wallet's account and tells the page (accountsChanged). */
  switchAccount(account: string): Promise<void>;
  /** Puts the wallet on another chain (hex id), or back on the testchain (null), and tells the page (chainChanged). */
  setChain(chainId: string | null): Promise<void>;
}

async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = (await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()) as { result?: T; error?: { message: string } };
  if (r.error) throw new Error(r.error.message);
  return r.result as T;
}

/**
 * `announce`: the same provider is also announced over EIP-6963 under this identity (rdns / name), the
 * way OKX Wallet announces itself, so the page lists it and the user picks it explicitly.
 */
export async function installMockWallet(page: Page, world: E2eWorld, opts: { connected?: boolean; announce?: { rdns: string; name: string } } = {}): Promise<MockWallet> {
  let mode: NextSend = 'ok';
  let authorized = opts.connected ?? false;
  let chainHold: Promise<void> | null = null;
  let holdOnce = false;
  let account = world.gasWallet.toLowerCase();
  let chainOverride: string | null = null;
  const waiting: Array<(answer: string) => void> = [];
  const w: MockWallet = {
    next: (m) => void (mode = m),
    calls: [],
    sent: [],
    answerDeferred: (how) => {
      const next = waiting.shift();
      if (!next) throw new Error('no deferred send is waiting');
      if (how === 'reject') next(JSON.stringify({ error: { code: 4001, message: 'User rejected the request.' } }));
    },
    deferred: () => waiting.length,
    switchAccount: async (a) => {
      account = a.toLowerCase();
      await page.evaluate((acc) => (window as unknown as { __cbprEmit: (e: string, p: unknown) => void }).__cbprEmit('accountsChanged', [acc]), account);
    },
    setChain: async (c) => {
      chainOverride = c;
      const now = c ?? (await rpc<string>(world.rpc, 'eth_chainId'));
      await page.evaluate((id) => (window as unknown as { __cbprEmit: (e: string, p: unknown) => void }).__cbprEmit('chainChanged', id), now);
    },
    holdChainId: (opts = {}) => {
      let release!: () => void;
      chainHold = new Promise<void>((r) => (release = r));
      holdOnce = opts.once ?? false;
      return () => {
        chainHold = null;
        release();
      };
    },
  };
  await page.exposeFunction('__cbprWalletRequest', async (json: string): Promise<string> => {
    const { method, params = [] } = JSON.parse(json) as { method: string; params?: unknown[] };
    w.calls.push(method);
    const ok = (result: unknown) => JSON.stringify({ result });
    const err = (code: number, message: string) => JSON.stringify({ error: { code, message } });
    switch (method) {
      case 'eth_requestAccounts':
        authorized = true;
        return ok([account]);
      case 'eth_accounts':
        return ok(authorized ? [account] : []);
      case 'eth_chainId':
        if (chainHold) {
          const held = chainHold;
          if (holdOnce) chainHold = null;
          await held;
        }
        return ok(chainOverride ?? (await rpc<string>(world.rpc, 'eth_chainId')));
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        return ok(null);
      case 'eth_sendTransaction': {
        const m = mode;
        mode = 'ok';
        if (m === 'reject') return err(4001, 'User rejected the request.');
        if (m === 'defer') return new Promise<string>((r) => waiting.push(r));
        const tx = (params as Array<Record<string, string>>)[0]!;
        const hash = await rpc<string>(world.rpc, 'eth_sendTransaction', [tx]);
        for (let i = 0; i < 200 && !(await rpc<unknown>(world.rpc, 'eth_getTransactionReceipt', [hash])); i++) await new Promise((r) => setTimeout(r, 25));
        w.sent.push({ to: tx.to!, data: tx.data!, hash });
        if (m === 'no-hash') return err(-32603, 'Request timed out');
        // Broadcast, then never answer (the page is reloaded while the wallet is still "open").
        if (m === 'hold') return new Promise<string>(() => {});
        return ok(hash);
      }
      default:
        return err(4200, `unsupported in the mock: ${method}`);
    }
  });
  await page.addInitScript((announce) => {
    const call = (window as unknown as { __cbprWalletRequest: (j: string) => Promise<string> }).__cbprWalletRequest;
    const listeners: Record<string, Array<(p: unknown) => void>> = {};
    (window as unknown as { __cbprEmit: (e: string, p: unknown) => void }).__cbprEmit = (e, p) => (listeners[e] ?? []).forEach((f) => f(p));
    const provider = {
      isMockE2e: true,
      async request(a: { method: string; params?: unknown[] }) {
        const r = JSON.parse(await call(JSON.stringify(a))) as { result?: unknown; error?: { code: number; message: string } };
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return r.result;
      },
      on(e: string, f: (p: unknown) => void) {
        (listeners[e] ??= []).push(f);
      },
      removeListener(e: string, f: (p: unknown) => void) {
        listeners[e] = (listeners[e] ?? []).filter((x) => x !== f);
      },
    };
    (window as unknown as { ethereum: unknown }).ethereum = provider;
    if (announce) {
      const info = Object.freeze({ uuid: 'b6f1a1de-0000-4000-8000-0000000000e2', name: announce.name, icon: 'data:image/svg+xml,<svg/>', rdns: announce.rdns });
      const say = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
      window.addEventListener('eip6963:requestProvider', say);
      say();
    }
  }, opts.announce ?? null);
  return w;
}
