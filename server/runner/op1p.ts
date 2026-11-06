// 1Password gas payer (GAS-02), local runner only. The user pastes a 1Password *Private Link* and picks a
// field; the runner's native signer asks the user's own `op` CLI for that one item with a structured argv
// (no shell, no `op run`, no user-supplied flags). Values stay in the signer process: inspect returns
// field metadata plus a shape hint, unlock returns only the derived address. stderr of `op` is read for
// classification and never forwarded. Tests run a fake `op` with synthetic data only.
import { spawn } from 'node:child_process';

export type OpErrorKind = 'missing' | 'unavailable' | 'locked' | 'denied' | 'cancelled' | 'not-found' | 'account' | 'timeout' | 'failed' | 'link' | 'field' | 'field-password' | 'changed';

export class Op1pError extends Error {
  override name = 'Op1pError';
  constructor(
    readonly kind: OpErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface PrivateLink {
  account: string;
  vault: string;
  item: string;
  host: string;
}

// Official shapes as 1Password's Copy Private Link writes them: the account ID (`a`) in capitals, vault (`v`) and
// item (`i`) IDs in lowercase. `op --account` matches an account ID case-sensitively (a lowercased ID answers
// "found no accounts for filter"), so every ID is kept byte for byte: a changed case is refused, never repaired.
const ACCOUNT_ID = /^[A-Z0-9]{26}$/;
const ID = /^[a-z0-9]{26}$/;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.1password\.(?:com|eu|ca)$/;

/**
 * Strict Private Link parser: https, host start.1password.com, path /open/i, exactly the params a, v, i,
 * h (each once), IDs verbatim in their official case, h a *.1password.(com|eu|ca) sign-in host; no userinfo,
 * port, fragment or extra params. Anything else is refused before `op` ever runs. The account is selected by
 * its ID only: the host can name several accounts (op: "found multiple accounts for filter").
 */
export function parsePrivateLink(raw: unknown): PrivateLink {
  if (typeof raw !== 'string' || raw.length > 400) throw new Op1pError('link', 'paste the 1Password Private Link (Copy Private Link in the item menu)');
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Op1pError('link', 'this is not a link');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'start.1password.com' || u.port || u.username || u.password || u.hash || u.pathname !== '/open/i') throw new Op1pError('link', 'not a 1Password Private Link (expected start.1password.com/open/i?…)');
  const keys = [...u.searchParams.keys()];
  const want = ['a', 'v', 'i', 'h'];
  if (keys.length !== 4 || want.some((k) => u.searchParams.getAll(k).length !== 1)) throw new Op1pError('link', 'the link must carry exactly the account, vault, item and host parameters');
  const account = u.searchParams.get('a')!;
  const vault = u.searchParams.get('v')!;
  const item = u.searchParams.get('i')!;
  // A sign-in host is a DNS name: its case carries no identity.
  const host = u.searchParams.get('h')!.toLowerCase();
  if (!ACCOUNT_ID.test(account)) throw new Op1pError('link', 'the link’s account id is not as 1Password writes it (26 capital letters and digits): copy the Private Link again and paste it unchanged');
  if (![vault, item].every((x) => ID.test(x))) throw new Op1pError('link', 'the link’s vault or item id is not as 1Password writes it (26 lowercase letters and digits): copy the Private Link again and paste it unchanged');
  if (!HOST.test(host)) throw new Op1pError('link', 'the link’s sign-in host is not a 1Password host');
  return { account, vault, item, host };
}

/** Every shape hint a field can get; the UI has copy for each (test/unit/ui/copy-shapes.test.ts). */
export const FIELD_SHAPES = ['private-key-hex', 'keystore-v3', 'file-path', 'password-like', 'empty', 'other'] as const;
export type FieldShape = (typeof FIELD_SHAPES)[number];

/** Field metadata only. `shape` is a hint computed in memory from the value, which never leaves. */
export interface FieldInfo {
  id: string;
  label: string;
  type: string;
  section: string | null;
  shape: FieldShape;
}

export interface OpRunner {
  /** Runs `op` with exactly this argv; resolves stdout bytes, or rejects with a classified Op1pError. */
  run(argv: readonly string[], timeoutMs: number): Promise<Buffer>;
  /** Ends every `op` this runner started and still running; resolves once each has exited (signer shutdown). */
  stopAll?(): Promise<void>;
  /** Ends every `op` still waiting (e.g. on a 1Password approval) — each rejects as `cancelled` — without stopping the runner. */
  cancelAll?(): Promise<void>;
}

/**
 * The whole environment an `op` child gets. Nothing is inherited beyond PATH, HOME and XDG_CONFIG_HOME, so a
 * caller's OP_SERVICE_ACCOUNT_TOKEN, OP_SESSION_*, OP_CONNECT_*, OP_ACCOUNT, proxy or NODE_* setting can neither
 * authenticate nor redirect it. The one fixed, non-secret addition is the official desktop app integration switch:
 * `op` then asks the user's own 1Password app to approve (Touch ID / password) — there is no other way to sign in.
 */
export function opChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { PATH: env.PATH ?? '', HOME: env.HOME ?? '', ...(env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: env.XDG_CONFIG_HOME } : {}), OP_BIOMETRIC_UNLOCK_ENABLED: 'true' };
}

