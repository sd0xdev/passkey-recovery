// The contract between the page and the runner's native signer. Bumped whenever the page calls a signer
// endpoint (or relies on a field) an older signer lacks; the signer reports it in /gas/status as `api`, and a
// signer without the field is version 1. The page compares the two before any unlock (useGasPayer `compat`).
// 2: /gas/keystore/unlock and /gas/keystore/recheck (a keystore the user chooses), sign refusal codes.
export const SIGNER_API = 2;

/** Why the native signer refused to sign an issued transaction: a stable code the page translates. */
export const SIGN_REFUSALS = ['sign-locked', 'sign-unconfirmed', 'keystore-changed', 'keystore-stale', 'keystore-key-changed', 'sign-other-wallet', 'sign-bad-tx', 'sign-failed', 'sign-stopped', 'sign-timeout'] as const;
export type SignRefusal = (typeof SIGN_REFUSALS)[number];
export const isSignRefusal = (v: unknown): v is SignRefusal => typeof v === 'string' && (SIGN_REFUSALS as readonly string[]).includes(v);
