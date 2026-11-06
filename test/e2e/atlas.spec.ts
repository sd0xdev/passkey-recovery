// Home atlas (6-recovery-atlas.md §2–§5; ART-1..5, MOT-1..2): the station never moves between plates, the plates
// are driven by labelled buttons and the caption is the content, the story plays only on request and stops when
// the page is hidden or the plate leaves view, reduced motion has no motion, the first viewport holds the CTA,
// the phone header is one row with a Menu, axe is clean at 390/768/1440, and the demo stills load from the runner.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { E2E_HOSTED, E2E_RUNNER } from '../support/e2e-constants';

async function open(browser: Browser, width: number, opts: { reducedMotion?: 'reduce' | 'no-preference'; base?: string } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height: width <= 390 ? 844 : 900 }, reducedMotion: opts.reducedMotion ?? 'no-preference' });
  const page = await ctx.newPage();
  await page.goto(`${opts.base ?? E2E_HOSTED}/`);
  return { page, ctx };
}
const master = (page: Page) => page.getByTestId('atlas-master');
const station = (page: Page) => master(page).locator('[data-testid="atlas-station"]:visible');

test('the station keeps its exact place on plates I, II and III (wide and tall)', async ({ browser }) => {
  for (const width of [1440, 390]) {
    const { page, ctx } = await open(browser, width, { reducedMotion: 'reduce' });
    await master(page).scrollIntoViewIfNeeded();
    const boxes = [];
    for (const s of [0, 1, 2] as const) {
      await page.getByTestId(`atlas-shot-${s}`).click();
      await expect(master(page)).toHaveAttribute('data-shot', String(s));
      boxes.push(await station(page).boundingBox());
    }
    // Shot 3 (the funds moved out) has no button of its own: under reduced motion Play steps to it from shot 2.
    await page.getByTestId('atlas-play').click();
    await expect(master(page)).toHaveAttribute('data-shot', '3');
    boxes.push(await station(page).boundingBox());
    expect(boxes[0], `${width}`).not.toBeNull();
    for (const [i, b] of boxes.entries()) expect(b, `${width} shot ${i}`).toEqual(boxes[0]);
    await ctx.close();
  }
});

test('static plates I–III: same station and funds on each; dashed → solid structure, hatching and callouts as the plate says', async ({ browser }) => {
  const { page, ctx } = await open(browser, 1440, { reducedMotion: 'reduce' });
  const plates = page.getByTestId('atlas-plates').locator('svg[data-shot]');
  await expect(plates).toHaveCount(3);
  const read = await plates.evaluateAll((svgs) =>
    svgs.map((svg) => {
      const op = (sel: string) => [...svg.querySelectorAll(sel)].map((e) => getComputedStyle(e).opacity);
      const ring = svg.querySelector('.lb-at-ring')!;
      return {
        shot: svg.getAttribute('data-shot'),
        station: [ring.getAttribute('cx'), ring.getAttribute('cy')],
        cargo: [...svg.querySelectorAll('.lb-at-cargo')].map((r) => ['x', 'y', 'width', 'height'].map((a) => r.getAttribute(a)).join(',')),
        planned: op('.lb-at-planned'), built: op('.lb-at-built'), hatch: op('.lb-at-hatch'), notes: op('.lb-at-note'), builtNote: op('.lb-at-builtnote'),
      };
    }),
  );
  expect(read.map((r) => r.shot)).toEqual(['0', '1', '2']);
  // The mechanism: the address and the funds on it are the same on every plate.
  for (const r of read.slice(1)) {
    expect(r.station, `plate ${r.shot} station`).toEqual(read[0]!.station);
    expect(r.cargo, `plate ${r.shot} funds`).toEqual(read[0]!.cargo);
  }
  expect(read[0]!.cargo).toHaveLength(3);
  // I: planned (dashed) only, no callouts. II: still dashed, the three checks open. III: deployed (solid, hatched).
  expect(read.map((r) => [r.planned[0], r.built[0], r.hatch[0], r.builtNote[0]])).toEqual([['1', '0', '0', '0'], ['1', '0', '0', '0'], ['0', '1', '1', '1']]);
  expect(read.map((r) => r.notes)).toEqual([['0', '0', '0'], ['1', '1', '1'], ['1', '1', '1']]);
  await ctx.close();
});

