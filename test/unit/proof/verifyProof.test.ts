// AC03 — proof-of-control with SYNTHETIC WebAuthn data (tech spec §3.4, 4-test-acceptance §2).
import { describe, expect, it } from 'vitest';
import { bytesToBase64url, base64urlToBytes } from '../../../src/crypto/bytes';
import { createProofSession, type ProofSession } from '../../../src/proof/challenge';
import { verifyProof } from '../../../src/proof/verifyProof';
import { bytesToHex } from '../../../src/crypto/bytes';
import { DEP, SRC_A } from '../../fixtures/accounts';
import { buildAssertion, syntheticKey, withField } from '../../fixtures/synthetic';

const T0 = new Date('2026-10-31T03:00:00.000Z');
const fixedRandom = (n: number) => new Uint8Array(n).fill(7);
const key = syntheticKey();
const SUBJECT = { account: SRC_A, chainId: DEP.chainId, ownerIndex: 2, rpId: DEP.rp.id, origin: DEP.rp.origin };
const session: ProofSession = createProofSession(SUBJECT, T0, fixedRandom);
const at = (ms: number) => new Date(T0.getTime() + ms);
const owner = (pub = key.publicKeyXY, index = 2) => ({ index, publicKey: bytesToHex(pub) });
const verify = (json: string, now = at(60_000), pub = key.publicKeyXY) => verifyProof(session, json, owner(pub), now);
const failed = (r: ReturnType<typeof verify>) => r.checks.filter((c) => !c.ok).map((c) => c.id);

describe('proof-of-control: valid synthetic case', () => {
  it('accepts a correct assertion inside the window', () => {
    const r = verify(buildAssertion({ challenge: session.challenge }).json);
    expect(r.status).toBe('valid');
    expect(r.checks.map((c) => c.id)).toEqual(['format', 'type', 'challenge', 'origin', 'rpIdHash', 'flags', 'signature']);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(r.expiry.ok).toBe(true);
  });

  it('regression: the signature check names the owner the statement is about, not a fixed owner 0', () => {
    const ok = verify(buildAssertion({ challenge: session.challenge }).json);
    expect(ok.checks.find((c) => c.id === 'signature')!.detail).toBe('valid for owner 2 public key');
    const bad = verify(buildAssertion({ challenge: session.challenge, key: syntheticKey(0x22) }).json);
    expect(bad.checks.find((c) => c.id === 'signature')!.detail).toBe('does not verify against owner 2 public key');
  });

  it('accepts high-s signatures (WebAuthn allows them; export normalizes)', () => {
    const r = verify(buildAssertion({ challenge: session.challenge, highS: true }).json);
    expect(r.status).toBe('valid');
    expect(r.checks.find((c) => c.id === 'signature')!.detail).toContain('high-s');
  });

  it('accepts the exact window boundaries', () => {
    const json = buildAssertion({ challenge: session.challenge }).json;
    expect(verify(json, session.issuedAt).status).toBe('valid');
    expect(verify(json, session.expiresAt).status).toBe('valid');
  });
});

describe('proof-of-control: mismatches', () => {
  it('wrong owner: signed by a different key', () => {
    const r = verify(buildAssertion({ challenge: session.challenge, key: syntheticKey(0x22) }).json);
    expect(r.status).toBe('mismatch');
    expect(failed(r)).toEqual(['signature']);
  });

  it('the key must be the owner the statement names: another index is refused before any crypto', () => {
    const r = verifyProof(session, buildAssertion({ challenge: session.challenge }).json, owner(key.publicKeyXY, 0), at(1000));
    expect(r.status).toBe('mismatch');
    expect(failed(r)).toEqual(['owner-index']);
  });

  it('an address (non-Passkey) owner cannot carry a proof', () => {
    const r = verifyProof(session, buildAssertion({ challenge: session.challenge }).json, { index: 2, publicKey: `0x${'00'.repeat(12)}${'ab'.repeat(20)}` }, at(1000));
    expect(failed(r)).toEqual(['owner-kind']);
  });

  it('the statement names the account, chain and owner index it is for', () => {
    expect(session.statement).toContain(`account: ${SRC_A}`);
    expect(session.statement).toContain('ownerIndex: 2');
    expect(session.statement).toContain('authorizes nothing');
  });

  it('wrong challenge: assertion from another session', () => {
    const other = createProofSession(SUBJECT, T0, (n: number) => new Uint8Array(n).fill(8));
    const r = verify(buildAssertion({ challenge: other.challenge }).json);
    expect(r.status).toBe('mismatch');
    expect(failed(r)).toEqual(['challenge']);
  });

  it('challenge with padding is not accepted as equal', () => {
    const b = buildAssertion({ challenge: session.challenge, clientDataExtra: { challenge: bytesToBase64url(session.challenge) + '=' } });
    expect(failed(verify(b.json))).toContain('challenge');
  });

  it.each(['https://evil.example', 'http://localhost:4173', 'https://keys.coinbase.com.evil.example', 'http://keys.coinbase.com'])(
    'wrong origin %s',
    (origin) => {
      const r = verify(buildAssertion({ challenge: session.challenge, origin }).json);
      expect(r.status).toBe('mismatch');
      expect(failed(r)).toEqual(['origin']);
    },
  );

  it('crossOrigin true or topOrigin present', () => {
    for (const extra of [{ crossOrigin: true }, { topOrigin: 'https://evil.example' }]) {
      const r = verify(buildAssertion({ challenge: session.challenge, clientDataExtra: extra }).json);
      expect(failed(r)).toEqual(['origin']);
    }
  });

  it('wrong RP: rpIdHash of localhost', () => {
    const r = verify(buildAssertion({ challenge: session.challenge, rpId: 'localhost' }).json);
    expect(r.status).toBe('mismatch');
    expect(failed(r)).toEqual(['rpIdHash']);
  });

  it.each([
    ['missing UP', 0x04],
    ['missing UV', 0x01],
    ['AT set', 0x45],
  ])('flags: %s', (_, flags) => {
    const r = verify(buildAssertion({ challenge: session.challenge, flags }).json);
    expect(r.status).toBe('mismatch');
    expect(failed(r)).toEqual(['flags']);
  });

  it('type webauthn.create', () => {
    const r = verify(buildAssertion({ challenge: session.challenge, type: 'webauthn.create' }).json);
    expect(failed(r)).toEqual(['type']);
  });
});

