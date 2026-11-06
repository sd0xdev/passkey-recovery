// Strict schema for the JSON the helper prints (format cbpr-assertion-v1).
import { MAX_ASSERTION_JSON_BYTES } from '../config/constants';
import { base64urlToBytes, utf8 } from '../crypto/bytes';

export type AssertionKind = 'proof' | 'userop';

export interface ParsedAssertion {
  kind: AssertionKind;
  /** As reported by the helper (location.origin); informational — clientDataJSON.origin is authoritative. */
  reportedOrigin: string;
  credentialId: Uint8Array;
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signatureDer: Uint8Array;
  userHandle: Uint8Array | null;
}

export class AssertionFormatError extends Error {
  override name = 'AssertionFormatError';
}

const KEYS = [
  'format',
  'kind',
  'rpId',
  'origin',
  'credentialId',
  'authenticatorData',
  'clientDataJSON',
  'signature',
  'userHandle',
] as const;

function b64(obj: Record<string, unknown>, key: string): Uint8Array {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) throw new AssertionFormatError(`${key}: expected non-empty base64url string`);
  try {
    return base64urlToBytes(v);
  } catch {
    throw new AssertionFormatError(`${key}: not canonical unpadded base64url`);
  }
}

export function parseAssertionJson(text: string, expectedKind: AssertionKind): ParsedAssertion {
  if (utf8(text).length > MAX_ASSERTION_JSON_BYTES) throw new AssertionFormatError('input too large');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new AssertionFormatError('not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new AssertionFormatError('expected a JSON object');
  const obj = raw as Record<string, unknown>;
  const extra = Object.keys(obj).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (extra.length > 0) throw new AssertionFormatError(`unexpected field(s): ${extra.join(', ')}`);
  for (const k of KEYS) if (!(k in obj)) throw new AssertionFormatError(`missing field: ${k}`);
  if (obj.format !== 'cbpr-assertion-v1') throw new AssertionFormatError('format must be cbpr-assertion-v1');
  if (obj.kind !== expectedKind) throw new AssertionFormatError(`kind must be "${expectedKind}"`);
  if (typeof obj.rpId !== 'string' || typeof obj.origin !== 'string') throw new AssertionFormatError('rpId/origin must be strings');

  const authenticatorData = b64(obj, 'authenticatorData');
  if (authenticatorData.length < 37) throw new AssertionFormatError('authenticatorData shorter than 37 bytes');
  const signatureDer = b64(obj, 'signature');
  const userHandle = obj.userHandle === null ? null : b64(obj, 'userHandle');
  return {
    kind: expectedKind,
    reportedOrigin: obj.origin,
    credentialId: b64(obj, 'credentialId'),
    authenticatorData,
    clientDataJSON: b64(obj, 'clientDataJSON'),
    signatureDer,
    userHandle,
  };
}
