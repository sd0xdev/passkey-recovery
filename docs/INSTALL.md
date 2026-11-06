# Install and run

[繁體中文](INSTALL.zh-TW.md)

Passkey Recovery runs in two places that share the same interface:

| | Website | Local runner |
|-|---------|--------------|
| What it is | Static pages served over https | A small program on your computer, UI on `http://127.0.0.1:4171/` |
| Guide, bookmarklet | Yes | Yes |
| Check a wallet, simulate and send | Only while paired with your local runner | Yes |
| Gas wallet: browser wallet, File (browser) | Yes | Yes |
| Gas wallet: File (native), 1Password, existing gas wallet | Only while paired with your local runner (the key stays in its signer) | Yes |

The website has not been deployed yet. Until it is, use the local runner.

## 1. Requirements

- macOS (arm64 or x64), Linux (x64 or arm64) or Windows (x64 only; Windows on arm64 has no pinned Anvil build).
- Node.js **24.22.1** and npm **11.19.1**. With a version manager: `nvm install 24.22.1` or `fnm use` in the source folder (`.nvmrc`).
- A Chromium-based browser or Safari with your Coinbase Smart Wallet passkey.
- A little XPL on Plasma in a wallet you control, for gas.

Anvil (the local chain used for simulations) comes with the package as a pinned, sha256-checked npm optional dependency for your platform. To use your own build instead, set `CBPR_ANVIL=<path to anvil>`.

## 2a. Build and run from your folder

The public repository and its GitHub Release are not published yet, so there is nothing to download. Start from the source folder you already have.

1. In that folder, install the pinned dependencies, build and pack:

   ```bash
   npm ci
   npm run build
   npm pack            # writes passkey-recovery-<version>.tgz
   ```

2. Note its SHA-256, so you can tell later which file you ran: `shasum -a 256 passkey-recovery-<version>.tgz` (Windows: `certutil -hashfile <file> SHA256`).
3. Start the runner from that file (it can also be copied to an empty folder first):

   ```bash
   npm exec --yes --package ./passkey-recovery-<version>.tgz -- passkey-recovery
   ```

4. Open the address it prints, `http://127.0.0.1:4171/`. That page is the tool and needs no pairing.

The package is not on the npm registry; `npm exec` installs it from the file into npm's cache only.

## 2b. Run straight from the source folder

Without packing, in the same folder:

```bash
npm ci
npm run build
npm run runner          # or, in one step: npm run preview
```

## 2c. After publication (planned)

Once the repository and a release are public, the planned route is: download `passkey-recovery-<version>.tgz` from the [releases page](https://github.com/sd0xdev/passkey-recovery/releases), compare its sha256 with the one published there, and run the same `npm exec` command as in 2a; or `git clone https://github.com/sd0xdev/passkey-recovery.git` and continue as in 2b. Neither exists yet.

## 3. Runner options

| Option | Meaning |
|--------|---------|
| `--port <n>` | UI port (default 4171); the native signer uses the next port unless `--signer-port` is given |
| `--allow-origin https://<site>` | A website that may pair with this runner (exact https origin; repeatable) |
| `--no-native-signer` | Do not start the native signer (File native, 1Password and existing gas wallet modes off) |
| `--gas-manifest <absolute path>` | Public manifest of an existing gas wallet (default `~/.local/share/passkey-recovery/gas-wallet-public.json`) |
| `--help`, `--version` | Print help or version |

While running: `p` prints a new pairing code, `u` ends all pairings, `q` or `Ctrl-C` stops the runner and every process it started.

## 4. Pair the website with your runner

1. Start the runner with `--allow-origin https://<the website origin>`. The Download page of the website shows the exact command.
2. On the website, open **Recover**, press **Connect runner** and type the `XXXX-XXXX` code from your terminal.
3. The pairing lives only in that tab. It ends after 30 minutes idle, on reload, or when the runner stops.

## 5. 1Password gas wallets (local runner)

The runner calls your own `op` CLI, which signs in only through the 1Password desktop app; you approve each request in the app. It does not use service-account tokens, `op signin` sessions or Connect.

1. In the 1Password app: **Settings → Developer → Integrate with 1Password CLI**, and keep the app running.
2. On macOS also allow the app that starts the runner (for example Terminal) under **System Settings → Privacy & Security → Files and Folders → Data shared by 1Password**.
3. Paste the item's Private Link exactly as copied; its account ID is case-sensitive.

If the page says the CLI cannot reach the app, check both settings, then restart the 1Password app and the terminal.

## 6. Troubleshooting

| Message | What to do |
|---------|-----------|
| `could not start on 127.0.0.1:… (EADDRINUSE)` or `signer port … is in use` | Another program uses 4171 or 4172; start with `--port <free port>` |
| `could not locate Anvil` / pin mismatch | Reinstall with `npm ci`, or set `CBPR_ANVIL` to a trusted Anvil build |
| `--allow-origin: …` | Give an exact `https://host` origin with no path |
| Bookmarklet does nothing | Your browser blocks bookmarklets on that page; use the DevTools fallback in the guide |

For help, use the **AI report** button and share only that redacted text. Never share a key, password, keystore or passkey data with anyone.
