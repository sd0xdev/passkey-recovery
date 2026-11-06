# Corresponding source: Coinbase Smart Wallet v1.1 deployment bytecode

`infra-deployment.json` holds two deterministic deployment transactions (`to`, `input`) copied verbatim
from public Base mainnet (chainId 8453) transactions. Each `input` is a 32-byte CREATE2 salt followed
by the contract's init code. The runner replays them through the Safe Singleton Factory
(`0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7`) on a forked or synthetic chain, which yields the same
addresses as on every chain that has that factory.

| Target | Address | Base transaction |
|--------|---------|------------------|
| Implementation (`CoinbaseSmartWallet`) | `0x00000110dCdEdC9581cb5eCB8467282f2926534d` | `0x02643e0947633e01ed0cd8a6513a27e28481ae0ba23bf49e94b2601ef341ad00` (block 32354283) |
| Factory (`CoinbaseSmartWalletFactory`, constructor argument = the implementation) | `0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842` | `0xb293beed81baadaaa60da87d6c20b53d9e19dcdead1395ebe35e49dd221d3b9c` (block 32354283) |

## Source

| Item | Value |
|------|-------|
| Repository | https://github.com/coinbase/smart-wallet |
| Tag / commit | `v1.1.0` / `a8c6456f3a6d5d2dea08d6336b3be13395cacd42` |
| Compiler | solc 0.8.23 (`soljson-v0.8.23+commit.f704f362.js`, sha256 `9c681b16…4976985`) |
| Settings | `foundry.toml` profile `deploy`: optimizer on, 999999 runs, via-IR; evmVersion `shanghai` (forge clamps the profile's `prague` to the newest version solc 0.8.23 knows) |
| Submodules that reach the bytecode | `lib/account-abstraction` `abff2aca…` (v0.6.0), `lib/solady` `c4c96607…` (v0.0.175), `lib/webauthn-sol` `619f20ab…` (v1.0.0), its `lib/FreshCryptoLib` `76f3f135…`, its `lib/openzeppelin-contracts` `5705e820…` |

## Licenses of the compiled-in sources

| Files | SPDX |
|-------|------|
| `src/CoinbaseSmartWallet.sol`, `src/CoinbaseSmartWalletFactory.sol`, `src/ERC1271.sol`, `src/MultiOwnable.sol` | MIT (Coinbase) |
| Solady `Receiver`, `SignatureCheckerLib`, `UUPSUpgradeable`, `LibClone`, `LibString` | MIT |
| webauthn-sol `WebAuthn`; FreshCryptoLib `FCL_ecdsa`, `FCL_elliptic`; OpenZeppelin `Base64` | MIT |
| account-abstraction v0.6.0 `interfaces/IAccount.sol`, `interfaces/UserOperation.sol`, `core/Helpers.sol` | **GPL-3.0** |

Because GPL-3.0 files are compiled into this bytecode, this file and the sources linked above are
offered as its corresponding source. The license texts are in [`licenses/`](../../licenses/).

## Rebuild

```bash
node scripts/release/rebuild-contracts.mjs --out rebuild-report.json
```

The script clones the pinned commits, checks every submodule commit and every compiler download against
pinned hashes, exports the exact standard-JSON input with `forge verify-contract --show-standard-json-input`
and compiles it with the official solc build. Result on 2026-11-02: for both contracts the executable
bytes are **identical**. Only the IPFS hash inside the trailing CBOR metadata differs. That hash also
covers source paths and settings such as remappings, which today's forge export does not reproduce
exactly; which of them differs has not been narrowed down. The factory's 32 trailing bytes are its constructor argument (the implementation address).
