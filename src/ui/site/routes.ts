// The site's real paths (design guidelines §13.3). One table drives the client router, the hosted build's
// per-route files and the runner's page allowlist, so the three can never disagree about what a page is.
// Pure: no DOM, so the runner (server/) imports it too.

export type Page = 'home' | 'recover' | 'guide' | 'how' | 'security' | 'download';
export type Route = Page | 'notFound';

export const PAGES: readonly Page[] = ['home', 'recover', 'guide', 'how', 'security', 'download'];

/** The canonical path of each page. No trailing slash (hosted uses `html_handling: "drop-trailing-slash"`). */
export const PATH: Record<Page, string> = {
  home: '/',
  recover: '/recover',
  guide: '/guide',
  how: '/how-it-works',
  security: '/security',
  download: '/download',
};

/** Every page path except `/`: the hosted build writes `<path>/index.html` for each. */
export const SUB_PATHS: readonly string[] = PAGES.filter((p) => p !== 'home').map((p) => PATH[p]);

/** The page a pathname names, or `notFound`. A single trailing slash is tolerated; nothing else is. */
export function routeForPath(pathname: string): Route {
  const p = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return PAGES.find((k) => PATH[k] === p) ?? 'notFound';
}

/** The legacy `#/…` fragments (before 0.3) and the page each now lives at. Only these are migrated. */
const LEGACY: Record<string, Page> = {
  '#/home': 'home',
  '#/recover': 'recover',
  '#/guide': 'guide',
  '#/how-it-works': 'how',
  '#/security': 'security',
  '#/download': 'download',
};

/** The path an old `#/…` link means, or null for any other fragment (`#faq` stays an ordinary anchor). */
export function legacyHashPath(hash: string): string | null {
  const page = LEGACY[hash.replace(/\/$/, '')];
  return page ? PATH[page] : null;
}
