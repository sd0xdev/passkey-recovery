// Check-by-check WebAuthn assertion verification (tech spec §3.4).
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesEqual, bytesToBase64url, utf8, utf8Decode } from '../crypto/bytes';
import { P256_HALF_N, parseDerSignature, verifyP256Digest, webauthnDigest, type RS } from '../crypto/p256';
import type { ParsedAssertion } from './assertion';

export type CheckId = 'format' | 'type' | 'challenge' | 'origin' | 'rpIdHash' | 'flags' | 'signature';

export interface Check {
  id: CheckId;
  ok: boolean;
  detail: string;
}

export interface VerifyParams {
  expectedChallenge: Uint8Array;
  publicKeyXY: Uint8Array;
  rpId: string;
  origin: string;
  requireUV: boolean;
  /** Which owner publicKeyXY was read from; only names it in the check detail. */
  ownerIndex?: number | bigint;
}

export interface VerifyResult {
  checks: Check[];
  allOk: boolean;
  formatOk: boolean;
  /** Parsed signature (original s) when DER parsing succeeded. */
  signature: RS | null;
  highS: boolean;
  clientData: Record<string, unknown> | null;
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function parseClientData(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(utf8Decode(bytes));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const ownerName = (p: VerifyParams) => (p.ownerIndex === undefined ? 'the given owner' : `owner ${p.ownerIndex}`);

export function verifyAssertion(a: ParsedAssertion, p: VerifyParams): VerifyResult {
  const checks: Check[] = [];
  const clientData = parseClientData(a.clientDataJSON);
  let signature: RS | null = null;
  let formatDetail = 'schema, clientDataJSON and DER signature are well-formed';
  try {
    signature = parseDerSignature(a.signatureDer);
  } catch (e) {
    formatDetail = `signature: ${(e as Error).message}`;
  }
  if (!clientData) formatDetail = 'clientDataJSON is not a UTF-8 JSON object';
  const formatOk = clientData !== null && signature !== null;
  checks.push({ id: 'format', ok: formatOk, detail: formatDetail });
  if (!formatOk || !clientData || !signature) {
    return { checks, allOk: false, formatOk: false, signature, highS: false, clientData };
  }

  const type = clientData.type;
  checks.push({ id: 'type', ok: type === 'webauthn.get', detail: `type = ${JSON.stringify(type)}` });

  const want = bytesToBase64url(p.expectedChallenge);
  const got = clientData.challenge;
  checks.push({
    id: 'challenge',
    ok: got === want,
    detail: got === want ? 'matches this session' : `expected ${want}, got ${JSON.stringify(got)}`,
  });

  const origin = clientData.origin;
  const crossOriginOk = clientData.crossOrigin === undefined || clientData.crossOrigin === false;
  const noTop = !('topOrigin' in clientData);
  checks.push({
    id: 'origin',
    ok: origin === p.origin && crossOriginOk && noTop,
    detail: `origin = ${JSON.stringify(origin)}${crossOriginOk ? '' : ', crossOrigin set'}${noTop ? '' : ', topOrigin present'}`,
  });

  const rpOk = bytesEqual(a.authenticatorData.subarray(0, 32), sha256(utf8(p.rpId)));
  checks.push({ id: 'rpIdHash', ok: rpOk, detail: rpOk ? `SHA-256("${p.rpId}")` : `not SHA-256("${p.rpId}")` });

  const flags = a.authenticatorData[32]!;
  const up = (flags & FLAG_UP) !== 0;
  const uv = (flags & FLAG_UV) !== 0;
  const at = (flags & FLAG_AT) !== 0;
  const flagsOk = up && (!p.requireUV || uv) && !at;
  checks.push({
    id: 'flags',
    ok: flagsOk,
    detail: `0x${flags.toString(16).padStart(2, '0')} UP=${up} UV=${uv}${at ? ' AT=true (unexpected)' : ''}`,
  });

  const sigOk = verifyP256Digest(webauthnDigest(a.authenticatorData, a.clientDataJSON), signature, p.publicKeyXY);
  const highS = signature.s > P256_HALF_N;
  checks.push({
    id: 'signature',
    ok: sigOk,
    detail: sigOk ? `valid for ${ownerName(p)} public key${highS ? ' (high-s, normalized on export)' : ''}` : `does not verify against ${ownerName(p)} public key`,
  });

  return { checks, allOk: checks.every((c) => c.ok), formatOk: true, signature, highS, clientData };
}