test('keyboard: the plate buttons are pressed one at a time and the caption says what the plate shows', async ({ browser }) => {
  const { page, ctx } = await open(browser, 1440);
  const caption = page.getByTestId('atlas-caption');
  await expect(caption).toHaveAttribute('aria-live', 'polite');
  await expect(caption).toContainText('I. Funds sit at your address');
  await page.getByTestId('atlas-shot-1').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('atlas-shot-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('atlas-shot-0')).toHaveAttribute('aria-pressed', 'false');
  await expect(caption).toContainText('These are checks, not results.');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('atlas-shot-2')).toHaveAttribute('aria-pressed', 'true');
  await expect(caption).toContainText('nothing was transferred');
  // The plate is decoration; its words are in HTML.
  await expect(page.locator('.lb-at-plate').first()).toHaveAttribute('aria-hidden', 'true');
  await ctx.close();
});

test('Play tells the whole story once (I → III, then the transfer note) and stops; Pause holds the plate', async ({ browser }) => {
  test.setTimeout(60_000);
  const { page, ctx } = await open(browser, 1440);
  await expect(master(page)).toHaveAttribute('data-shot', '0');
  await page.waitForTimeout(2500);
  await expect(master(page), 'nothing plays by itself').toHaveAttribute('data-shot', '0');
  await page.getByTestId('atlas-play').click();
  await expect(master(page)).toHaveAttribute('data-playing', 'true');
  await expect(master(page)).toHaveAttribute('data-shot', '1', { timeout: 4000 });
  await page.getByTestId('atlas-pause').click();
  await expect(master(page)).toHaveAttribute('data-playing', 'false');
  await page.waitForTimeout(3500);
  await expect(master(page)).toHaveAttribute('data-shot', '1');
  await page.getByTestId('atlas-play').click();
  await expect(master(page)).toHaveAttribute('data-shot', '3', { timeout: 9000 });
  await expect(page.getByTestId('atlas-caption')).toContainText('you approve each one yourself');
  await expect(master(page)).toHaveAttribute('data-playing', 'false', { timeout: 4000 });
  await page.waitForTimeout(1500);
  await expect(master(page), 'no loop').toHaveAttribute('data-shot', '3');
  await page.getByTestId('atlas-replay').click();
  await expect(master(page)).toHaveAttribute('data-shot', '0');
  await ctx.close();
});

test('hidden page or plate out of view: the story pauses and does not resume by itself', async ({ browser }) => {
  const { page, ctx } = await open(browser, 1440);
  await page.getByTestId('atlas-play').click();
  await expect(master(page)).toHaveAttribute('data-playing', 'true');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(master(page)).toHaveAttribute('data-playing', 'false');
  const held = await master(page).getAttribute('data-shot');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(2500);
  await expect(master(page)).toHaveAttribute('data-shot', held!);
  // Out of view.
  await page.getByTestId('atlas-play').click();
  await expect(master(page)).toHaveAttribute('data-playing', 'true');
  await page.locator('#faq').scrollIntoViewIfNeeded();
  await expect(master(page)).toHaveAttribute('data-playing', 'false');
  await ctx.close();
});