describe('proof-of-control: expiry', () => {
  const json = buildAssertion({ challenge: session.challenge }).json;
  it('after expiresAt → expired', () => expect(verify(json, at(10 * 60 * 1000 + 1)).status).toBe('expired'));
  it('before issuedAt → expired', () => expect(verify(json, at(-1)).status).toBe('expired'));
  it('mismatch takes precedence over expiry', () => {
    const bad = buildAssertion({ challenge: session.challenge, origin: 'https://evil.example' }).json;
    expect(verify(bad, at(11 * 60 * 1000)).status).toBe('mismatch');
  });
  it('session TTL is 10 minutes', () => expect(session.expiresAt.getTime() - session.issuedAt.getTime()).toBe(600_000));
});

describe('proof-of-control: format errors', () => {
  const good = buildAssertion({ challenge: session.challenge });
  it.each([
    ['not JSON', 'hello'],
    ['array', '[]'],
    ['null', 'null'],
    ['extra field', withField(good, 'privateKey', 'x')],
    ['wrong format tag', withField(good, 'format', 'v0')],
    ['kind userop', withField(good, 'kind', 'userop')],
    ['padded base64', withField(good, 'signature', good.fields.signature + '=')],
    ['standard alphabet', withField(good, 'clientDataJSON', 'ab+/')],
    ['short authenticatorData', withField(good, 'authenticatorData', bytesToBase64url(new Uint8Array(36)))],
    ['oversized', JSON.stringify({ ...good.fields, credentialId: 'A'.repeat(20000) })],
    ['clientDataJSON not JSON', withField(good, 'clientDataJSON', bytesToBase64url(new TextEncoder().encode('nope')))],
    ['DER garbage', withField(good, 'signature', bytesToBase64url(Uint8Array.of(0x30, 0x02, 0x01, 0x01)))],
  ])('%s', (_, json) => {
    expect(verify(json).status).toBe('format-error');
  });

  it('missing field', () => {
    const { userHandle: _drop, ...rest } = good.fields;
    expect(verify(JSON.stringify(rest)).status).toBe('format-error');
  });
});

describe('proof-of-control: tampering', () => {
  const good = buildAssertion({ challenge: session.challenge });
  const flip = (b64: string, i: number) => {
    const b = base64urlToBytes(b64);
    b[i]! ^= 0x01;
    return bytesToBase64url(b);
  };
  it('signature bit flip', () => {
    const r = verify(withField(good, 'signature', flip(good.fields.signature!, 10)));
    expect(['mismatch', 'format-error']).toContain(r.status);
    expect(r.status).not.toBe('valid');
  });
  it('authenticatorData counter tamper', () => {
    const r = verify(withField(good, 'authenticatorData', flip(good.fields.authenticatorData!, 36)));
    expect(r.status).toBe('mismatch');
    expect(failed(r)).toEqual(['signature']);
  });
  it('clientDataJSON tamper (extra field appended, still valid JSON)', () => {
    const cd = JSON.parse(new TextDecoder().decode(good.clientDataJSON)) as Record<string, unknown>;
    const tampered = bytesToBase64url(new TextEncoder().encode(JSON.stringify({ ...cd, note: 'x' })));
    const r = verify(withField(good, 'clientDataJSON', tampered));
    expect(failed(r)).toEqual(['signature']);
  });
});
