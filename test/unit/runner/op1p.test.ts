// GAS-02: the 1Password gas payer's op adapter (server/runner/op1p.ts). The real `op` binary NEVER runs
// here: every runner test spawns test/fixtures/fakeOp.ts, a /bin/sh script in a temp dir that prints
// synthetic items and synthetic stderr.
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyOpFailure, itemGetArgv, Op1pError, parsePrivateLink, publicFields, readItem, realOpRunner, shapeOf, type OpRunner } from '../../../server/runner/op1p';
import { encryptKeystore } from '../../fixtures/keystore';
import { fakeOp, opAccountId, opId, type FakeOp, type FakeOpAccount } from '../../fixtures/fakeOp';

// Official case: the account ID in capitals, vault and item IDs in lowercase (as Copy Private Link writes them).
const A = opAccountId('a1');
const V = opId('b2');
const I = opId('c3');
const LINK = `https://start.1password.com/open/i?a=${A}&v=${V}&i=${I}&h=my.1password.com`;
const synthHex = () => randomBytes(32).toString('hex');

const kindOf = (f: () => unknown) => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof Op1pError ? e.kind : `not-Op1pError:${(e as Error).name}`;
  }
};

describe('parsePrivateLink', () => {
  it('a well-formed Private Link → account, vault and item byte for byte (account in capitals); only the host is lowercased', () => {
    const l = parsePrivateLink(`https://start.1password.com/open/i?a=${A}&v=${V}&i=${I}&h=My.1Password.EU`);
    expect(l).toEqual({ account: A, vault: V, item: I, host: 'my.1password.eu' });
    expect(l.account).toMatch(/^[A-Z0-9]{26}$/);
  });

  // regression (op-account-105801): the parser lowercased a=, so op --account got another, unknown filter.
  it.each([
    ['account lowercased', LINK.replace(`a=${A}`, `a=${A.toLowerCase()}`)],
    ['account in mixed case', LINK.replace(`a=${A}`, `a=${A.slice(0, 13)}${A.slice(13).toLowerCase()}`)],
    ['vault in capitals', LINK.replace(`v=${V}`, `v=${V.toUpperCase()}`)],
    ['item in capitals', LINK.replace(`i=${I}`, `i=${I.toUpperCase()}`)],
  ])('an id whose case was changed (%s) is refused, never repaired → kind link', (_, raw) => expect(kindOf(() => parsePrivateLink(raw))).toBe('link'));

  it('surrounding whitespace is trimmed; parameter order does not matter', () => {
    expect(parsePrivateLink(`  https://start.1password.com/open/i?h=team.1password.ca&i=${I}&v=${V}&a=${A}\n`).item).toBe(I);
  });

  it.each([
    ['non-string', 42],
    ['over 400 chars', `${LINK}${'x'.repeat(400)}`],
    ['not a URL', 'start.1password.com/open/i'],
    ['http scheme', LINK.replace('https:', 'http:')],
    ['other host', LINK.replace('start.1password.com', 'start.1password.com.evil.example')],
    ['explicit port', LINK.replace('start.1password.com', 'start.1password.com:8443')],
    ['userinfo', LINK.replace('https://', 'https://user:pw@')],
    ['fragment', `${LINK}#x`],
    ['other path', LINK.replace('/open/i', '/open/x')],
    ['trailing slash path', LINK.replace('/open/i', '/open/i/')],
    ['missing h', `https://start.1password.com/open/i?a=${A}&v=${V}&i=${I}`],
    ['duplicate a', `${LINK}&a=${A}`],
    ['extra param', LINK.replace('&h=', '&x=1&h=')],
    ['short id', LINK.replace(`i=${I}`, 'i=abc')],
    ['id with symbols', LINK.replace(`i=${I}`, `i=${'-'.repeat(26)}`)],
    ['non-1Password sign-in host', LINK.replace('h=my.1password.com', 'h=my.1password.org')],
    ['sign-in host lookalike', LINK.replace('h=my.1password.com', 'h=evil.example.com')],
  ])('refuses %s → kind link', (_, raw) => expect(kindOf(() => parsePrivateLink(raw))).toBe('link'));
});

