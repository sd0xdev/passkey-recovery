// Loopback sidecar entry (tech spec §4): serves the built UI and the narrow /api + /signer routes on
// 127.0.0.1 only. Request bodies are never logged; errors return fixed messages; no write RPC exists here.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, resolve } from 'node:path';
import { type Address, type Hex } from 'viem';
import { CHAINS } from '../src/config/chains';
import { SUPPORTED } from '../src/config/registry';
import { parseAddress } from '../src/transfer/intent';
import { loadInfraSteps, RegistryError } from './bytecodeRegistry';
import { upstreamFromEnv } from './config';
import { planDeploy, deploySteps, verifyDeployStep } from './deploy';
import { diagnose, type KnownAccount } from './diagnose';
import { ForkManager } from './fork';
import { startForkProxy } from './forkProxy';
import { checkApi, checkHost, checkSigner, contentSecurityPolicy, corsHeaders, HttpError, MAX_BODY_BYTES, MAX_RELAY_BODY_BYTES, preflight, readJson, RELAY_ROUTES, SECURITY_HEADERS, sendJson, type Caller, type GuardConfig } from './http';
import { DeployRelay } from './deployRelay';
import { PairingError, RUNNER_PROTOCOL, type Pairing } from './pairing';
import { relayRaw, type NativeSign } from './relay';
import { snapshotDist } from './staticSnapshot';
import { classifyStatic, isDocumentNavigation, safePath } from './staticRoute';
import { NetGuardError } from './net/guard';
import { Reader } from './reader';
import { anvilForkCheck, RpcRegistry } from './rpc/registry';
import { track } from './track';
import { TransferService } from './transfer';
import { UpstreamError } from './upstream';
import { ForkError } from './fork';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' };

export interface SidecarOptions {
  port: number;
  root: string;
  dist: string;
  anvilBin: string;
  /** Website pairing (local runner only). Absent → same-origin only. */
  pairing?: Pairing;
  /** The runner's native signer, reached over IPC; it signs only transactions this sidecar issued. */
  nativeSigner?: NativeSign;
  /** Where the UI reaches the native signer's own secret-bearing endpoints (loopback), if running. */
  nativeSignerUrl?: string;
  version?: string;
}