/** Maps `op`'s exit + stderr onto a fixed class. The stderr text itself is never returned. */
export function classifyOpFailure(code: number | null, stderr: string): Op1pError {
  const s = stderr.toLowerCase();
  // Order matters: the desktop-app connection messages also contain words like "account" or "timed out".
  if (/no accounts configured|connecting to desktop app|cli integration|lostconnectiontoapp|connection reset/.test(s)) return new Op1pError('unavailable', 'op could not reach the 1Password app: turn on Settings > Developer > Integrate with 1Password CLI (and, on macOS, allow the app that started the runner under Privacy & Security > Files & Folders), then try again');
  // op's own approval deadline (the app prompt left unanswered), distinct from the runner's time limit below.
  if (/authorization timeout|authorization timed out/.test(s)) return new Op1pError('timeout', '1Password did not get an approval in time; nothing was read');
  if (/prompt dismissed|cancel/.test(s)) return new Op1pError('cancelled', 'the 1Password authorization was cancelled; nothing was read');
  if (/app is locked|not currently signed in|session expired|you are not signed in|account is not signed in|sign in to|authentication required|locked/.test(s)) return new Op1pError('locked', '1Password is locked: unlock the 1Password app, then try again');
  if (/no account found|found no accounts|account .*not found|unknown account|multiple accounts/.test(s)) return new Op1pError('account', 'the account in the link is not one of the accounts in the 1Password app on this computer');
  if (/denied|not authorized|unauthorized|permission|can't perform this action/.test(s)) return new Op1pError('denied', '1Password denied the request; nothing was read');
  if (/isn't an item|is not an item|not found|no item|isn't a vault|doesn't exist|could not find/.test(s)) return new Op1pError('not-found', 'the item (or vault) in the link was not found by op — check the link and that this account can see it');
  return new Op1pError('failed', `the op CLI failed (exit ${code ?? 'signal'}); its message is withheld`);
}

export function realOpRunner(bin = 'op', env: NodeJS.ProcessEnv = process.env): OpRunner {
  // Every live `op` child: a promise of its process exit, so shutdown can end and await them (NX-02), and how to
  // end it as `cancelled` at once (its request answers even if a pipe it left behind stays open).
  const live = new Map<ReturnType<typeof spawn>, { cancel: () => void; exit: Promise<void> }>();
  const cancelled = new WeakSet<ReturnType<typeof spawn>>();
  let stopping = false;
  return {
    stopAll() {
      stopping = true;
      const ending = [...live.entries()];
      for (const [c] of ending) c.kill('SIGKILL');
      return Promise.all(ending.map(([, c]) => c.exit)).then(() => undefined);
    },
    cancelAll() {
      const ending = [...live.values()];
      for (const c of ending) c.cancel();
      return Promise.all(ending.map((c) => c.exit)).then(() => undefined);
    },
    run(argv, timeoutMs) {
      if (stopping) return Promise.reject(new Op1pError('failed', 'the runner is stopping; nothing was read'));
      return new Promise((resolve, reject) => {
        let p: ReturnType<typeof spawn>;
        try {
          // No shell, no inherited OP_* or proxy setting (opChildEnv).
          p = spawn(bin, [...argv], { stdio: ['ignore', 'pipe', 'pipe'], shell: false, env: opChildEnv(env) });
        } catch {
          return reject(new Op1pError('missing', 'the 1Password CLI (op) is not installed or not on PATH'));
        }
        let exited!: () => void;
        const exit = new Promise<void>((r) => (exited = r));
        p.once('exit', () => (live.delete(p), exited()));
        const done = () => (live.delete(p), exited());
        live.set(p, {
          exit,
          cancel: () => {
            cancelled.add(p);
            p.kill('SIGKILL');
            clearTimeout(timer);
            reject(new Op1pError('cancelled', 'the request was stopped before 1Password answered; nothing was read'));
          },
        });
        const out: Buffer[] = [];
        let err = '';
        let size = 0;
        const timer = setTimeout(() => {
          p.kill('SIGKILL');
          reject(new Op1pError('timeout', 'op did not answer within the time limit (an approval prompt may still be open); nothing was read'));
        }, timeoutMs);
        p.stdout!.on('data', (c: Buffer) => {
          size += c.length;
          if (size > 512 * 1024) p.kill('SIGKILL');
          else out.push(c);
        });
        p.stderr!.on('data', (c: Buffer) => {
          if (err.length < 4096) err += c.toString('utf8');
        });
        p.on('error', (e: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          done();
          reject(e.code === 'ENOENT' ? new Op1pError('missing', 'the 1Password CLI (op) is not installed or not on PATH') : new Op1pError('failed', 'could not run op'));
        });
        p.on('close', (code) => {
          clearTimeout(timer);
          done();
          const buf = Buffer.concat(out);
          const ended = cancelled.has(p);
          if (code === 0 && size <= 512 * 1024 && !stopping && !ended) return resolve(buf);
          buf.fill(0);
          if (stopping) return reject(new Op1pError('failed', 'the runner is stopping; nothing was read'));
          if (ended) return reject(new Op1pError('cancelled', 'the request was stopped before 1Password answered; nothing was read'));
          reject(classifyOpFailure(code, err));
        });
      });
    },
  };
}

/** The one argv this module ever builds. */
export const itemGetArgv = (l: PrivateLink) => ['item', 'get', l.item, '--vault', l.vault, '--account', l.account, '--format', 'json'] as const;

export function shapeOf(value: string): FieldInfo['shape'] {
  const v = value.trim();
  if (!v) return 'empty';
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(v)) return 'private-key-hex';
  if (v.startsWith('{')) {
    try {
      const j = JSON.parse(v) as { version?: unknown; crypto?: unknown; Crypto?: unknown };
      if (j.version === 3 && (j.crypto || j.Crypto)) return 'keystore-v3';
    } catch {
      /* not JSON */
    }
  }
  // A hint for the existing-gas-wallet location field; the signer decides on the value it reads on unlock.
  if (/^\/[^\u0000-\u001f\u007f]*$/.test(v) && v.length <= 1024) return 'file-path';
  if (v.length >= 8 && !/\s/.test(v)) return 'password-like';
  return 'other';
}

interface OpField {
  id?: unknown;
  label?: unknown;
  type?: unknown;
  value?: unknown;
  section?: { label?: unknown; id?: unknown };
}

/** Reads the item once and returns its fields with values (signer-internal only). */
export async function readItem(op: OpRunner, link: PrivateLink, timeoutMs = 120_000): Promise<Array<FieldInfo & { value: string }>> {
  const buf = await op.run(itemGetArgv(link), timeoutMs);
  let j: { id?: unknown; vault?: { id?: unknown }; fields?: unknown };
  try {
    j = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Op1pError('failed', 'op returned something that is not JSON');
  } finally {
    buf.fill(0);
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Op1pError('failed', 'op returned JSON that is not an item');
  if (typeof j.id !== 'string' || j.id.toLowerCase() !== link.item) throw new Op1pError('not-found', 'op returned a different item than the link names');
  if (!Array.isArray(j.fields)) return [];
  return (j.fields as OpField[])
    .filter((f) => typeof f.id === 'string' && f.id.length > 0 && f.id.length <= 64)
    .map((f) => {
      const value = typeof f.value === 'string' ? f.value : '';
      const label = typeof f.label === 'string' ? f.label.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : '';
      const section = typeof f.section?.label === 'string' ? f.section.label.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 80) : null;
      return { id: f.id as string, label, type: typeof f.type === 'string' ? f.type.slice(0, 20) : 'unknown', section, shape: shapeOf(value), value };
    });
}

export const publicFields = (fields: Array<FieldInfo & { value: string }>): FieldInfo[] => fields.map(({ id, label, type, section, shape }) => ({ id, label, type, section, shape }));
