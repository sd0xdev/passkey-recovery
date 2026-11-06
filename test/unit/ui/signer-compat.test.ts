// The page and the runner's native signer must speak the same contract (src/config/signerApi.ts). A signer started
// before an update answers without `api` (or lacks an endpoint): the page says to restart / update the runner.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SIGNER_API } from '../../../src/config/signerApi';
import { ApiError, setSignerBase, signerApi } from '../../../src/ui/api';
import { signerCompat } from '../../../src/ui/gas/useGasPayer';

describe('signerCompat', () => {
  it('the same contract → ok; none answered yet → null', () => {
    expect(signerCompat({ api: SIGNER_API })).toBe('ok');
    expect(signerCompat(null)).toBeNull();
  });
  it('a status without `api` (a signer from before version 2) → runner-older', () => {
    expect(signerCompat({})).toBe('runner-older');
    expect(signerCompat({ api: SIGNER_API - 1 })).toBe('runner-older');
  });
  it('a newer signer → runner-newer; a malformed `api` counts as version 1', () => {
    expect(signerCompat({ api: SIGNER_API + 1 })).toBe('runner-newer');
    expect(signerCompat({ api: 2.5 })).toBe('runner-older');
    expect(signerCompat({ api: '2' as unknown as number })).toBe('runner-older');
  });
});

describe('signerApi: an endpoint the signer does not know', () => {
  const answer = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  afterEach(() => {
    setSignerBase(null);
    vi.unstubAllGlobals();
  });
  const at = (status: number, body: unknown) => {
    vi.stubGlobal('document', { querySelector: () => ({ getAttribute: () => 'synthetic-session' }) });
    vi.stubGlobal('fetch', vi.fn(async () => answer(status, body)));
    setSignerBase('http://127.0.0.1:4178');
  };
  it('404 without a class (an older signer) → runner-outdated, not the raw "unknown endpoint"', async () => {
    at(404, { error: 'unknown endpoint' });
    const e = await signerApi('/gas/keystore/unlock').catch((x: unknown) => x);
    expect([e instanceof ApiError, (e as ApiError).status, (e as ApiError).code]).toEqual([true, 404, 'runner-outdated']);
  });
  it('a classed 4xx keeps its own class; a 409 without one stays unclassed', async () => {
    at(400, { error: 'bad path', kind: 'keystore-path' });
    expect(((await signerApi('/gas/keystore/unlock').catch((x: unknown) => x)) as ApiError).code).toBe('keystore-path');
    at(409, { error: 'busy' });
    expect(((await signerApi('/gas/keystore/unlock').catch((x: unknown) => x)) as ApiError).code).toBeNull();
  });
});
