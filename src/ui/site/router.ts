// The client half of the real path routes (design guidelines §13.3). History API only: a same-origin left
// click on a link to a known page becomes a pushState, back/forward re-read the path, and an old `#/…` link is
// rewritten once on load. Anything else — another origin, a download, a modified click, an unknown path, a
// bare `#faq` on the current page — is left to the browser, so it behaves exactly as a plain link would.
import { useEffect, useState } from 'react';
import { legacyHashPath, routeForPath, type Route } from './routes';

/** Rewrites a recognised legacy `#/…` fragment to its path (keeping the query). Runs before the first render. */
export function migrateLegacyHash(): void {
  const path = legacyHashPath(location.hash);
  if (path) history.replaceState(history.state, '', path + location.search);
}

/** The element a fragment names, if it is on the page. */
const anchorFor = (hash: string): HTMLElement | null => {
  if (hash.length < 2) return null;
  try {
    return document.getElementById(decodeURIComponent(hash.slice(1)));
  } catch {
    return null;
  }
};

/**
 * After a page change (a routed click, Back/Forward, a migrated `#/…`): the hash target if there is one, else the
 * top of the page with focus on its title, as a page load would. Every page's `#page-title` is outside the lazy
 * tool chunk, so it is there on the next frame; the skip link, not this, goes to the tool's current step.
 */
function settle(hash: string) {
  window.scrollTo(0, 0);
  requestAnimationFrame(() => {
    const anchor = anchorFor(hash);
    if (anchor) anchor.scrollIntoView();
    else document.getElementById('page-title')?.focus({ preventScroll: true });
  });
}

/** Whether a click on this anchor is ours to route; null leaves it to the browser. */
export function routedHref(
  a: Pick<HTMLAnchorElement, 'href' | 'target' | 'hasAttribute'>,
  e: Pick<MouseEvent, 'button' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'defaultPrevented'>,
  here: Pick<Location, 'href' | 'origin' | 'pathname' | 'search'>,
): URL | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  if ((a.target && a.target !== '_self') || a.hasAttribute('download')) return null;
  let url: URL;
  try {
    url = new URL(a.href, here.href);
  } catch {
    return null;
  }
  if (url.origin !== here.origin || routeForPath(url.pathname) === 'notFound') return null;
  // Same page, only the fragment changes: a native in-page jump (keeps `:target`, history and scrolling).
  if (url.pathname === here.pathname && url.search === here.search && url.hash) return null;
  return url;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeForPath(location.pathname));
  useEffect(() => {
    // This owns scrolling on Back/Forward: the browser's own restoration would land later and win (it waits for
    // the page to grow back). To another page it settles like a click; within one page it goes to the fragment,
    // or to the top when the entry has none.
    history.scrollRestoration = 'manual';
    let path = location.pathname;
    const onPop = () => {
      const moved = location.pathname !== path;
      path = location.pathname;
      setRoute(routeForPath(path));
      if (moved) return settle(location.hash);
      const anchor = anchorFor(location.hash);
      if (anchor) anchor.scrollIntoView();
      else window.scrollTo(0, 0);
    };
    // An old `#/…` link followed on an open page changes only the fragment: no load, so migrate it here.
    const onHash = () => {
      if (!legacyHashPath(location.hash)) return;
      migrateLegacyHash();
      path = location.pathname;
      setRoute(routeForPath(path));
      settle('');
    };
    // A fragment in the address on load (`/#faq`) names content React has only just rendered: scroll to it now.
    anchorFor(location.hash)?.scrollIntoView();
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.('a');
      if (!(a instanceof HTMLAnchorElement)) return;
      const url = routedHref(a, e, location);
      if (!url) return;
      e.preventDefault();
      if (url.pathname + url.search + url.hash !== location.pathname + location.search + location.hash) history.pushState(null, '', url.pathname + url.search + url.hash);
      path = url.pathname;
      setRoute(routeForPath(path));
      settle(url.hash);
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onHash);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('click', onClick);
    };
  }, []);
  return route;
}
