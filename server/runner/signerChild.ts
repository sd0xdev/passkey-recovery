// Child-process entry of the native signer (started by runner.ts with an IPC channel, never by a user).
// The parent sends one `init`; afterwards it sends `sign` requests and answers `auth` questions. The
// child's only network surface is its loopback HTTP server (signerService.ts).
import type { Hex } from 'viem';
import type { IssuedTx } from '../relay';
import { defaultManifestPath } from './gasManifest';
import { realOpRunner } from './op1p';
import { createSignerService } from './signerService';
import { defaultStoreDir, KeystoreStore, StoreError } from './store';

interface Init {
  t: 'init';
  port: number;
  allowedOrigins: string[];
  storeDir: string | null;
  storeIsTest: boolean;
  gasManifest: string | null;
  chainId: number;
  opBin: string | null;
  kdfN: number | null;
}
type ParentMsg = Init | { t: 'sign'; id: number; tx: Record<string, string | number> } | { t: 'auth-reply'; id: number; ok: boolean } | { t: 'stop' };

const send = (m: unknown) => process.send?.(m);
let authSeq = 0;
const pendingAuth = new Map<number, (ok: boolean) => void>();
let service: ReturnType<typeof createSignerService> | null = null;

const tx = (m: Record<string, string | number>): IssuedTx => ({
  chainId: Number(m.chainId),
  from: m.from as `0x${string}`,
  to: m.to as `0x${string}`,
  data: m.data as Hex,
  nonce: BigInt(m.nonce!),
  gas: BigInt(m.gas!),
  maxFeePerGas: BigInt(m.maxFeePerGas!),
  maxPriorityFeePerGas: BigInt(m.maxPriorityFeePerGas!),
});

process.on('message', (raw: unknown) => {
  const m = raw as ParentMsg;
  void (async () => {
    if (m.t === 'init' && !service) {
      let store: KeystoreStore | null = null;
      let storeError: string | null = null;
      try {
        store = new KeystoreStore(m.storeDir ?? defaultStoreDir(), { explicitTest: m.storeIsTest });
      } catch (e) {
        storeError = e instanceof StoreError ? e.message : 'native File storage unavailable';
      }
      service = createSignerService({
        port: m.port,
        allowedOrigins: m.allowedOrigins,
        auth: (origin, session, pair) =>
          new Promise((resolve) => {
            const id = ++authSeq;
            pendingAuth.set(id, resolve);
            send({ t: 'auth', id, origin, session, pair });
            setTimeout(() => pendingAuth.delete(id) && resolve(false), 5000);
          }),
        op: m.opBin ? realOpRunner(m.opBin) : null,
        store,
        manifest: { path: m.gasManifest ?? defaultManifestPath(), chainId: m.chainId },
        onChange: (reason) => send({ t: 'payer-changed', reason }),
        ...(m.kdfN ? { kdf: { n: m.kdfN, r: 8, p: 1 } } : {}),
      });
      try {
        await service.listen();
        send({ t: 'ready', storeDir: store?.dir ?? null, storeError });
      } catch {
        send({ t: 'failed', reason: `signer port ${m.port} is in use` });
      }
    } else if (m.t === 'sign' && service) {
      try {
        send({ t: 'signed', id: m.id, result: await service.sign(tx(m.tx)) });
      } catch {
        send({ t: 'signed', id: m.id, result: { ok: false, reason: 'the signer could not sign this transaction', code: 'sign-failed' } });
      }
    } else if (m.t === 'auth-reply') {
      pendingAuth.get(m.id)?.(m.ok);
      pendingAuth.delete(m.id);
    } else if (m.t === 'stop') {
      await service?.close();
      process.exit(0);
    }
  })();
});
// The parent is gone (crash, kill -9): never outlive it holding a key.
process.on('disconnect', () => {
  void service?.close().finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
});
