// Shared by the e2e servers and specs (importing e2e-servers.ts itself would start the servers).
/** Synthetic path secret of the custom-provider stand-in on 127.0.0.1:4176; the e2e asserts it never reaches the page. */
export const E2E_RPC_SECRET = 'E2eSyntheticPathKey0123456789abcd';
export const E2E_PROVIDER = 'http://127.0.0.1:4176';

/** What GET http://127.0.0.1:4176/world returns: public chain data and fixture seeds, nothing real. */
export interface E2eWorld {
  /** The offline anvil the mock EIP-1193 provider forwards to (anvil's unlocked dev account signs). */
  rpc: string;
  gasWallet: `0x${string}`;
  accounts: Record<'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K', { address: `0x${string}`; owners: `0x${string}`[]; nonce: string; passkey: { index: number; seed: number } }>;
  recipient: `0x${string}`;
  /** A 1Password Private Item Link of SYNTHETIC ids; only the fake `op` on the runner answers it. */
  opLink: string;
  /** The SYNTHETIC existing gas wallet (keystore + 1Password password) the runner's --gas-manifest names. */
  keystoreWallet: { address: string; link: string };
  /** A second SYNTHETIC keystore (not the manifest's): its path is in a field of `link`'s item, beside its password; `file` is the same keystore for the file picker. */
  chosenKeystore: { address: string; link: string; path: string; file: string };
  /** A SYNTHETIC item like a real one (password / notesPlain / wallet_address) whose raw key is in "password". */
  passwordKeyItem: { address: string; link: string };
}

/** The local runner (its own UI + paired API) and its native signer, in testchain mode. */
export const E2E_RUNNER = 'http://127.0.0.1:4177';
export const E2E_SIGNER = 'http://127.0.0.1:4178';
/** The hosted build (dist-hosted/) over https with its own `_headers`, as the website is; the runner allows this origin to pair. */
export const E2E_HOSTED = 'https://127.0.0.1:4179';
/** The same hosted build over plain http (like `wrangler dev`): a static preview, which no runner pairs with. */
export const E2E_HOSTED_HTTP = 'http://127.0.0.1:4180';
