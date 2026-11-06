// Website routing (design guidelines §13.3): one table of real paths, the legacy `#/…` links mapped onto it,
// and the client's decision of which link clicks it routes itself.
import { describe, expect, it } from 'vitest';
import { legacyHashPath, PAGES, PATH, routeForPath, SUB_PATHS } from '../../../src/ui/site/routes';
import { routedHref } from '../../../src/ui/site/router';

describe('routeForPath', () => {
  it('each page path → its page; the six pages are all there', () => {
    for (const p of PAGES) expect(routeForPath(PATH[p])).toBe(p);
    expect(Object.values(PATH)).toEqual(['/', '/recover', '/guide', '/how-it-works', '/security', '/download']);
  });

  it('a single trailing slash is the same page', () => {
    expect(routeForPath('/guide/')).toBe('guide');
    expect(routeForPath('/')).toBe('home');
  });

  it('anything else → notFound (case, double slash, sub-paths, files, API)', () => {
    for (const p of ['/nope', '/GUIDE', '/guide//', '//guide', '/guide/x', '/recover.html', '/index.html', '/api', '/assets/x.js', '/how', '']) expect(routeForPath(p), p).toBe('notFound');
  });

  it('SUB_PATHS: every page but / (the hosted build writes <path>/index.html for each)', () => {
    expect(SUB_PATHS).toEqual(['/recover', '/guide', '/how-it-works', '/security', '/download']);
  });
});

describe('legacyHashPath', () => {
  it('each old #/… link → its path, with or without a trailing slash', () => {
    expect(legacyHashPath('#/home')).toBe('/');
    expect(legacyHashPath('#/recover')).toBe('/recover');
    expect(legacyHashPath('#/how-it-works/')).toBe('/how-it-works');
    expect(legacyHashPath('#/download')).toBe('/download');
  });

  it('ordinary fragments and unknown routes are left alone', () => {
    for (const h of ['', '#', '#faq', '#/', '#/nope', '#/GUIDE', '#guide', '#/guide?x=1', 'javascript:alert(1)']) expect(legacyHashPath(h), h).toBeNull();
  });
});

describe('routedHref', () => {
  const here = new URL('http://127.0.0.1:4174/guide?x=1');
  const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };
  // The three things the decision reads from an <a>; the anchor itself needs a DOM, this test does not.
  const link = (href: string, attrs: { download?: string; target?: string } = {}) => ({ href, target: attrs.target ?? '', hasAttribute: (n: string) => n in attrs });

  it('a plain click on a known page of this origin is routed (query and hash kept)', () => {
    expect(routedHref(link('http://127.0.0.1:4174/recover'), click, here)?.pathname).toBe('/recover');
    expect(routedHref(link('http://127.0.0.1:4174/#faq'), click, here)?.hash).toBe('#faq');
  });

  it('modified, non-primary or already-handled clicks are left to the browser', () => {
    const a = link('http://127.0.0.1:4174/recover');
    for (const k of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey', 'defaultPrevented'] as const) expect(routedHref(a, { ...click, [k]: true }, here), k).toBeNull();
    expect(routedHref(a, { ...click, button: 1 }, here)).toBeNull();
  });

  it('other origins, downloads, new-tab targets and unknown paths are left to the browser', () => {
    expect(routedHref(link('https://github.com/sd0xdev/passkey-recovery'), click, here)).toBeNull();
    expect(routedHref(link('http://127.0.0.1:4175/recover'), click, here)).toBeNull();
    expect(routedHref(link('http://127.0.0.1:4174/recover', { download: '' }), click, here)).toBeNull();
    expect(routedHref(link('http://127.0.0.1:4174/recover', { target: '_blank' }), click, here)).toBeNull();
    expect(routedHref(link('http://127.0.0.1:4174/passkey-recovery.tgz'), click, here)).toBeNull();
    expect(routedHref(link('http://127.0.0.1:4174/api/config'), click, here)).toBeNull();
  });

  it('a fragment on the same page stays a native in-page jump', () => {
    expect(routedHref(link('http://127.0.0.1:4174/guide?x=1#guide-gas'), click, here)).toBeNull();
    expect(routedHref(link('http://127.0.0.1:4174/guide#guide-gas'), click, here)?.pathname).toBe('/guide');
  });
});
