// Proof-of-control statement and challenge (tech spec §3.2). Parameterised by the account, chain,
// owner index and RP the user is proving for; the statement authorizes nothing on chain.
import { sha256 } from '@noble/hashes/sha2.js';
import type { Address } from 'viem';
import { PROOF_TTL_MS } from '../config/constants';
import { bytesToHex, utf8 } from '../crypto/bytes';

export interface ProofSubject {
  account: Address;
  chainId: number;
  ownerIndex: number;
  rpId: string;
  origin: string;
}

export interface ProofSession {
  subject: ProofSubject;
  statement: string;
  challenge: Uint8Array;
  issuedAt: Date;
  expiresAt: Date;
  nonceHex: string;
}

export function buildStatement(s: ProofSubject, issuedAt: Date, expiresAt: Date, nonceHex: string): string {
  return [
    'Passkey Recovery - proof of control (NOT a transaction)',
    'version: cbpr-proof-v2',
    `purpose: prove control of the owner ${s.ownerIndex} passkey; authorizes nothing`,
    `account: ${s.account}`,
    `chainId: ${s.chainId}`,
    `ownerIndex: ${s.ownerIndex}`,
    `rpId: ${s.rpId}`,
    `origin: ${s.origin}`,
    `issuedAt: ${issuedAt.toISOString()}`,
    `expiresAt: ${expiresAt.toISOString()}`,
    `nonce: ${nonceHex}`,
  ].join('\n');
}

export function challengeFor(statement: string): Uint8Array {
  return sha256(utf8(statement));
}

export function createProofSession(subject: ProofSubject, now: Date = new Date(), random: (n: number) => Uint8Array = randomBytes): ProofSession {
  if (!Number.isInteger(subject.ownerIndex) || subject.ownerIndex < 0) throw new RangeError('ownerIndex must be a non-negative integer');
  const nonceHex = bytesToHex(random(32)).slice(2);
  const issuedAt = new Date(now.getTime());
  const expiresAt = new Date(now.getTime() + PROOF_TTL_MS);
  const statement = buildStatement(subject, issuedAt, expiresAt, nonceHex);
  return { subject, statement, challenge: challengeFor(statement), issuedAt, expiresAt, nonceHex };
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}
