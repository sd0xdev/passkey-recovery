// Hosted static website headers (HOST-01/02): the local CSP plus loopback-runner connect, nothing looser.
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, hostedContentSecurityPolicy, hostedHeadersFile } from '../../../server/http';

describe('hosted CSP', () => {
  it('adds only http://127.0.0.1:* to connect-src; every other directive equals the local CSP', () => {
    const local = contentSecurityPolicy().split('; ');
    const hosted = hostedContentSecurityPolicy().split('; ');
    expect(hosted.find((d) => d.startsWith('connect-src'))).toBe("connect-src 'self' https://rpc.plasma.to http://127.0.0.1:*");
    expect(hosted.filter((d) => !d.startsWith('connect-src'))).toEqual(local.filter((d) => !d.startsWith('connect-src')));
  });
  it('keeps script-src and style-src self-only (no inline, no remote)', () => {
    const csp = hostedContentSecurityPolicy();
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("style-src 'self';");
    expect(csp).not.toMatch(/unsafe-|\*\.|https?:\/\/(?!rpc\.plasma\.to|127\.0\.0\.1:\*)/);
  });
  it('_headers applies the policy to every path with the hardening headers', () => {
    const f = hostedHeadersFile();
    expect(f.split('\n')[0]).toBe('/*');
    for (const h of ['Content-Security-Policy', 'Referrer-Policy: no-referrer', 'X-Content-Type-Options: nosniff', 'Cross-Origin-Opener-Policy: same-origin', 'frame-ancestors \'none\'']) expect(f).toContain(h);
  });
});
