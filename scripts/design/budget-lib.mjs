// The Home page byte budgets of 6-recovery-atlas.md §5.2 (PERF-1), as a pure check over a built `dist/`.
// Baseline: the last pre-Atlas build (entry index-BRvm_6pv.js, 2026-11-02), measured with `gzip -9`.

export const BASE = Object.freeze({ entryJsGzip: 119_739, entryCssGzip: 7_143 });
export const LIMITS = Object.freeze({ addedJsGzip: 30 * 1024, visualBytes: 200 * 1024 });
/** The fonts the pre-Atlas build shipped: five faces × latin/latin-ext, each as woff2 and woff. */
export const BASE_FONTS = Object.freeze(
  ['mono-latin-400', 'mono-latin-700', 'mono-latin-ext-400', 'mono-latin-ext-700', 'next-latin-400', 'next-latin-700', 'next-latin-800', 'next-latin-ext-400', 'next-latin-ext-700', 'next-latin-ext-800']
    .flatMap((f) => [`atkinson-hyperlegible-${f}-normal.woff2`, `atkinson-hyperlegible-${f}-normal.woff`])
    .sort(),
);

/** `atkinson-…-400-normal-CBw-mJf_.woff2` → `atkinson-…-400-normal.woff2` (drops Vite's 8-char content hash). */
export const fontName = (file) => file.replace(/-[A-Za-z0-9_-]{8}\.(woff2?)$/, '.$1');

/**
 * @param {{ entryJsGzip: number, visualBytes: number, fonts: string[] }} m measured on the build
 * @returns {{ ok: boolean, addedJsGzip: number, visualBytes: number, addedFonts: string[], failures: string[] }}
 */
export function checkBudget(m) {
  const addedJsGzip = m.entryJsGzip - BASE.entryJsGzip;
  const addedFonts = [...new Set(m.fonts.map(fontName))].filter((f) => !BASE_FONTS.includes(f)).sort();
  const failures = [];
  if (addedJsGzip > LIMITS.addedJsGzip) failures.push(`home JS grew ${addedJsGzip} B gzip (limit ${LIMITS.addedJsGzip})`);
  if (m.visualBytes > LIMITS.visualBytes) failures.push(`original visuals are ${m.visualBytes} B (limit ${LIMITS.visualBytes})`);
  if (addedFonts.length) failures.push(`fonts added: ${addedFonts.join(', ')}`);
  return { ok: failures.length === 0, addedJsGzip, visualBytes: m.visualBytes, addedFonts, failures };
}