describe('classifyOpFailure', () => {
  it.each([
    ['[ERROR] you are not currently signed in. Please run `op signin --help`', 'locked'],
    ['[ERROR] session expired, sign in to create a new session', 'locked'],
    ['[ERROR] authorization prompt cancelled by the user', 'cancelled'],
    ['[ERROR] authorization prompt dismissed, please try again', 'cancelled'],
    ['[ERROR] permission denied for this vault', 'denied'],
    ['[ERROR] found no accounts for filter "zzzz"', 'account'],
    ['[ERROR] account SYNTH not found', 'account'],
    ['[ERROR] "SYNTH" isn\'t an item in the "SYNTH" vault', 'not-found'],
    ['[ERROR] could not find vault SYNTH', 'not-found'],
    ['[ERROR] 2026/11/01 10:00:00 authorization timeout', 'timeout'],
    ['[ERROR] connecting to desktop app timed out, make sure it is installed, running and CLI integration is enabled', 'unavailable'],
    ['[ERROR] synthetic unexpected failure', 'failed'],
    ['', 'failed'],
  ])('stderr %j → %s', (stderr, kind) => expect(classifyOpFailure(1, stderr).kind).toBe(kind));

  it('never echoes the stderr text; a signal exit is reported as such', () => {
    const canary = `CANARY-${synthHex()}`;
    const e = classifyOpFailure(null, `[ERROR] weird ${canary}`);
    expect(e.message).not.toContain(canary);
    expect(e.message).toContain('exit signal');
  });

  it('matching is case-insensitive', () => expect(classifyOpFailure(1, 'YOU ARE NOT SIGNED IN').kind).toBe('locked'));
});

describe('itemGetArgv', () => {
  it('is exactly item get <item> --vault <v> --account <a> --format json', () => {
    expect([...itemGetArgv({ account: A, vault: V, item: I, host: 'my.1password.com' })]).toEqual(['item', 'get', I, '--vault', V, '--account', A, '--format', 'json']);
  });
});

describe('shapeOf', () => {
  it.each([
    ['', 'empty'],
    ['   \n', 'empty'],
    [synthHex(), 'private-key-hex'],
    [`0x${synthHex().toUpperCase()}`, 'private-key-hex'],
    [`  ${synthHex()}\n`, 'private-key-hex'],
    [synthHex().slice(0, 62), 'password-like'],
    [JSON.stringify({ version: 3, crypto: { kdf: 'scrypt' } }), 'keystore-v3'],
    [JSON.stringify({ version: 3, Crypto: { kdf: 'scrypt' } }), 'keystore-v3'],
    [JSON.stringify({ version: 4, crypto: {} }), 'password-like'],
    ['{not json', 'other'],
    ['synthetic-passphrase-9f2', 'password-like'],
    ['short7c', 'other'],
    ['two words here', 'other'],
    ['/Users/synthetic/wallets/gas-keystore.json', 'file-path'],
    ['  /Users/synthetic/My Wallets/gas.json\n', 'file-path'],
    ['/', 'file-path'],
    ['/two\nlines', 'other'],
    ['wallets/gas-keystore.json', 'password-like'],
  ])('%j → %s', (v, shape) => expect(shapeOf(v)).toBe(shape));
});

