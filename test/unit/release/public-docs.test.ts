// The public tree stands on its own: every relative Markdown link resolves inside the export (a private request is
// summarized, never linked), and each public entry document gives the same first-run path and the same three facts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITE_EN, SITE_ZH } from '../../../src/ui/site/copy-site';
import { APP_EN, APP_ZH } from '../../../src/ui/copy';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** Relative link targets of a Markdown text, with their line, ignoring fenced blocks and inline code. */
function relativeLinks(text: string): { line: number; target: string }[] {
  const out: { line: number; target: string }[] = [];
  let fenced = false;
  text.split('\n').forEach((raw, i) => {
    if (/^\s*```/.test(raw)) fenced = !fenced;
    if (fenced) return;
    for (const m of raw.replace(/`[^`]*`/g, '``').matchAll(LINK)) {
      const target = m[1]!;
      if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#')) out.push({ line: i + 1, target });
    }
  });
  return out;
}

describe('relativeLinks', () => {
  it('finds file and image links, and skips URLs, in-page anchors, inline code and fenced blocks', () => {
    const text = ['[a](./a.md) ![b](b.png "t") [c](https://x.example) [d](#d)', '`[e](e.md)`', '```', '[f](f.md)', '```', '[g](<g h.md>)'].join('\n');
    expect(relativeLinks(text).map((l) => l.target)).toEqual(['./a.md', 'b.png']);
  });
});

describe('the exported public tree', () => {
  let parent: string;
  let out: string;
  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), 'cbpr-public-docs-'));
    out = join(parent, 'public');
    execFileSync(process.execPath, [join(ROOT, 'scripts/release/export.mjs'), out, '--force'], { cwd: ROOT, stdio: 'pipe' });
  });
  afterAll(() => rmSync(parent, { recursive: true, force: true }));

  it('has no relative Markdown link that leaves or misses the export', () => {
    const md = readdirSync(out, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.md')).map((d) => join(d.parentPath, d.name));
    expect(md.length).toBeGreaterThan(0);
    const broken: string[] = [];
    for (const file of md) {
      for (const { line, target } of relativeLinks(readFileSync(file, 'utf8'))) {
        const abs = resolve(dirname(file), decodeURIComponent(target.split('#')[0]!));
        const inside = abs === out || abs.startsWith(out + sep);
        if (!inside || !existsSync(abs)) broken.push(`${relative(out, file)}:${line} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('public entry documents', () => {
  const docs = ['README.md', 'README.zh-TW.md', 'docs/INSTALL.md', 'docs/INSTALL.zh-TW.md'];

  it.each(docs)('%s gives clone, the pinned tools, the build, the runner and the local package path', (name) => {
    const text = readFileSync(join(ROOT, name), 'utf8');
    for (const step of ['git clone https://github.com/sd0xdev/passkey-recovery.git', 'nvm install 24.22.1', 'npm install -g npm@11.19.1', 'npm ci', 'npm run build', 'npm run runner', 'npm pack', 'npm exec --yes --package ./passkey-recovery-']) expect(text, step).toContain(step);
    const order = ['git clone', 'nvm install', 'npm ci', 'npm run runner', 'npm pack'].map((s) => text.indexOf(s));
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it.each(['README.md', 'docs/INSTALL.md'])('%s keeps the three publication facts apart', (name) => {
    const text = readFileSync(join(ROOT, name), 'utf8');
    expect(text).toMatch(/source code is public/i);
    expect(text).toMatch(/no (tag, )?GitHub Release/i);
    expect(text).toMatch(/website is live/i);
    expect(text).toContain('https://passkey-recovery.sd0x.dev');
    expect(text).not.toContain('welfree-studio.workers.dev');
    expect(text).not.toMatch(/website is not deployed/i);
    expect(text).not.toMatch(/repository (and its \w+ ?\w* )?(is|are) not (published|public)/i);
  });

  it.each(['README.zh-TW.md', 'docs/INSTALL.zh-TW.md'])('%s keeps the three publication facts apart', (name) => {
    const text = readFileSync(join(ROOT, name), 'utf8');
    expect(text).toContain('原始碼已公開');
    expect(text).toMatch(/沒有.*GitHub Release/);
    expect(text).toContain('網站已上線');
    expect(text).toContain('https://passkey-recovery.sd0x.dev');
    expect(text).not.toContain('welfree-studio.workers.dev');
    expect(text).not.toContain('網站尚未部署');
    expect(text).not.toMatch(/repository.*(還沒有|尚未)(發布|公開)/);
  });

  it('no page copy says the repository is unpublished, in either language', () => {
    const all = [...Object.values(SITE_EN), ...Object.values(SITE_ZH), ...Object.values(APP_EN), ...Object.values(APP_ZH)].join('\n');
    // The same pages are what the website serves, so they never call the website undeployed.
    expect(all).not.toMatch(/website is not deployed|Not deployed yet\.|網站也?尚未部署|尚未部署。請使用/);
    expect(all).not.toMatch(/repository (is|are) not public|once the repository is public|the folder you already have|repository 尚未公開|repository 公開之後|你已有的資料夾|downloaded package|存放下載套件|下載的套件/i);
  });
});

describe('website deploy configuration', () => {
  // Every comment in wrangler.jsonc is a whole line; a comment after a value would fail this parse, loudly.
  const config = JSON.parse(readFileSync(join(ROOT, 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

  it('wrangler.jsonc binds exactly the official custom domain → a later deploy keeps it', () => {
    expect(config.routes).toEqual([{ pattern: 'passkey-recovery.sd0x.dev', custom_domain: true }]);
  });

  it('wrangler.jsonc keeps workers.dev on, preview URLs off and no server side → the site stays static', () => {
    expect(config.workers_dev).toBe(true);
    expect(config.preview_urls).toBe(false);
    expect(config.main).toBeUndefined();
  });
});
