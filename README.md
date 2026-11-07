# Passkey Recovery by sd0x

[繁體中文](README.zh-TW.md)

An open-source tool you run on your own computer. If you created a **Coinbase Smart Wallet v1.1** with a passkey and someone sent funds to the same address on **Plasma** (chainId 9745), where that wallet was never deployed, this tool deploys the missing wallet and moves your own funds to an address you choose. You sign and send every step.

> **Independent project.** Passkey Recovery is not affiliated with, endorsed by, or supported by Coinbase or Plasma. It has **not been audited**. It never asks for a seed phrase or private key of the wallet you are recovering.

## Who it is for

| For | Not for |
|-----|---------|
| You still have the passkey of a Coinbase Smart Wallet v1.1 | Lost passkeys, seed-phrase wallets |
| Funds arrived at that address on Plasma mainnet (9745) | Other smart-wallet brands or versions |
| You can pay a little XPL gas from a wallet of your own | Any chain other than Plasma |

## How it works

1. **Check wallet** — enter the address. If it is not deployed on Plasma, paste the creation evidence (owners and factory nonce); the tool recomputes the CREATE2 address locally and checks it against `factory.getAddress` before it accepts it.
2. **Deploy wallet** — only when needed. The Safe Singleton Factory and EntryPoint v0.6 must already be on Plasma at their canonical addresses; if either is missing or differs, the tool stops. It deploys only what is missing of the Coinbase Smart Wallet v1.1 implementation, its factory and then your wallet: each is a separate transaction, previewed on a fork from a synthetic sender, that you confirm as **Deploy step N** and your gas wallet pays. Steps that already exist are skipped.
3. **Move funds** — choose asset, amount and recipient, preview, sign the UserOperation hash with your passkey, review the **signed simulation** on a local Anvil fork, then press **Send**.
4. **Track** — follows the receipt; survives a page reload or a runner restart, and never resends on its own.

Signing with the passkey happens on Coinbase's own page (`keys.coinbase.com`), because a passkey only signs for the site it belongs to. The main way is a **bookmarklet** you drag to your bookmarks bar; an advanced **DevTools fallback** exists for browsers that block bookmarklets. The bookmarklet takes a request code from this tool. The fallback is a short script this tool generates for that one signature, which you paste into the Console. Both only run on the Coinbase origin.

### Gas wallet modes

The wallet you recover is the *passkey source account*. A separate **gas wallet** pays the network fee:

| Gas wallet | Where its key lives | Available |
|------------|--------------------|-----------|
| Browser wallet (EIP-6963, e.g. OKX) | In that wallet | Website and local runner |
| File in the browser: create or open an encrypted keystore (v3, scrypt, password ≥ 12 characters) | This tab's memory only; cleared when you leave the mode | Website and local runner |
| File (native) or 1Password (your own `op` CLI and one Private Link item) | Memory of the runner's signer process on your computer | Local runner, or the website once paired with your local runner |
| Existing gas wallet: an encrypted keystore already on your computer, its password in 1Password | Memory of the runner's signer process. With a manifest or a 1Password path field the signer reads the file itself; with **pick a file** the page reads the encrypted keystore text and sends it over `127.0.0.1` to your local signer only (from the website, only after pairing). It is never uploaded to the website or any remote service, and the signer keeps no copy on disk | Local runner, or the website once paired with your local runner |

## Install and run

You need Git, Node.js **24.22.1** and npm **11.19.1**. Full steps: [docs/INSTALL.md](docs/INSTALL.md).

