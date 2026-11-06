# Third-party notices

Passkey Recovery by sd0x is licensed under Apache-2.0 ([`LICENSE`](./LICENSE), [`NOTICE`](./NOTICE)).
That license covers this project's own code only. Everything below keeps its own license; the full
texts are in [`licenses/`](./licenses/).

## npm packages that ship

The UI bundle (`dist/`, `dist-hosted/`) and the runner (`dist-server/` plus the production
dependencies `npm exec` installs) contain these packages. The complete generated list, with every
license text, is [`licenses/npm-shipped.txt`](./licenses/npm-shipped.txt), produced from
`package-lock.json` by `node scripts/release/licenses.mjs --write`. CI runs `--check`, which fails on a
license outside the allowlist or a stale list.

| Component | Version | License | Where |
|-----------|---------|---------|-------|
| react, react-dom, scheduler | 19.3.1 / 0.28.0 | MIT | UI |
| viem (with abitype, ox, @adraffy/ens-normalize, isows, ws, eventemitter3) | 2.57.13 | MIT | ABI, hashing, addresses (UI and runner) |
| @noble/curves, @noble/hashes, @noble/ciphers, @scure/* | see the generated list | MIT | P-256, SHA-256, keystore crypto |
| Atkinson Hyperlegible Next (`@fontsource/atkinson-hyperlegible-next`) | 5.3.0 | SIL Open Font License 1.1 | UI typeface, bundled locally |
| Atkinson Hyperlegible Mono (`@fontsource/atkinson-hyperlegible-mono`) | 5.3.0 | SIL Open Font License 1.1 | UI monospace typeface, bundled locally |
| Anvil (Foundry), `@foundry-rs/anvil-<platform>` | 1.7.1 | MIT OR Apache-2.0 | Local fork simulation, installed by the runner as an optional dependency for the current platform; its sha256 is pinned per platform in `server/runner/anvil.ts` |

## Contract bytecode

Each row was rebuilt from upstream source with `node scripts/release/rebuild-contracts.mjs`
(2026-11-02); the result says exactly how far the bytes match.

| Material | File | Source | License | Rebuild result |
|----------|------|--------|---------|----------------|
| Coinbase Smart Wallet v1.1.0 implementation and factory init code | `registry/coinbase-smart-wallet-v1.1/infra-deployment.json` | `coinbase/smart-wallet` `v1.1.0` = `a8c6456f…`; solc 0.8.23, via-IR, 999999 runs ([SOURCE.md](./registry/coinbase-smart-wallet-v1.1/SOURCE.md)) | MIT sources (Coinbase, Solady, webauthn-sol, FreshCryptoLib, OpenZeppelin `Base64`) **plus GPL-3.0** `IAccount`, `UserOperation`, `Helpers` from account-abstraction v0.6.0 | Executable bytes identical for both; only the IPFS hash inside the CBOR metadata differs |
| ERC-4337 EntryPoint v0.6 runtime code (test fixture; the product never deploys it) | `test/fixtures/infra-code.json` | `eth-infinitism/account-abstraction` `v0.6.0` = `abff2aca…`; solc 0.8.17, via-IR, 1000000 runs; `@openzeppelin/contracts` 4.8.0 (sha1 per its `yarn.lock`) | GPL-3.0 (some files GPL-3.0-only; `utils/Exec.sol` LGPL-3.0-only); OpenZeppelin `ReentrancyGuard` MIT | Identical, metadata included, except the one immutable: the canonical SenderCreator `0x7fc98430eaedbb6070b35b39d798725049088348` |
| Safe Singleton Factory runtime code, 69 bytes (test fixture) | `test/fixtures/infra-code.json` | `safe-global/safe-singleton-factory`, based on `Arachnid/deterministic-deployment-proxy` | MIT (Safe); Unlicense (Arachnid) | Not rebuilt: it is read from the canonical address `0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`, and its code hash is pinned in `src/config/registry.ts` |

**Corresponding source for the GPL-3.0 material.** This repository ships compiled GPL-3.0 code in two
places: the EntryPoint fixture and the Smart Wallet init code. For both, the corresponding source is
the public upstream commit named above, and the exact build recipe is the rebuild script. No SPDX
header was changed and no bytecode is hidden or obfuscated. The GPL-3.0 and LGPL-3.0 texts are in
`licenses/`.

## Test and build tools (not shipped)

| Component | Version | License |
|-----------|---------|---------|
| @playwright/test | 1.64.1 | Apache-2.0 |
| @axe-core/playwright, axe-core | 4.14.0 | MPL-2.0 |
| lightningcss (Vite CSS build) | see `package-lock.json` | MPL-2.0 |
| vitest, vite, @vitejs/plugin-react | see `package.json` | MIT |
| typescript | 7.0.2 | Apache-2.0 |
| wrangler (deploy tool, not run by CI) | see `package.json` | MIT OR Apache-2.0 |