describe('realOpRunner against a fake op', () => {
  let op: FakeOp;
  afterEach(() => op?.cleanup());

  // A polluted caller: every other way op could authenticate (service account, session, Connect, account pin) or be
  // redirected, and the integration switch itself turned off. None of it may reach op.
  const env = (home: string) => ({ PATH: '/usr/bin:/bin', HOME: home, XDG_CONFIG_HOME: `${home}/cfg`, OP_SESSION_synthetic: 'synthetic-session', OP_SERVICE_ACCOUNT_TOKEN: 'synthetic-token', OP_CONNECT_HOST: 'http://127.0.0.1:9', OP_CONNECT_TOKEN: 'synthetic-connect', OP_ACCOUNT: 'synthetic.1password.com', OP_CONFIG_DIR: `${home}/elsewhere`, OP_BIOMETRIC_UNLOCK_ENABLED: 'false', HTTPS_PROXY: 'http://127.0.0.1:9', NODE_OPTIONS: '--require /nonexistent' });

  it('runs the binary with exactly the argv given and resolves its stdout', async () => {
    op = fakeOp({ stdout: '{"ok":true}' });
    const argv = itemGetArgv(parsePrivateLink(LINK));
    const out = await realOpRunner(op.bin, env(op.dir)).run(argv, 5000);
    expect(out.toString('utf8')).toBe('{"ok":true}');
    expect(op.argv()).toEqual([...argv]);
  });

  it('argv metacharacters reach op as literal arguments (no shell)', async () => {
    op = fakeOp({ stdout: '{}' });
    await realOpRunner(op.bin, env(op.dir)).run(['item', '$(touch pwned)', '; echo x', '`id`'], 5000);
    expect(op.argv()).toEqual(['item', '$(touch pwned)', '; echo x', '`id`']);
  });

  it('passes only PATH, HOME, XDG_CONFIG_HOME and the fixed desktop-app switch — no OP_* auth, proxy or NODE_* from the caller', async () => {
    op = fakeOp({ stdout: '{}' });
    await realOpRunner(op.bin, env(op.dir)).run(['item'], 5000);
    const seen = op.env()!;
    // /bin/sh itself may add PWD, SHLVL, OLDPWD and _.
    const extra = Object.keys(seen).filter((k) => !['PATH', 'HOME', 'XDG_CONFIG_HOME', 'OP_BIOMETRIC_UNLOCK_ENABLED', 'PWD', 'SHLVL', 'OLDPWD', '_'].includes(k));
    expect(extra).toEqual([]);
    // The caller's "false" cannot turn the desktop app integration off, and nothing else can sign op in.
    expect(seen).toMatchObject({ PATH: '/usr/bin:/bin', HOME: op.dir, XDG_CONFIG_HOME: `${op.dir}/cfg`, OP_BIOMETRIC_UNLOCK_ENABLED: 'true' });
  });

  it('the desktop-app switch is set even when the caller has no OP_* at all', async () => {
    op = fakeOp({ stdout: '{}' });
    await realOpRunner(op.bin, { PATH: '/usr/bin:/bin', HOME: op.dir }).run(['item'], 5000);
    expect(op.env()).toMatchObject({ OP_BIOMETRIC_UNLOCK_ENABLED: 'true' });
    expect(op.env()).not.toHaveProperty('OP_SERVICE_ACCOUNT_TOKEN');
  });

  it('XDG_CONFIG_HOME is omitted when the caller has none', async () => {
    op = fakeOp({ stdout: '{}' });
    await realOpRunner(op.bin, { PATH: '/usr/bin:/bin', HOME: op.dir }).run(['item'], 5000);
    expect(op.env()).not.toHaveProperty('XDG_CONFIG_HOME');
  });

  it('a non-zero exit is classified from stderr, and the stderr text is not forwarded', async () => {
    const canary = `CANARY-${synthHex()}`;
    op = fakeOp({ stderr: `[ERROR] you are not currently signed in ${canary}`, code: 1, stdout: '{"partial":true}' });
    const e = await realOpRunner(op.bin, env(op.dir)).run(['item'], 5000).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Op1pError);
    expect((e as Op1pError).kind).toBe('locked');
    expect((e as Op1pError).message).not.toContain(canary);
  });

  it.each([
    ['[ERROR] 2026/11/01 10:00:00 authorization prompt dismissed, please try again', 'cancelled'],
    ['[ERROR] No accounts configured for use with 1Password CLI.', 'unavailable'],
    ['[ERROR] connecting to desktop app timed out, make sure it is installed, running and CLI integration is enabled', 'unavailable'],
    ['[ERROR] connecting to desktop app: LostConnectionToApp', 'unavailable'],
    ['[ERROR] connection reset, make sure 1Password is running', 'unavailable'],
    ['[ERROR] 1Password app is locked. Please open 1Password and unlock it', 'locked'],
    ['[ERROR] no account found for filter aaaaaaaaaaaaaaaaaaaaaaaaaa', 'account'],
    ['[ERROR] found multiple accounts for filter aaaaaaaaaaaaaaaaaaaaaaaaaa', 'account'],
    ["[ERROR] You can't perform this action because the user is not authorized", 'denied'],
    ['[ERROR] authorization timeout', 'timeout'],
    ['[ERROR] cancelled', 'cancelled'],
    ['[ERROR] found no accounts', 'account'],
    ['[ERROR] "x" isn\'t an item', 'not-found'],
    ['[ERROR] synthetic', 'failed'],
  ])('exit 1 with stderr %j → %s', async (stderr, kind) => {
    op = fakeOp({ stderr, code: 1 });
    await expect(realOpRunner(op.bin, env(op.dir)).run(['item'], 5000)).rejects.toMatchObject({ kind });
  });

  it('a stderr chatter on exit 0 still resolves (stderr only matters on failure)', async () => {
    op = fakeOp({ stderr: '[WARN] you are not currently signed in', stdout: '{}' });
    await expect(realOpRunner(op.bin, env(op.dir)).run(['item'], 5000)).resolves.toBeInstanceOf(Buffer);
  });

  it('a binary that does not exist → missing', async () => {
    op = fakeOp();
    await expect(realOpRunner(`${op.dir}/no-such-op`, env(op.dir)).run(['item'], 5000)).rejects.toMatchObject({ kind: 'missing' });
  });

  it('no answer within the limit → timeout (the process is killed)', async () => {
    op = fakeOp({ sleepSec: 30 });
    const t0 = Date.now();
    await expect(realOpRunner(op.bin, env(op.dir)).run(['item'], 300)).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('regression (NX-02): stopAll ends an op still waiting (e.g. on an approval prompt) and resolves only after it exited; later runs are refused', async () => {
    op = fakeOp({ sleepSec: 30 });
    const r = realOpRunner(op.bin, env(op.dir));
    const t0 = Date.now();
    const pending = r.run(['item'], 60_000).catch((x: unknown) => x);
    let pid: number | null = null;
    for (let i = 0; i < 200 && pid === null; i++) (await new Promise((res) => setTimeout(res, 20)), (pid = op.pid()));
    expect(pid).toBeGreaterThan(0);
    const alive = (n: number) => { try { process.kill(n, 0); return true; } catch { return false; } };
    expect(alive(pid!)).toBe(true);
    await r.stopAll!();
    expect(alive(pid!)).toBe(false);
    const e = await pending;
    expect(e).toMatchObject({ kind: 'failed', message: expect.stringMatching(/stopping/) });
    expect(Date.now() - t0).toBeLessThan(5000);
    await expect(r.run(['item'], 5000)).rejects.toMatchObject({ kind: 'failed' });
  });

  it('cancelAll ends an op still waiting on an approval as cancelled (even if it would have printed an item), and the runner keeps working', async () => {
    op = fakeOp({ stdout: '{"id":"synthetic"}', delaySec: 30 });
    const r = realOpRunner(op.bin, env(op.dir));
    const pending = r.run(['item'], 60_000).catch((x: unknown) => x);
    let pid: number | null = null;
    for (let i = 0; i < 200 && pid === null; i++) (await new Promise((res) => setTimeout(res, 20)), (pid = op.pid()));
    expect(pid).toBeGreaterThan(0);
    await r.cancelAll!();
    expect(await pending).toMatchObject({ kind: 'cancelled' });
    op.set({ stdout: '{}' });
    await expect(r.run(['item'], 5000)).resolves.toBeInstanceOf(Buffer);
  });

  it('stopAll with nothing running resolves at once', async () => {
    op = fakeOp({ stdout: '{}' });
    const r = realOpRunner(op.bin, env(op.dir));
    await r.run(['item'], 5000);
    await expect(r.stopAll!()).resolves.toBeUndefined();
  });

  it('more than 512 KiB on stdout → failed, never resolved', async () => {
    op = fakeOp({ zeroBytes: 600 * 1024 });
    await expect(realOpRunner(op.bin, env(op.dir)).run(['item'], 5000)).rejects.toMatchObject({ kind: 'failed' });
  });
});

describe('readItem / publicFields', () => {
  const runnerOf = (body: unknown): OpRunner & { calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, run: async (argv) => (calls.push([...argv]), Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))) };
  };
  const link = parsePrivateLink(LINK);

  it('reads the linked item once with itemGetArgv and returns each field with its shape', async () => {
    const hex = synthHex();
    const ks = encryptKeystore(randomBytes(32), 'synthetic keystore pass');
    const op = runnerOf({ id: I.toUpperCase(), vault: { id: V }, fields: [
      { id: 'synthkey', label: 'Gas key', type: 'CONCEALED', value: hex, section: { id: 's1', label: 'Wallet' } },
      { id: 'synthks', label: 'Keystore', type: 'STRING', value: ks },
      { id: 'synthpw', label: 'Pass', type: 'CONCEALED', value: 'synthetic-pass-123' },
      { id: 'synthnote', label: 'Notes', type: 'STRING' },
    ] });
    const fields = await readItem(op, link);
    expect(op.calls).toEqual([[...itemGetArgv(link)]]);
    expect(fields.map((f) => [f.id, f.shape, f.section])).toEqual([['synthkey', 'private-key-hex', 'Wallet'], ['synthks', 'keystore-v3', null], ['synthpw', 'password-like', null], ['synthnote', 'empty', null]]);
    expect(fields[0]!.value).toBe(hex);
  });

  it('control characters are stripped from labels and labels are capped at 80 chars; type at 20', async () => {
    const op = runnerOf({ id: I, fields: [{ id: 'f1', label: `a\u0000b\u001b[31mc\u007f${'L'.repeat(100)}`, type: 'T'.repeat(30), value: '', section: { label: 'sec\ntion' } }] });
    const [f] = await readItem(op, link);
    expect(f!.label).toBe(`ab[31mc${'L'.repeat(73)}`);
    expect(f!.label).toHaveLength(80);
    expect(f!.type).toHaveLength(20);
    expect(f!.section).toBe('section');
  });

  it('fields without a usable id are dropped; a missing type reads unknown', async () => {
    const op = runnerOf({ id: I, fields: [{ label: 'no id' }, { id: '', label: 'empty' }, { id: 'x'.repeat(65) }, { id: 7 }, { id: 'ok' }] });
    expect((await readItem(op, link)).map((f) => [f.id, f.type])).toEqual([['ok', 'unknown']]);
  });

  it('an item without fields → []', async () => expect(await readItem(runnerOf({ id: I }), link)).toEqual([]));

  it('a different item id than the link names → not-found', async () => {
    await expect(readItem(runnerOf({ id: opId('d4'), fields: [] }), link)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('non-JSON output → failed', async () => {
    await expect(readItem(runnerOf('not json at all'), link)).rejects.toMatchObject({ kind: 'failed' });
  });

  it('the stdout buffer is zeroed after parsing', async () => {
    const buf = Buffer.from(JSON.stringify({ id: I, fields: [{ id: 'k', value: synthHex() }] }));
    await readItem({ run: async () => buf }, link);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  // Regression: JSON `null` is a classified Op1pError, not a TypeError (which would be a 500).
  it('a JSON null body → a classified Op1pError', async () => {
    const e = await readItem(runnerOf('null'), link).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Op1pError);
  });

  it('publicFields strips values and keeps metadata', async () => {
    const hex = synthHex();
    const pub = publicFields([{ id: 'k', label: 'Key', type: 'CONCEALED', section: null, shape: 'private-key-hex', value: hex }]);
    expect(pub).toEqual([{ id: 'k', label: 'Key', type: 'CONCEALED', section: null, shape: 'private-key-hex' }]);
    expect(JSON.stringify(pub)).not.toContain(hex);
  });
});

// regression (op-account-105801): the desktop app's `op` selects an account by ID case-sensitively — a lowercased
// account ID answers "found no accounts for filter" — and a sign-in address alone can name several accounts. The
// fake here models that (test/fixtures/fakeOp.ts `accounts`), so a parser that changes the account's case, or a
// runner that picks the account by host, fails these tests whatever the fixtures say.
describe('a Private Link against a case-sensitive, multi-account op (synthetic accounts)', () => {
  let op: FakeOp;
  afterEach(() => op?.cleanup());
  const B = opAccountId('b7');
  const VB = opId('e5');
  const IB = opId('f6');
  const item = (id: string, vault: string, label: string) => ({ id, vault: { id: vault }, fields: [{ id: 'password', label: 'password', type: 'CONCEALED', value: `synthetic-${label}` }] });
  // Two accounts on the same sign-in address; each holds one item.
  const accounts: FakeOpAccount[] = [
    { id: A, userId: opAccountId('u1'), url: 'my.1password.com', vaults: { [V]: { [I]: item(I, V, 'account-a') } } },
    { id: B, userId: opAccountId('u2'), url: 'my.1password.com', vaults: { [VB]: { [IB]: item(IB, VB, 'account-b') } } },
  ];
  const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent-home' };
  const linkB = `https://start.1password.com/open/i?a=${B}&v=${VB}&i=${IB}&h=my.1password.com`;

  it('the link as copied reads its own account’s item, and op got the account ID byte for byte', async () => {
    op = fakeOp({ accounts });
    const fields = await readItem(realOpRunner(op.bin, env), parsePrivateLink(LINK), 10_000);
    expect(fields.map((f) => f.value)).toEqual(['synthetic-account-a']);
    expect(op.argv()).toEqual(['item', 'get', I, '--vault', V, '--account', A, '--format', 'json']);
  });

  it('two accounts on one sign-in address: each link reads only its own account; never the other', async () => {
    op = fakeOp({ accounts });
    expect((await readItem(realOpRunner(op.bin, env), parsePrivateLink(linkB), 10_000)).map((f) => f.value)).toEqual(['synthetic-account-b']);
    // Account A's ID with account B's vault and item: op finds nothing there (no fallback to another account).
    const mixed = `https://start.1password.com/open/i?a=${A}&v=${VB}&i=${IB}&h=my.1password.com`;
    await expect(readItem(realOpRunner(op.bin, env), parsePrivateLink(mixed), 10_000)).rejects.toMatchObject({ kind: 'not-found' });
  });

  it('the model is faithful: a lowercased account ID → account; the shared sign-in address alone → account (several match)', async () => {
    op = fakeOp({ accounts });
    const run = (filter: string) => realOpRunner(op.bin, env).run(['item', 'get', I, '--vault', V, '--account', filter, '--format', 'json'], 10_000);
    await expect(run(A.toLowerCase())).rejects.toMatchObject({ kind: 'account' });
    await expect(run('my.1password.com')).rejects.toMatchObject({ kind: 'account' });
    await expect(run('MY.1password.com'.replace('MY', 'My'))).rejects.toMatchObject({ kind: 'account' });
  });

  it('an account this app does not have → account, and nothing is read', async () => {
    op = fakeOp({ accounts: [accounts[1]!] });
    await expect(readItem(realOpRunner(op.bin, env), parsePrivateLink(LINK), 10_000)).rejects.toMatchObject({ kind: 'account' });
  });
});
