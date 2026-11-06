// What the runner answers for a non-API request (design guidelines §13.3). Pure: the sidecar does the I/O.
// Order matters: the raw path is validated before anything normalises it, speculative loads are refused
// before page routing (they must neither reset the custom RPC nor receive a session-bearing page), then the
// exact page allowlist, then snapshotted files, and only a document navigation gets the HTML 404 page.
import { routeForPath } from '../src/ui/site/routes';

export type StaticRoute =
  | { kind: 'bad' }
  | { kind: 'speculative' }
  | { kind: 'page' }
  | { kind: 'file'; rel: string }
  | { kind: 'notFoundPage' }
  | { kind: 'notFound' };

type Headers = Record<string, string | string[] | undefined>;

const header = (h: Headers, name: string): string => {
  const v = h[name];
  return (Array.isArray(v) ? v.join(',') : (v ?? '')).toLowerCase();
};

/** Paths that are never pages: a miss under them keeps the JSON 404 (and the API routes answer before this). */
const RESERVED = ['/api', '/signer', '/assets'];

/**
 * The decoded path, or null when the raw request path is unsafe. Checked on the raw text: `new URL()` would
 * already have folded `/%2e%2e/x` into `/x`.
 */
export function safePath(rawUrl: string): string | null {
  const raw = rawUrl.split(/[?#]/, 1)[0] ?? '';
  if (!raw.startsWith('/')) return null;
  const out: string[] = [];
  for (const seg of raw.slice(1).split('/')) {
    let d: string;
    try {
      d = decodeURIComponent(seg);
    } catch {
      return null;
    }
    if (d === '.' || d === '..' || /[/\\\0]/.test(d)) return null;
    out.push(d);
  }
  return '/' + out.join('/');
}

export function isSpeculative(h: Headers): boolean {
  return header(h, 'sec-purpose').includes('prefetch') || header(h, 'purpose').includes('prefetch');
}

/** A top-level navigation to a document: Fetch Metadata when the browser sends it, `Accept` otherwise. */
export function isDocumentNavigation(h: Headers): boolean {
  const mode = header(h, 'sec-fetch-mode');
  const dest = header(h, 'sec-fetch-dest');
  if (mode || dest) return mode === 'navigate' && dest === 'document';
  return header(h, 'accept').includes('text/html');
}

export function classifyStatic(rawUrl: string, h: Headers, has: (rel: string) => boolean): StaticRoute {
  const path = safePath(rawUrl);
  if (path === null) return { kind: 'bad' };
  if (isSpeculative(h)) return { kind: 'speculative' };
  if (routeForPath(path) !== 'notFound') return { kind: 'page' };
  const rel = path.replace(/^\/+/, '');
  // HTML documents are only ever served through the page routes above (with the session) or as the 404 page.
  if (rel && !rel.endsWith('.html') && has(rel)) return { kind: 'file', rel };
  const reserved = RESERVED.some((r) => path === r || path.startsWith(`${r}/`));
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (!reserved && !last.includes('.') && isDocumentNavigation(h)) return { kind: 'notFoundPage' };
  return { kind: 'notFound' };
}
