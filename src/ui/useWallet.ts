// Browser-wallet state for the page: which account is the gas wallet and which chain the wallet is on,
// for the provider the user picked (EIP-6963, src/wallet/eip6963.ts). Follows accountsChanged /
// chainChanged; every send re-checks both again (src/wallet/eip1193.ts).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address } from 'viem';
import { CHAINS } from '../config/chains';
import type { SupportedDeployment } from '../config/registry';
import { chainIdOf, connect, currentAccount, switchChain, WalletError, type Eip1193 } from '../wallet/eip1193';

export interface WalletState {
  provider: Eip1193 | null;
  account: Address | null;
  chainId: number | null;
  busy: boolean;
  error: string | null;
  connect(): Promise<void>;
  switchChain(): Promise<void>;
}

export function useWallet(dep: SupportedDeployment, provider: Eip1193 | null): WalletState {
  const [account, setAccount] = useState<Address | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each read is numbered; only the newest one for the current provider may set state. An answer from
  // a provider the user has since left (or an older read overtaken by a newer one) is dropped.
  const seq = useRef(0);
  const current = useRef(provider);
  current.current = provider;

  const refresh = useCallback(async () => {
    const my = ++seq.current;
    const fresh = () => my === seq.current && current.current === provider;
    if (!provider) {
      setAccount(null);
      setChainId(null);
      return;
    }
    try {
      const a = await currentAccount(provider);
      const c = await chainIdOf(provider);
      if (!fresh()) return;
      setAccount(a);
      setChainId(c);
    } catch {
      if (fresh()) setAccount(null);
    }
  }, [provider]);

  useEffect(() => {
    // A new provider starts from nothing: the previous one's account and chain are not carried over.
    setAccount(null);
    setChainId(null);
    setBusy(false);
    setError(null);
    if (!provider) return;
    void refresh();
    const onChange = () => void refresh();
    provider.on?.('accountsChanged', onChange);
    provider.on?.('chainChanged', onChange);
    return () => {
      seq.current++;
      provider.removeListener?.('accountsChanged', onChange);
      provider.removeListener?.('chainChanged', onChange);
    };
  }, [provider, refresh]);

  const run = async (fn: (p: Eip1193) => Promise<void>) => {
    if (!provider) return;
    setBusy(true);
    setError(null);
    try {
      await fn(provider);
    } catch (e) {
      if (current.current === provider) setError(e instanceof WalletError ? e.message : 'the wallet did not answer');
    } finally {
      if (current.current === provider) {
        setBusy(false);
        await refresh();
      }
    }
  };

  return {
    provider,
    account,
    chainId,
    busy,
    error,
    connect: () => run(async (p) => void (await connect(p))),
    switchChain: () => run((p) => switchChain(p, dep, CHAINS[dep.chainId]!.publicRpc)),
  };
}
