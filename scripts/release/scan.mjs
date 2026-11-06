#!/usr/bin/env node
// Secret and privacy scan for a public file set: the clean export (scripts/release/export.mjs) or any directory.
//   node scripts/release/scan.mjs [dir] [--deny-file <path>] [--json <report path>]
// Generic rules below catch home and temp paths, session artifacts, credentials in RPC URLs, private keys and
// mnemonics next to their keywords, real-looking 1Password references, emails, WebAuthn assertions outside the
// synthetic tests, keystores outside test fixtures and references to material that is not public.
// --deny-file names a PRIVATE list kept outside the repository (one term per line: a name, an address, an ID);
// every match (generic or deny list) is reported by rule and location only, never by the matched text. Exit 1 on any hit.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = resolve(args.find((a, i) => !a.startsWith('--') && !['--deny-file', '--json'].includes(args[i - 1])) ?? '.');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-server', 'dist-hosted', '.e2e-build', 'test-results', 'playwright-report', '.wrangler', 'release-out']);

// Well-known public keys of Anvil/Hardhat's default dev accounts (the test chain); never real funds.
const PUBLIC_DEV_KEYS = new Set([
  'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
]);
const isTest = (f) => f.startsWith('test/');

/** Each rule: id, regex (global), and an optional filter that drops a match (f = repo-relative path, m = match). */
const RULES = [
  { id: 'home-path', re: /(?:\/Users|\/home)\/(?!you\b|someone\b|synthetic\b|runner\b|<)[A-Za-z0-9._-]+\/|C:\\\\?Users\\\\?(?!you\b|<)[A-Za-z0-9._-]+/g },
  { id: 'temp-path', re: /\/private\/(?:tmp|var\/folders)\/[A-Za-z0-9]|\/var\/folders\/[a-z0-9_]{2}\//g },
  { id: 'session-artifact', re: /claude-\d{3}\/|\.claude\/projects|claude\.ai\/code\/session|session_[A-Za-z0-9]{16,}|\bscratchpad\//g },
  { id: 'rpc-credential', re: /https?:\/\/[^\s'"`)]*(?:alchemy\.com\/v2\/[A-Za-z0-9_-]{8,}|infura\.io\/v3\/[0-9a-f]{8,}|quiknode\.pro\/[0-9a-f]{8,}|\/v[23]\/[A-Za-z0-9_-]{24,}|[?&](?:api[-_]?key|apikey|key|token)=[A-Za-z0-9_-]{16,})/gi, keep: (f, m) => !/E2eSyntheticPathKey|synthetic|FAKEKEY|example\.(?:com|org)/i.test(m) },
  { id: 'private-key', re: /(?:private[_ -]?key|privkey|secret[_ -]?key|PRIVATE_KEY)[^\n]{0,48}?(?:0x)?([0-9a-fA-F]{64})\b/g, keep: (f, m, g) => !PUBLIC_DEV_KEYS.has(g[1].toLowerCase()) && !isTest(f) },
  { id: 'mnemonic', re: /(?:mnemonic|seed phrase|recovery phrase)[^\n]{0,24}["'`](?:[a-z]{3,8} ){11,23}[a-z]{3,8}["'`]/gi, keep: (f, m) => !/test test test/.test(m) },
  { id: 'op-reference', re: /op:\/\/[A-Za-z0-9 _-]+\/[A-Za-z0-9 _-]+\/[A-Za-z0-9 _-]+/g, keep: (f, m) => !isTest(f) && !/<|vault>|SYNTH|synthetic|example/i.test(m) },
  { id: 'op-link-ids', re: /start\.1password\.com\/open\/i\?a=[A-Z0-9]{26}/g, keep: (f) => !isTest(f) },
  { id: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, keep: (f, m) => !f.startsWith('licenses/') && !/noreply|example\.(?:com|org|net)|\.example$|@(?:types|vitejs|playwright|axe-core|noble|scure|fontsource|foundry-rs|adraffy|openzeppelin|cloudflare|img|typescript|esbuild|rollup|emnapi|napi-rs|oxc-project|rolldown|tybys|jridgewell|babel|standard-schema|poppinss|speed-highlight|sindresorhus|isaacs|vitest|bcoe|tsconfig)\b/i.test(m) && !/\.(?:png|svg|woff2?|js|mjs|ts|tsx|json)$/.test(m) },
  { id: 'webauthn-assertion', re: /"clientDataJSON"\s*:\s*"eyJ[A-Za-z0-9_-]{40,}/g, keep: (f) => !isTest(f) },
  // Names of folders and files that stay private; this file and .gitignore name them on purpose.
  { id: 'private-material-ref', re: /docs\/research\/|plasma-withdrawal|passkey-signing-console|\.sd0x\/|\bspikes\/|preview-runner\.log|wallet-tools|create-gas-wallet/g, keep: (f) => f !== 'scripts/release/scan.mjs' && f !== '.gitignore' },
];

function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

const binary = (buf) => buf.subarray(0, 8000).includes(0);
// Each term keeps its line number in the private file: a hit names that line, never the term or a hash of it.
const deny = opt('--deny-file')
  ? readFileSync(opt('--deny-file'), 'utf8').split('\n').map((l, n) => ({ t: l.trim().toLowerCase(), n: n + 1 })).filter(({ t }) => t && !t.startsWith('#'))
  : [];
const hits = [];
const files = walk(dir);
let scanned = 0;
for (const p of files) {
  const f = relative(dir, p).split('\\').join('/');
  const buf = readFileSync(p);
  if (binary(buf)) continue;
  scanned++;
  const lines = buf.toString('utf8').split('\n');
  // A keystore (encrypted key file) belongs only in synthetic test fixtures.
  const text = lines.join('\n');
  if (/"ciphertext"\s*:/.test(text) && /"kdfparams"\s*:/.test(text) && !isTest(f) && /\.json$/.test(f)) hits.push({ file: f, line: 1, rule: 'keystore-file' });
  lines.forEach((line, i) => {
    for (const r of RULES) {
      r.re.lastIndex = 0;
      for (let m; (m = r.re.exec(line)); ) {
        if (r.keep && !r.keep(f, m[0], m)) continue;
        // Rule and location only: the matched text may itself be the secret, and this output is logged and uploaded.
        hits.push({ file: f, line: i + 1, rule: r.id });
      }
    }
    const low = line.toLowerCase();
    for (const { t, n } of deny) if (low.includes(t)) hits.push({ file: f, line: i + 1, rule: 'deny-list', denyLine: n });
  });
}
// Files that must never be published, whatever they contain.
for (const p of files) {
  const f = relative(dir, p).split('\\').join('/');
  if (/(^|\/)\.env(\.|$)|\.(pem|key|log|jsonl)$|(^|\/)(exports|\.claude|\.sd0x|spikes)\//.test(f)) hits.push({ file: f, line: 0, rule: 'forbidden-file' });
}

const report = { dir, files: files.length, textFilesScanned: scanned, rules: [...RULES.map((r) => r.id), 'keystore-file', 'forbidden-file', ...(deny.length ? ['deny-list'] : [])], denyTerms: deny.length, hits };
if (opt('--json')) writeFileSync(opt('--json'), `${JSON.stringify(report, null, 2)}\n`);
for (const h of hits) console.error(`${h.rule}: ${h.file}:${h.line}${h.denyLine ? ` (deny-file line ${h.denyLine})` : ''}`);
console.log(`scan: ${scanned} text files of ${files.length}, ${hits.length} hit(s)${deny.length ? `, ${deny.length} private deny terms` : ''}`);
process.exit(hits.length ? 1 : 0);