test('reduced motion: no entrance and no transitions; Play steps one plate per press; the static plates are all there', async ({ browser }) => {
  const { page, ctx } = await open(browser, 1440, { reducedMotion: 'reduce' });
  const motion = await page.evaluate(() => {
    const ring = document.querySelector('.lb-at-wide .lb-at-ring')!;
    const reg = document.querySelector('.lb-at-wide .lb-at-reg')!;
    const btn = document.querySelector('[data-testid="atlas-shot-1"]')!;
    return [getComputedStyle(ring).animationName, getComputedStyle(reg).transitionDuration, getComputedStyle(btn).transitionDuration];
  });
  expect(motion, 'ring animation, plate transition, control transition').toEqual(['none', '0s', '0s']);
  const play = page.getByTestId('atlas-play');
  await expect(play).toHaveText('Next plate');
  await play.click();
  await expect(master(page)).toHaveAttribute('data-shot', '1');
  await expect(master(page)).toHaveAttribute('data-playing', 'false');
  await play.click();
  await expect(master(page)).toHaveAttribute('data-shot', '2');
  await expect(page.getByTestId('atlas-plates').locator('svg[data-shot]')).toHaveCount(3);
  await ctx.close();
});

test('first viewport: the title, the Check CTA and the scope line are visible at 390, 768 and 1440 in EN and 繁中', async ({ browser }) => {
  for (const width of [390, 768, 1440]) {
    for (const lang of ['en', 'zh'] as const) {
      const { page, ctx } = await open(browser, width);
      if (lang === 'zh') await page.getByTestId('lang-toggle').click();
      await expect(page.getByTestId('home-cta-tool')).toHaveText(lang === 'en' ? 'Check your wallet' : '檢查錢包');
      for (const id of ['page-title', 'home-cta-tool', 'home-limits']) {
        const el = id === 'page-title' ? page.locator('#page-title') : page.getByTestId(id);
        await expect(el, `${width} ${lang} ${id}`).toBeInViewport({ ratio: 1 });
      }
      await ctx.close();
    }
  }
});

test('phone header: one row (brand, Menu, language, the tool); Menu opens the pages, Escape and navigation close it', async ({ browser }) => {
  const { page, ctx } = await open(browser, 390);
  // One row: the three share a horizontal centre line (their heights differ).
  const row = async (lang: string) => {
    const mids = await Promise.all(['nav-home', 'nav-menu', 'lang-toggle', 'nav-recover'].map(async (id) => ((b) => b.y + b.height / 2)((await page.getByTestId(id).boundingBox())!)));
    expect(Math.max(...mids) - Math.min(...mids), `one row (${lang}): ${mids}`).toBeLessThan(4);
  };
  await row('en');
  await page.getByTestId('lang-toggle').click();
  await row('zh');
  await page.getByTestId('lang-toggle').click();
  const menu = page.getByTestId('nav-menu');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('nav-guide')).toBeHidden();
  // The language is never behind the Menu.
  await expect(page.getByTestId('lang-toggle')).toBeInViewport({ ratio: 1 });
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('nav-guide')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await menu.click();
  await page.getByTestId('nav-security').click();
  await expect(page.getByTestId('nav-security')).toHaveAttribute('aria-current', 'page');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  // Wide screens: no Menu, the pages are always there.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(menu).toBeHidden();
  await expect(page.getByTestId('nav-guide')).toBeVisible();
  await ctx.close();
});

