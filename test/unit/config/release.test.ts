// The release identity shown on the Download page and in the runner help: one version, one tarball name, one repository.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pairableOrigin, RELEASE_PAGE_URL, RELEASE_TAG, REPO_URL, runnerCommand, TARBALL, TARBALL_URL, VERSION } from '../../../src/config/release';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string; private?: boolean; bin: Record<string, string>; repository: { url: string } };

describe('release constants', () => {
  it('follow package.json', () => {
    expect(VERSION).toBe(pkg.version);
    expect(TARBALL).toBe(`${pkg.name}-${pkg.version}.tgz`);
    expect(RELEASE_TAG).toBe(`v${pkg.version}`);
    expect(pkg.repository.url).toBe(`git+${REPO_URL}.git`);
    expect(RELEASE_PAGE_URL).toBe(`${REPO_URL}/releases/tag/v${pkg.version}`);
    expect(TARBALL_URL).toBe(`${REPO_URL}/releases/download/v${pkg.version}/${TARBALL}`);
  });

  it('the package cannot be published to the npm registry by accident', () => {
    expect(pkg.private).toBe(true);
  });

  it('runnerCommand starts the bin from the local tarball, with an origin only when given', () => {
    expect(Object.keys(pkg.bin)).toEqual(['passkey-recovery']);
    expect(runnerCommand()).toBe(`npm exec --yes --package ./${TARBALL} -- passkey-recovery`);
    expect(runnerCommand('https://site.example')).toBe(`npm exec --yes --package ./${TARBALL} -- passkey-recovery --allow-origin https://site.example`);
  });

  it('pairableOrigin: only an exact https origin is offered as --allow-origin; an http page (a local preview) never is', () => {
    expect(pairableOrigin('https://passkey-recovery.example')).toBe('https://passkey-recovery.example');
    for (const o of ['http://127.0.0.1:4171', 'http://127.0.0.1:4181', 'http://localhost:5173', 'http://site.example']) expect(pairableOrigin(o), o).toBeUndefined();
    expect(runnerCommand(pairableOrigin('http://127.0.0.1:4181'))).not.toContain('--allow-origin');
  });
});