export async function startSidecar(opts: SidecarOptions) {
  let proxyPort = 0;
  const base = upstreamFromEnv(process.env, [opts.port]);
  const mode = base.info.source === 'testchain' ? 'testchain' : 'mainnet';
  // Mainnet: chain identity is the registry's pinned genesis. Testchain: learned from the base endpoint.
  const dep = SUPPORTED[0]!;
  const expectedGenesis = mode === 'mainnet' ? CHAINS[dep.chainId]!.genesisHash : null;
  const up = new RpcRegistry(base, { expectedGenesis, forkCheck: anvilForkCheck(opts.anvilBin), denyLoopbackPorts: () => [opts.port, proxyPort] });
  const proxy = await startForkProxy(up);
  proxyPort = Number(new URL(proxy.url).port);
  const forks = new ForkManager({ anvilBin: opts.anvilBin, upstreamProxyUrl: proxy.url, hardfork: 'prague' });
  const reader = new Reader(up, { expectedGenesis, deployment: dep });
  const infra = loadInfraSteps(dep, opts.root);
  // Diagnosed accounts (owners verified on chain or by derivation evidence): sidecar memory only.
  const accounts = new Map<Address, KnownAccount>();
  const transfers = new TransferService(reader, forks, infra, accounts);
  transfers.bindRpc(up);
  const relay = (raw: Hex) => relayRaw(up, raw);
  transfers.bindRelay(relay);
  transfers.bindNativeSigner(opts.nativeSigner ?? null);
  const deployRelay = new DeployRelay(reader, relay, opts.nativeSigner ?? null);
  up.onSwitch(() => deployRelay.voidAll());
  const known = (b: Record<string, unknown>) => {
    let a: Address;
    try {
      a = parseAddress(b.account, 'account');
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const k = accounts.get(a);
    if (!k) throw new HttpError(409, 'diagnose this account first');
    return k;
  };
  const optGasWallet = (b: Record<string, unknown>) => {
    if (b.gasWallet === undefined || b.gasWallet === null) return null;
    try {
      return parseAddress(b.gasWallet, 'gas wallet');
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  };
  const cfg: GuardConfig = { host: `127.0.0.1:${opts.port}`, sessionToken: randomBytes(24).toString('base64url'), ...(opts.pairing ? { pairing: opts.pairing } : {}) };
  const version = opts.version ?? '0.0.0';
  const capabilities = { nativeSigner: !!opts.nativeSigner, relay: true, pairing: !!opts.pairing };
  const ui = snapshotDist(resolve(opts.dist));
  // The runner's page may also reach its native signer (an exact loopback origin); nothing else is added.
  const pageCsp = contentSecurityPolicy(opts.nativeSignerUrl ? [opts.nativeSignerUrl] : []);

  const api: Record<string, (b: Record<string, unknown>, caller: Caller) => unknown> = {
    '/api/config': () => ({ mode, upstream: up.info, rpcUrlFile: process.env.CBPR_RPC_URL_FILE ? 'set' : null, port: opts.port, maxSignatureBytes: transfers.maxSigBytes, deployment: dep, runner: { protocol: RUNNER_PROTOCOL, version, capabilities, nativeSignerUrl: opts.nativeSignerUrl ?? null } }),
    // Gas payer (GAS-04): a change of mode, provider, account, item, field or File key voids every plan.
    '/api/gas/changed': (b) => ({ ...transfers.payerChanged(b), deployIssuesVoided: deployRelay.voidAll() }),
    '/api/transfer/relay': (b) => transfers.relaySigned(b),
    '/api/transfer/signer-aborted': (b) => transfers.signerAborted(b),
    '/api/deploy/issue': async (b) => {
      const k = known(b);
      const step = deploySteps(dep, infra, k).find((s) => s.key === b.key);
      if (!step) throw new HttpError(400, 'unknown deployment step');
      const from = optGasWallet(b);
      if (!from) throw new HttpError(400, 'gasWallet required');
      return deployRelay.issue(step, k.address, from, b);
    },
    '/api/deploy/send': (b) => deployRelay.send(b),
    '/api/deploy/abort': (b) => deployRelay.abort(b),
    // RPC settings (M1). URL bodies are never logged or echoed; responses carry the masked form only.
    '/api/rpc/state': () => up.state(),
    '/api/rpc/test': (b) => up.test(b),
    '/api/rpc/use': (b) => up.use(b),
    '/api/rpc/clear': () => up.clear(),
    '/api/rpc/probe': () => up.probeActive(),
    '/api/diagnose': async (b) => {
      const r = await diagnose(reader, forks, infra, b);
      if (r.known) accounts.set(r.known.address, r.known);
      else accounts.delete(r.diagnosis.account);
      return r.diagnosis;
    },
    '/api/deploy/plan': (b) => planDeploy(reader, forks, infra, known(b), optGasWallet(b)),
    '/api/deploy/track': async (b) => {
      const k = known(b);
      const step = deploySteps(dep, infra, k).find((s) => s.key === b.key);
      if (!step) throw new HttpError(400, 'unknown deployment step');
      const from = optGasWallet(b);
      if (!from) throw new HttpError(400, 'gasWallet required');
      if (typeof b.txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.txHash)) throw new HttpError(400, 'txHash must be 0x + 64 hex');
      return verifyDeployStep(reader, step, from, b.txHash.toLowerCase() as Hex);
    },
    '/api/transfer/preview': (b) => transfers.preview(b),
    '/api/transfer/signature': (b) => transfers.submitSignature(b),
    '/api/transfer/resimulate': (b) => transfers.resimulate(b),
    '/api/transfer/send-request': (b) => transfers.sendRequest(b),
    '/api/transfer/wallet-result': (b) => transfers.walletResult(b),
    '/api/transfer/discard': (b) => transfers.discard(b),
    '/api/transfer/handoff': (b) => transfers.handoff(b),
    '/api/track': (b) => track(reader, b),
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    // Only what was built when this process started: a rebuild on disk never mixes into a running runner.
    const route = classifyStatic(req.url ?? '/', req.headers, (rel) => ui.has(rel));
    if (route.kind === 'bad') throw new HttpError(400, 'bad path');
    const headers: Record<string, string> = { ...SECURITY_HEADERS, 'Content-Security-Policy': pageCsp };
    // A browser prefetch / prerender is not a page load: no RPC reset, no session, nothing a later activation
    // could reuse — the real navigation fetches the document again.
    if (route.kind === 'speculative') return void res.writeHead(503, { ...headers, 'cache-control': 'no-store' }).end();
    const html = route.kind === 'page' ? 'index.html' : route.kind === 'notFoundPage' ? '404.html' : null;
    if (html) {
      const snap = ui.get(html);
      if (!snap) throw new HttpError(404, 'not found');
      // A document load starts a new UI session: a custom RPC typed into the previous page is dropped. Only a
      // top-level document navigation: a script's fetch of a page path is not a page load and resets nothing.
      if (req.method === 'GET' && isDocumentNavigation(req.headers)) up.clear('page-load');
      // Only the tool's page carries the session; the 404 page is a plain document with plain links.
      const body = html === 'index.html' ? snap.toString('utf8').replace('</head>', `<meta name="cbpr-session" content="${cfg.sessionToken}" />\n<meta name="cbpr-mode" content="${mode}" />\n</head>`) : snap;
      res.writeHead(html === 'index.html' ? 200 : 404, { ...headers, 'content-type': TYPES['.html']!, 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (route.kind !== 'file') throw new HttpError(404, 'not found');
    res.writeHead(200, { ...headers, 'content-type': TYPES[extname(route.rel)] ?? 'application/octet-stream' }).end(req.method === 'HEAD' ? undefined : ui.get(route.rel));
  };

  const server = createServer((req, res) => {
    let cors: Record<string, string> = {};
    void (async () => {
      try {
        // The raw path is checked before anything routes on it: `new URL()` folds `/%2e%2e/api/x` into `/api/x`.
        if (safePath(req.url ?? '/') === null) throw new HttpError(400, 'bad path');
        const path = new URL(req.url ?? '/', 'http://x').pathname;
        // Error answers to an allowlisted website carry CORS too, so the page can show the reason.
        if (opts.pairing?.isAllowed(req.headers.origin)) cors = corsHeaders(req.headers.origin);
        if (path.startsWith('/api/') && req.method === 'OPTIONS') {
          preflight(req, res, cfg);
        } else if (path === '/api/hello' || path === '/api/pair') {
          // Version / capability check and the pairing exchange: the only routes a not-yet-paired website reaches.
          const caller = checkApi(req, cfg, { pairing: 'exchange' });
          const b = await readJson(req);
          const hello = { protocol: RUNNER_PROTOCOL, version, capabilities, mode };
          if (path === '/api/hello') return sendJson(res, 200, hello, cors);
          if (caller.kind !== 'paired') throw new HttpError(400, 'the local page needs no pairing');
          const r = opts.pairing!.pair(caller.origin, b.code);
          // A new website session starts clean, like a page load of the local UI.
          up.clear('page-load');
          return sendJson(res, 200, { ...hello, token: r.token, expiresAt: r.expiresAt }, cors);
        } else if (path.startsWith('/api/')) {
          const caller = checkApi(req, cfg);
          const h = api[path];
          if (!h) throw new HttpError(404, 'unknown endpoint');
          sendJson(res, 200, await h(await readJson(req, RELAY_ROUTES.has(path) ? MAX_RELAY_BODY_BYTES : MAX_BODY_BYTES), caller), cors);
        } else if (path.startsWith('/signer/')) {
          checkSigner(req, cfg);
          if (path !== '/signer/claim') throw new HttpError(404, 'unknown endpoint');
          sendJson(res, 200, transfers.claim(await readJson(req)));
        } else {
          checkHost(req, cfg);
          serveStatic(req, res);
        }
      } catch (e) {
        if (e instanceof PairingError) return sendJson(res, e.status, { error: e.message, kind: 'pairing' }, cors);
        if (e instanceof HttpError) return sendJson(res, e.status, e.kind ? { error: e.message, kind: e.kind } : { error: e.message }, cors);
        if (e instanceof NetGuardError) return sendJson(res, 400, { error: e.message }, cors);
        if (e instanceof UpstreamError) return sendJson(res, e.kind === 'rate-limited' ? 429 : e.kind === 'chain-mismatch' ? 409 : 502, { error: `upstream: ${e.message}`, kind: e.kind }, cors);
        if (e instanceof ForkError) return sendJson(res, 502, { error: `fork simulation: ${up.redactError(e.message)}` }, cors);
        if (e instanceof RegistryError) return sendJson(res, 500, { error: `bytecode registry: ${e.message}` }, cors);
        sendJson(res, 500, { error: 'internal error' }, cors);
      }
    })();
  });
  // A busy port must reach the caller as a rejection (the runner then stops its children); an unhandled 'error' crashed it.
  await new Promise<void>((r, j) => {
    server.once('error', j);
    server.listen(opts.port, '127.0.0.1', () => (server.off('error', j), r()));
  });
  return {
    cfg,
    transfers,
    accounts,
    mode,
    rpc: up,
    deployRelay,
    forks,
    close: async () => {
      // Stopping does not wait for the browser: a tab kept open holds keep-alive (or still-open) connections that
      // would keep server.close() waiting forever, so the runner never stopped. They are cut once no new ones come.
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections();
      await closed;
      await proxy.close();
    },
  };
}

const isMain = process.argv[1] !== undefined && /sidecar\.(m?js|ts)$/.test(process.argv[1]);
if (isMain) {
  const port = Number(process.env.CBPR_PORT ?? 4173);
  startSidecar({ port, root: process.cwd(), dist: process.env.CBPR_DIST ?? 'dist', anvilBin: process.env.CBPR_ANVIL ?? 'anvil' }).then(
    (s) => process.stdout.write(`cbpr sidecar listening on http://127.0.0.1:${port}/ (mode ${s.mode})\n`),
    (e: unknown) => {
      process.stderr.write(`cbpr sidecar failed to start: ${e instanceof Error ? e.name + ': ' + e.message : 'error'}\n`);
      process.exit(1);
    },
  );
}
