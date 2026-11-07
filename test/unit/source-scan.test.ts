// INV-1/4/8 guard: product source never persists data, never sends transactions, never loads remote code.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

function files(dir: string, ext = /\.(ts|tsx|css|html)$/): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p, ext) : ext.test(n) ? [p] : [];
  });
}
const sources = [...files('src'), 'index.html'].map((p) => ({ p, text: readFileSync(p, 'utf8') }));
const serverSources = files('server').map((p) => ({ p, text: readFileSync(p, 'utf8') }));

const FORBIDDEN: [string, RegExp][] = [
  ['Web Storage', /\b(localStorage|sessionStorage)\b/],
  ['IndexedDB', /\bindexedDB\b/],
  ['cookies', /document\.cookie/],
  ['transaction send', /eth_send|sendTransaction|sendUserOperation|wallet_send/],
  ['wallet RPC', /['"]wallet_[A-Za-z]+['"]/],
  ['message signing (RPC method)', /['"](eth_sign\w*|personal_sign)['"]|signTypedData\(/],
  ['remote script/style', /<script[^>]+src=["']https?:|@import\s+url\(["']?https?:|<link[^>]+href=["']https?:/],
  ['dynamic code', /\beval\(|new Function\(/],
  ['URL state', /history\.(push|replace)State|location\.(hash|search)\s*=/],
];

/**
 * M4 relaxation (docs/features/open-source-recovery/2-tech-spec.md § Source-scan exemptions): exactly one
 * module may hold each capability, and inside it only the narrow form named here.
 *  - src/ui/trackingStore.ts — localStorage for public tracking records (keys cbpr.tracking.v1 and cbpr.deploy.v1); never sessionStorage.
 *  - src/wallet/eip1193.ts — eth_sendTransaction of a sidecar-prepared tx, wallet_switchEthereumChain /
 *    wallet_addEthereumChain; never raw broadcast, UserOperation submission or message signing.
 *  - src/ui/site/router.ts — real path routing (design guidelines §13.3): pushState of a link's own
 *    pathname + search + hash (only after routeForPath accepted the path: a click the browser would have
 *    navigated to anyway), and replaceState of a legacy #/… link onto its fixed page path. Never app state,
 *    never location.hash/search assignment.
 */
const EXEMPT: Record<string, { file: string; only: RegExp }> = {
  'Web Storage': { file: 'src/ui/trackingStore.ts', only: /\blocalStorage\b/ },
  'transaction send': { file: 'src/wallet/eip1193.ts', only: /['"]eth_sendTransaction['"]/ },
  'wallet RPC': { file: 'src/wallet/eip1193.ts', only: /['"]wallet_(switchEthereumChain|addEthereumChain)['"]/ },
  'URL state': { file: 'src/ui/site/router.ts', only: /history\.pushState\(null, '', url\.pathname \+ url\.search \+ url\.hash\)|history\.replaceState\(history\.state, '', path \+ location\.search\)/ },
};

/** Files violating `name`: any match outside the exempt file, or a match in it beyond the allowed form. */
function violations(name: string, re: RegExp, list: Array<{ p: string; text: string }>): string[] {
  const ex = EXEMPT[name];
  const g = new RegExp(re.source, 'g');
  return list
    .filter((s) => {
      const matches = [...s.text.matchAll(g)];
      if (!matches.length) return false;
      if (!ex || s.p.replace(/\\/g, '/') !== ex.file) return true;
      // Inside the exempt file every match must sit inside the allowed form.
      const allowed = [...s.text.matchAll(new RegExp(ex.only.source, 'g'))].map((m) => [m.index!, m.index! + m[0].length] as const);
      return matches.some((m) => !allowed.some(([a, b]) => m.index! >= a && m.index! < b));
    })
    .map((s) => s.p);
}

describe('source scan', () => {
  it('found product sources', () => expect(sources.length).toBeGreaterThan(10));

  it.each(FORBIDDEN)('no %s in src/ or index.html (outside its one exempt module)', (name, re) => {
    expect(violations(name, re, sources)).toEqual([]);
  });

  it('each exemption is used by its module (a stale exemption fails)', () => {
    for (const [name, ex] of Object.entries(EXEMPT)) {
      const text = sources.find((s) => s.p.replace(/\\/g, '/') === ex.file)?.text ?? '';
      expect(ex.only.test(text), name).toBe(true);
    }
  });

  it('URL state exemption, both directions: the router’s two fixed forms pass; any other URL write in it is caught', () => {
    const re = FORBIDDEN.find(([n]) => n === 'URL state')![1];
    const at = (text: string) => violations('URL state', re, [{ p: 'src/ui/site/router.ts', text }]);
    expect(at("history.pushState(null, '', url.pathname + url.search + url.hash);")).toEqual([]);
    expect(at("history.replaceState(history.state, '', path + location.search);")).toEqual([]);
    expect(at("history.pushState(null, '', '/recover?sig=' + sig);")).toEqual(['src/ui/site/router.ts']);
    expect(at("location.hash = assertion;")).toEqual(['src/ui/site/router.ts']);
    // The same allowed form anywhere else is still a violation.
    expect(violations('URL state', re, [{ p: 'src/ui/Tool.tsx', text: "history.pushState(null, '', url.pathname + url.search + url.hash);" }])).toEqual(['src/ui/Tool.tsx']);
  });

  it('the tracking store writes its two fixed keys only', () => {
    const text = sources.find((s) => s.p.endsWith('trackingStore.ts'))!.text;
    expect(text).toMatch(/const KEY = 'cbpr\.tracking\.v1';/);
    expect(text).toMatch(/const DEPLOY_KEY = 'cbpr\.deploy\.v1';/);
    // Every write and removal goes through one of the two constants.
    expect(new Set([...text.matchAll(/\.(setItem|removeItem|getItem)\(([^,)]+)/g)].map((m) => m[2]!.trim()))).toEqual(new Set(['KEY', 'DEPLOY_KEY']));
  });

  it('console.* is never used in product code, helper included (authorization data must not reach logs)', () => {
    const hits = sources.filter((s) => /\bconsole\./.test(s.text)).map((s) => s.p);
    expect(hits).toEqual([]);
  });

  it('network origins: the public RPC, the Passkey page, loopback, and plain github.com and sponsor links', () => {
    const urls = new Set(sources.flatMap((s) => s.text.match(/https?:\/\/[a-z0-9.-]+/gi) ?? []));
    const allowed = new Set(['https://rpc.plasma.to', 'https://keys.coinbase.com', 'http://127.0.0.1', 'http://www.w3.org', 'https://github.com', 'https://buy.stripe.com']);
    expect([...urls].filter((u) => !allowed.has(u))).toEqual([]);
    // github.com and the sponsor page are link targets only: never fetched, never a script or style source.
    expect(sources.filter((s) => /fetch\([^)]*(github\.com|stripe\.com)|src=["']https:\/\/(github|buy\.stripe)/.test(s.text)).map((s) => s.p)).toEqual([]);
    // The sponsor origin is one exact URL in one file, so this allowance cannot grow into other Stripe paths or a query.
    const sponsor = sources.flatMap((s) => (s.text.match(/https:\/\/buy\.stripe\.com[^\s'"`]*/g) ?? []).map((u) => `${s.p.replace(/\\/g, '/')} ${u}`));
    expect(sponsor).toEqual(['src/config/release.ts https://buy.stripe.com/8x2eVdfSh6KZ4mf6wm0sU06']);
  });

  // M3-1: the original case's fixed values are gone from product code. Kept here as sha256 digests of the
  // lowercase hex (the values themselves stay out of the public tree): its wallets, its withdrawal
  // recipient and its owner[0] public key coordinates.
  const ORIGINAL_CASE = new Set([
    '2775dfd999164dfdc66ae008df563c594c1fa7c5b2a36940192cfae705b98873',
    '92a6374c74ab4fff7ed2b968d91f035babc543ce479c94420554aac8cf4314a5',
    'e6ff238dada976647dc0d5573f2c6c3b25656cbb6e4e67bd38f86c00ca27dbdb',
    '4ee933a9c873a7443e75cdb28312ada3192783da96435e192ef48aeb446a1470',
    'ab4603bd3deb6e6d920f1a33434ea9bdefd0a709168e753ebc380aed33780d48',
  ]);
  /** Every 40- and 64-hex window of every hex run whose digest is an original-case value. */
  const originalHits = (list: Array<{ p: string; text: string }>) =>
    list.flatMap(({ p, text }) =>
      [...text.matchAll(/[0-9a-fA-F]{40,}/g)].flatMap((m) => {
        const run = m[0].toLowerCase();
        const out: string[] = [];
        for (const w of [40, 64]) for (let i = 0; i + w <= run.length; i++) if (ORIGINAL_CASE.has(createHash('sha256').update(run.slice(i, i + w)).digest('hex'))) out.push(p);
        return out;
      }),
    );
  const registryFiles = files('registry', /\.(json|md|ts)$/).map((p) => ({ p, text: readFileSync(p, 'utf8') }));

  it('M3-1: no original-case wallet, recipient or owner key in src/, server/ or registry/', () => {
    expect(originalHits([...sources, ...serverSources, ...registryFiles])).toEqual([]);
  });

  it('M3-1 control: the same scan finds an original-case value embedded in ordinary code', () => {
    // Built from the digest list's preimage test, not the value: a hex run is hashed window by window.
    const probe = 'ab'.repeat(20);
    const digest = createHash('sha256').update(probe).digest('hex');
    ORIGINAL_CASE.add(digest);
    try {
      expect(originalHits([{ p: 'src/x.ts', text: `const W = '0x${probe}';` }])).toEqual(['src/x.ts']);
      expect(originalHits([{ p: 'src/x.ts', text: `const W = '0x${'cd'.repeat(20)}';` }])).toEqual([]);
    } finally {
      ORIGINAL_CASE.delete(digest);
    }
  });

  it('M3-14: product code, registry and tests never read the private research tree', () => {
    const research = ['docs', 'research'].join('/');
    const testFiles = files('test').map((p) => ({ p, text: readFileSync(p, 'utf8') }));
    const hits = [...sources, ...serverSources, ...registryFiles, ...testFiles].filter((s) => s.text.includes(research) || s.text.includes(['plasma', 'investigation'].join('-'))).map((s) => s.p);
    expect(hits).toEqual([]);
  });

  it('the scanner itself catches a forbidden pattern (control)', () => {
    expect(FORBIDDEN[0]![1].test('window.localStorage.setItem("x","y")')).toBe(true);
    expect(FORBIDDEN[3]![1].test('rpc("eth_sendRawTransaction")')).toBe(true);
  });

  it('exemptions are per file and per form (controls, same violations() path)', () => {
    const tx = FORBIDDEN.find(([n]) => n === 'transaction send')![1];
    const ws = FORBIDDEN.find(([n]) => n === 'Web Storage')![1];
    const wr = FORBIDDEN.find(([n]) => n === 'wallet RPC')![1];
    // Allowed: the exact form in the exempt file.
    expect(violations('transaction send', tx, [{ p: 'src/wallet/eip1193.ts', text: "request({ method: 'eth_sendTransaction' })" }])).toEqual([]);
    expect(violations('Web Storage', ws, [{ p: 'src/ui/trackingStore.ts', text: 'localStorage.getItem(KEY)' }])).toEqual([]);
    expect(violations('wallet RPC', wr, [{ p: 'src/wallet/eip1193.ts', text: "'wallet_addEthereumChain'" }])).toEqual([]);
    // Refused: the same form anywhere else, and a wider form inside the exempt file.
    expect(violations('transaction send', tx, [{ p: 'src/ui/App.tsx', text: "'eth_sendTransaction'" }])).toEqual(['src/ui/App.tsx']);
    expect(violations('transaction send', tx, [{ p: 'src/wallet/eip1193.ts', text: "'eth_sendRawTransaction'" }])).toEqual(['src/wallet/eip1193.ts']);
    expect(violations('Web Storage', ws, [{ p: 'src/ui/trackingStore.ts', text: 'sessionStorage.setItem(KEY, v)' }])).toEqual(['src/ui/trackingStore.ts']);
    expect(violations('wallet RPC', wr, [{ p: 'src/wallet/eip1193.ts', text: "'wallet_sendCalls'" }])).toEqual(['src/wallet/eip1193.ts']);
  });
});

/** Static relative imports of a server module, resolved to files (no bundler needed). */
function importGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of readFileSync(f, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
      const base = join(dirname(f), m[1]!);
      const hit = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find((c) => existsSync(c));
      if (hit) walk(hit);
    }
  };
  walk(entry);
  return seen;
}

describe('server source scan (sidecar + signer)', () => {
  const hits = (re: RegExp) => serverSources.filter((s) => re.test(s.text)).map((s) => s.p).sort();
  it('found server sources', () => expect(serverSources.length).toBeGreaterThan(10));
  // Unified product (2026-11-01 request, GAS-02/03): besides the Terminal signer, the runner's relay
  // broadcasts a raw transaction — only after checkSignedTx proved it is the exact one the runner issued.
  it('eth_sendRawTransaction appears only in the Terminal signer broadcast module and the checked relay', () => expect(hits(/eth_sendRawTransaction/)).toEqual(['server/relay.ts', 'server/signer/broadcast.ts']));
  it('the relay broadcasts only bytes checkSignedTx returned', () => {
    const relay = serverSources.find((s) => s.p.replace(/\\/g, '/') === 'server/relay.ts')!.text;
    expect(relay).toMatch(/export async function checkSignedTx\(/);
    expect((relay.match(/eth_sendRawTransaction/g) ?? []).length).toBe(1);
  });
  it('file-system writes live only in the native keystore store (server/runner/store.ts)', () => {
    expect(hits(/\b(writeSync|openSync|linkSync|mkdirSync|renameSync|writeFileSync|chmodSync|appendFileSync|createWriteStream)\b/)).toEqual(['server/runner/store.ts']);
  });
  it('a tracking record is built only by buildTrackRecord (server/track.ts): sidecar and signer cannot drift', () => {
    expect(hits(/format: 'cbpr-track-v1'/)).toEqual(['server/track.ts']);
    expect(hits(/buildTrackRecord\(/)).toEqual(['server/signer/core.ts', 'server/track.ts', 'server/transfer.ts']);
  });
  it('eth_sendTransaction appears only in the local fork client', () => expect(hits(/['"]eth_sendTransaction['"]/)).toEqual(['server/fork.ts']));
  it('no UserOperation submission, no bundler, no persistence, no console', () => {
    expect(hits(/['"]eth_sendUserOperation['"]/)).toEqual([]);
    expect(hits(/\b(writeFile|appendFile|createWriteStream)\w*\(/)).toEqual([]);
    expect(hits(/\bconsole\./)).toEqual([]);
    expect(hits(/\bVITE_/)).toEqual([]);
  });
  it('the sidecar import graph never reaches the broadcaster, the keystore or the password adapter', () => {
    const g = [...importGraph('server/sidecar.ts')].map((p) => p.replace(/\\/g, '/'));
    expect(g).toContain('server/transfer.ts');
    expect(g.filter((p) => p.startsWith('server/signer/'))).toEqual([]);
    // Nor the runner's key-holding parts: the native signer runs in its own child process (GAS-02/03).
    expect(g.filter((p) => p.startsWith('server/runner/'))).toEqual([]);
  });
  it('the only fixed network origin in server code is the public RPC default', () => {
    const urls = new Set(serverSources.flatMap((s) => s.text.match(/https?:\/\/[a-z0-9.-]+/gi) ?? []));
    expect([...urls].filter((u) => !['https://rpc.plasma.to', 'http://x', 'http://127.0.0.1'].includes(u))).toEqual([]);
  });
});

