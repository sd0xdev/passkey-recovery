// Page side of the Passkey Recovery bridge, protocol v1 (ADR-002; extension/protocol.js is the other side).
// The page pairs one 32-byte challenge with the extension, shows the pairing code, then waits for the
// assertion the extension collected on https://keys.coinbase.com/connect. The assertion is returned to the
// caller as text and kept nowhere else: not logged, not stored, not put in the URL.
import { bytesToHex } from '../crypto/bytes';
import type { AssertionKind } from '../webauthn/assertion';

/** Fixed by the public `key` in extension/manifest.json. */
export const BRIDGE_EXTENSION_ID = 'imkijjdbgdekpebmpdjpgngpdambepok';
export const BRIDGE_VERSION = 1;
/** The extension accepts only this origin (externally_connectable + its own sender check). */
export const BRIDGE_APP_ORIGIN = 'http://127.0.0.1:4173';

export type Send = (message: Record<string, unknown>) => Promise<unknown>;

export class BridgeUnavailable extends Error {
  override name = 'BridgeUnavailable';
}
export class BridgeFailed extends Error {
  override name = 'BridgeFailed';
}

type ChromeRuntime = { sendMessage?: (id: string, msg: unknown, cb: (r: unknown) => void) => void; lastError?: { message?: string } };

/**
 * The transport to the installed extension, or null when it cannot exist here: Chrome exposes
 * chrome.runtime.sendMessage to a page only when an installed extension lists the page's origin.
 */
export function chromeSend(origin: string = globalThis.location?.origin ?? ''): Send | null {
  if (origin !== BRIDGE_APP_ORIGIN) return null;
  const rt = (globalThis as { chrome?: { runtime?: ChromeRuntime } }).chrome?.runtime;
  if (!rt?.sendMessage) return null;
  const sendMessage = rt.sendMessage.bind(rt);
  return (message) =>
    new Promise((resolve, reject) => {
      sendMessage(BRIDGE_EXTENSION_ID, message, (r) => {
        const err = rt.lastError;
        if (err) reject(new BridgeUnavailable('the Passkey Recovery extension is not installed or not enabled'));
        else resolve(r);
      });
    });
}

export interface BridgeRequest {
  kind: AssertionKind;
  challenge: Uint8Array;
  send: Send;
  /** Called once the extension holds the pairing; show `code` to the user. */
  onCode: (code: string) => void;
  signal?: AbortSignal;
  pollMs?: number;
  /** Stop waiting after this long (the extension drops the pairing after 5 minutes too). */
  timeoutMs?: number;
  randomId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

const CODE = /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;

function newRequestId(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b).slice(2);
}

function reply(r: unknown): { ok: boolean; error?: string; code?: unknown; waiting?: unknown; assertion?: unknown } {
  if (typeof r !== 'object' || r === null) throw new BridgeFailed('the extension sent no answer');
  const o = r as Record<string, unknown>;
  return { ok: o.ok === true, ...(typeof o.error === 'string' ? { error: o.error.slice(0, 200) } : {}), code: o.code, waiting: o.waiting, assertion: o.assertion };
}

/** Pairs `challenge` with the extension and resolves with the cbpr-assertion-v1 text it collected. */
export async function requestAssertion(req: BridgeRequest): Promise<string> {
  if (req.challenge.length !== 32) throw new Error('challenge must be 32 bytes');
  const sleep = req.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const requestId = (req.randomId ?? newRequestId)();
  const base = { v: BRIDGE_VERSION, requestId };
  const paired = reply(await req.send({ ...base, type: 'pair', kind: req.kind, challenge: bytesToHex(req.challenge).toLowerCase() }));
  if (!paired.ok) throw new BridgeFailed(paired.error ?? 'the extension refused the request');
  if (typeof paired.code !== 'string' || !CODE.test(paired.code)) throw new BridgeFailed('the extension sent a malformed pairing code');
  req.onCode(paired.code);
  const deadline = Date.now() + (req.timeoutMs ?? 5 * 60_000);
  try {
    for (;;) {
      if (req.signal?.aborted) throw new BridgeFailed('stopped');
      if (Date.now() > deadline) throw new BridgeFailed('no signature arrived in time; start again');
      await sleep(req.pollMs ?? 1000);
      if (req.signal?.aborted) throw new BridgeFailed('stopped');
      const r = reply(await req.send({ ...base, type: 'result' }));
      if (!r.ok) throw new BridgeFailed(r.error ?? 'the extension reported an error');
      if (r.waiting === true) continue;
      if (typeof r.assertion !== 'string') throw new BridgeFailed('the extension sent no assertion');
      return r.assertion;
    }
  } catch (e) {
    // Leave nothing behind in the extension when the page gives up.
    await req.send({ ...base, type: 'cancel' }).catch(() => {});
    throw e;
  }
}
