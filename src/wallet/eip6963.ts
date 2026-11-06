// EIP-6963 multi-wallet discovery (GAS-01). With several extensions installed, window.ethereum is
// whichever one injected last; this lists every announced provider so the user picks one explicitly
// (OKX Wallet is recognised by its rdns). Announced names are display text only: control characters are
// stripped and length is capped; icons are never rendered (an announced icon is an arbitrary data: URI).
import type { Eip1193 } from './eip1193';

export const OKX_RDNS = 'com.okex.wallet';

export interface Announced {
  uuid: string;
  name: string;
  rdns: string;
  provider: Eip1193;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RDNS = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export function sanitizeName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim() : '';
  return s.slice(0, 40) || 'Unnamed wallet';
}

/** Validates one `eip6963:announceProvider` detail; null when it is not a usable announcement. */
export function parseAnnouncement(detail: unknown): Announced | null {
  const d = detail as { info?: { uuid?: unknown; name?: unknown; rdns?: unknown }; provider?: { request?: unknown } } | null;
  if (!d || typeof d !== 'object' || !d.info || !d.provider || typeof d.provider.request !== 'function') return null;
  const { uuid, rdns } = d.info;
  if (typeof uuid !== 'string' || !UUID.test(uuid) || typeof rdns !== 'string' || !RDNS.test(rdns) || rdns.length > 100) return null;
  return { uuid: uuid.toLowerCase(), name: sanitizeName(d.info.name), rdns: rdns.toLowerCase(), provider: d.provider as Eip1193 };
}

/**
 * Listens for announcements and asks every wallet to announce itself. `onChange` gets the whole list,
 * de-duplicated by uuid (a re-announce replaces the entry), OKX first. Returns the unsubscribe.
 */
export function discoverWallets(onChange: (list: Announced[]) => void, target: EventTarget = window): () => void {
  const byId = new Map<string, Announced>();
  const emit = () => onChange([...byId.values()].sort((a, b) => Number(b.rdns === OKX_RDNS) - Number(a.rdns === OKX_RDNS) || a.name.localeCompare(b.name)));
  const onAnnounce = (e: Event) => {
    const a = parseAnnouncement((e as CustomEvent).detail);
    if (!a) return;
    byId.set(a.uuid, a);
    emit();
  };
  target.addEventListener('eip6963:announceProvider', onAnnounce);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return () => target.removeEventListener('eip6963:announceProvider', onAnnounce);
}
