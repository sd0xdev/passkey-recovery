// Generic limits shared by the browser and the sidecar. Deployment-specific facts (addresses, code
// hashes, assets, RP) live in src/config/registry.ts; nothing here names a particular wallet.
export const PROOF_TTL_MS = 10 * 60 * 1000;
export const MAX_ASSERTION_JSON_BYTES = 16 * 1024;
