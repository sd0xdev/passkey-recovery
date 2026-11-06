#!/usr/bin/env node
// Lab measurement of the Home page (6-recovery-atlas.md §5.2, PERF-1): LCP and CLS over 3 cold loads per viewport
// with the median, and long tasks (> 50 ms) while the hero story plays. A lab number on this machine, not field
// data. Point it at any local origin serving the built UI (no network beyond it):
//   node scripts/design/perf-home.mjs http://127.0.0.1:4171
import { chromium } from '@playwright/test';

const base = process.argv[2];
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) {
  console.error('usage: perf-home.mjs http://127.0.0.1:<port>');
  process.exit(2);
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const browser = await chromium.launch();
const out = {};
for (const [name, width, height] of [['desktop-1440', 1440, 900], ['mobile-390', 390, 844]]) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.__perf = { lcp: 0, cls: 0, long: [] };
      new PerformanceObserver((l) => l.getEntries().forEach((e) => (window.__perf.lcp = e.startTime))).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => !e.hadRecentInput && (window.__perf.cls += e.value))).observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__perf.long.push([Math.round(e.startTime), Math.round(e.duration)]))).observe({ type: 'longtask', buffered: true });
    });
    await page.goto(`${base}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);
    // LCP is final at the first input; read it, then play the story and collect long tasks during it.
    const atLoad = await page.evaluate(() => ({ lcp: window.__perf.lcp, cls: window.__perf.cls, longAtLoad: window.__perf.long.length }));
    const t0 = await page.evaluate(() => performance.now());
    await page.getByTestId('atlas-play').click();
    await page.waitForTimeout(10_500);
    const after = await page.evaluate((t) => ({ cls: window.__perf.cls, longDuringPlay: window.__perf.long.filter(([s]) => s >= t) }), t0);
    runs.push({ lcpMs: Math.round(atLoad.lcp), cls: Number(after.cls.toFixed(4)), longTasksAtLoad: atLoad.longAtLoad, longTasksDuringPlay: after.longDuringPlay });
    await ctx.close();
  }
  out[name] = { runs, median: { lcpMs: median(runs.map((r) => r.lcpMs)), cls: median(runs.map((r) => r.cls)) } };
}
await browser.close();
console.log(JSON.stringify({ kind: 'lab', base, at: new Date().toISOString(), ...out }, null, 2));