test('Home axe-clean at 390, 768 and 1440 with the menu open and on plate II, EN and 繁中', async ({ browser }) => {
  test.setTimeout(120_000);
  for (const width of [390, 768, 1440]) {
    const { page, ctx } = await open(browser, width);
    for (const lang of ['en', 'zh'] as const) {
      if (width <= 768) await page.getByTestId('nav-menu').click();
      if (lang === 'zh') await page.getByTestId('lang-toggle').click();
      await page.getByTestId('atlas-shot-1').click();
      await page.waitForTimeout(300); // past the 150 ms press feedback, so contrast is measured at rest
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
      expect(r.violations.map((v) => `${width} ${lang}: ${v.id} ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
      if (width <= 768) await page.keyboard.press('Escape');
    }
    await ctx.close();
  }
});

test('trust boundary (§3 section 4) in EN and 繁中: four regions, the runner and the native signer as two blocks inside Your computer, four channels, keys.coinbase.com named', async ({ browser }) => {
  const { page, ctx } = await open(browser, 1440, { reducedMotion: 'reduce' });
  const map = page.getByTestId('atlas-boundary');
  for (const lang of ['en', 'zh'] as const) {
    if (lang === 'zh') await page.getByTestId('lang-toggle').click();
    await expect(map.locator('[data-region]'), lang).toHaveCount(4);
    expect(await map.locator('[data-region]').evaluateAll((els) => els.map((e) => e.getAttribute('data-region')))).toEqual(['site', 'computer', 'keys', 'chain']);
    const blocks = map.locator('[data-region="computer"] [data-block]');
    expect(await blocks.evaluateAll((els) => els.map((e) => e.getAttribute('data-block'))), lang).toEqual(['runner', 'signer']);
    await expect(map.locator('.lb-at-channels li'), lang).toHaveCount(4);
    await expect(map.locator('[data-region="keys"] h3'), lang).toContainText('keys.coinbase.com');
    await expect(map.locator('[data-region="computer"] h3'), lang).toHaveText(lang === 'en' ? 'Your computer' : '你的電腦');
  }
  await ctx.close();
});

test('demo stills: four labelled synthetic screenshots that load from the runner too (image/webp), one at a time', async ({ browser }) => {
  const { page, ctx } = await open(browser, 1440, { base: E2E_RUNNER });
  const types: string[] = [];
  page.on('response', (r) => r.url().endsWith('.webp') && types.push(`${r.status()} ${r.headers()['content-type']}`));
  const demo = page.getByTestId('atlas-demo');
  await demo.scrollIntoViewIfNeeded();
  // Every still carries the tag; stepping through shows and loads each one in turn.
  await expect(demo.locator('figcaption').filter({ hasText: 'Demo, synthetic data' })).toHaveCount(4);
  for (const k of ['check', 'deploy', 'approve', 'track']) {
    await page.getByTestId(`demo-step-${k}`).click();
    await expect(demo.locator(`#demo-${k} img`)).toBeVisible();
    await expect.poll(() => demo.locator(`#demo-${k} img`).evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBe(960);
  }
  expect(types).toEqual(Array(4).fill('200 image/webp'));
  for (const alt of await demo.locator('img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('alt') ?? ''))) expect(alt.length).toBeGreaterThan(40);
  await ctx.close();
});

test('reflow at 720 CSS px (the 200% zoom proxy of 1440×900) in EN and 繁中: the Check CTA and the plate controls reachable by scrolling down, nothing scrolls sideways', async ({ browser }) => {
  for (const lang of ['en', 'zh'] as const) {
    const ctx = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${E2E_HOSTED}/`);
    if (lang === 'zh') await page.getByTestId('lang-toggle').click();
    // 450 CSS px tall: reachable by scrolling down (WCAG 1.4.10), not necessarily in the first screen.
    await expect(page.getByTestId('home-cta-tool')).toHaveText(lang === 'en' ? 'Check your wallet' : '檢查錢包');
    expect(await page.evaluate(() => document.documentElement.scrollWidth), lang).toBeLessThanOrEqual(720);
    await page.getByTestId('home-cta-tool').click();
    await expect(page, lang).toHaveURL(`${E2E_HOSTED}/recover`);
    await page.goBack();
    await page.getByTestId('atlas-shot-2').scrollIntoViewIfNeeded();
    await page.getByTestId('atlas-shot-2').click();
    await expect(master(page)).toHaveAttribute('data-shot', '2');
    await ctx.close();
  }
});

test('while the story plays the Check CTA still works, and leaving Home stops the story (no shot changes after)', async ({ browser }) => {
  const { page, ctx } = await open(browser, 1440);
  await page.getByTestId('atlas-play').click();
  await expect(master(page)).toHaveAttribute('data-playing', 'true');
  await page.getByTestId('home-cta-tool').click();
  await expect(page).toHaveURL(`${E2E_HOSTED}/recover`);
  // Back on Home the story is at rest on plate I: no timer of the earlier play advanced it while away.
  await page.waitForTimeout(2500);
  await page.goBack();
  await expect(master(page)).toHaveAttribute('data-playing', 'false');
  await expect(master(page)).toHaveAttribute('data-shot', '0');
  await ctx.close();
});