| | Status |
|-|--------|
| Source code | The source code is public: [github.com/sd0xdev/passkey-recovery](https://github.com/sd0xdev/passkey-recovery) |
| Runner package | Not published: there is no GitHub Release or tarball to download yet, and it is not on the npm registry |
| Website | The website is live: [passkey-recovery.welfree-studio.workers.dev](https://passkey-recovery.welfree-studio.workers.dev). It serves static pages only; to use the tool, build and start the runner on your computer |

So the way in is a clone of the source:

```bash
git clone https://github.com/sd0xdev/passkey-recovery.git
cd passkey-recovery
nvm install 24.22.1            # other version managers read the same version from .nvmrc
npm -v                         # if older than 11.19.1: npm install -g npm@11.19.1
npm ci
npm run build
npm run runner                 # tool on http://127.0.0.1:4171/recover (this computer only)
# or, build and start in one step: npm run preview
```

The same runner as one package file you make yourself, from that folder after the build:

```bash
npm pack                                        # writes passkey-recovery-0.2.0.tgz
shasum -a 256 passkey-recovery-0.2.0.tgz        # note which file you ran
npm exec --yes --package ./passkey-recovery-0.2.0.tgz -- passkey-recovery
```

A published Release is planned, with that file and its sha256; it does not exist yet. See [docs/INSTALL.md](docs/INSTALL.md) §2c.

The runner binds to `127.0.0.1` only and starts a sha256-pinned Anvil (an npm optional dependency) the first time it needs to simulate. `Ctrl-C` stops it and every process it started. To let the website pair with your runner, start it with `--allow-origin https://<site>` and enter the code it prints. Without a runner the website shows the guide and the bookmarklet only: checking a wallet, simulating and sending all need a paired runner. Nothing falls back to a cloud service.

## Security model in short

- No key for the wallet you recover is ever requested. Gas-wallet secrets stay in the tab's memory or the runner's isolated signer process — never in logs, storage, URLs or command-line arguments.
- Nothing is sent without your confirmation: **Deploy step N** for each deployment, **Send** for the transfer. Each deploy step is simulated on a fork from a synthetic sender first; the transfer is simulated exactly as signed.
- Your RPC key stays in memory; the public Plasma RPC is the default. Checks and simulations only read from the active RPC; a transaction you confirm is broadcast either by your browser wallet or — when a gas key in this tab or the runner's native signer signs it — by the runner through the active RPC.
- AI helpers can read a redacted report; they can never sign.

Details: [SECURITY.md](SECURITY.md) and [docs/features/open-source-recovery/3-architecture.md](docs/features/open-source-recovery/3-architecture.md). Working with an AI assistant: [docs/AI_COLLABORATION.md](docs/AI_COLLABORATION.md).

## Status

Version 0.2.0: public source, no published Release, website live (see [Install and run](#install-and-run)). The method this tool automates recovered one real Coinbase Smart Wallet v1.1 on Plasma; with the tool itself, one mainnet transfer has been made and checked using the runner's existing gas wallet mode (keystore + 1Password); the other gas modes are tested only on synthetic test chains. Not audited. A local or fork simulation is not mainnet: only a transaction you sent and that **Track** shows as `confirmed` or `final` reflects the chain.

## Development

| Command | What it runs | Network |
|---------|--------------|---------|
| `npm run typecheck` | TypeScript | No |
| `npm run test` | Unit tests | No |
| `npm run test:integration` | Synthetic Anvil test chain (chainId 9745) | 127.0.0.1 only |
| `npm run test:e2e` | Playwright + axe against local builds (first run: `npx playwright install chromium`) | 127.0.0.1 only |
| `npm run test:live` | Read-only queries to `https://rpc.plasma.to` | Yes (read-only) |
| `npm run build` / `npm run build:hosted` | Runner package build / static website (`dist-hosted/`) | No |
| `npm run release:licenses`, `release:scan`, `release:rebuild-contracts` | License check, secret and privacy scan, contract rebuild | Rebuild only |

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Code of conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · Design docs (Traditional Chinese): [docs/features/open-source-recovery/](docs/features/open-source-recovery/2-tech-spec.md).

## Support the project

If this tool helped you, you can make a voluntary one-time contribution: [Support Passkey Recovery](https://buy.stripe.com/8x2eVdfSh6KZ4mf6wm0sU06). Stripe handles the payment and Welfree Studio, Ltd. receives it, to help pay for maintenance, testing and documentation. A contribution does not buy support or priority and does not make a recovery more likely to succeed. Every feature works without one.

## License

[Apache-2.0](LICENSE). See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The bundled contract bytecode comes from upstream projects under their own licenses (GPL-3.0, LGPL-3.0, MIT); where it comes from and how to rebuild it: [registry/coinbase-smart-wallet-v1.1/SOURCE.md](registry/coinbase-smart-wallet-v1.1/SOURCE.md).
