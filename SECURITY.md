# Security policy

Passkey Recovery moves real funds. Please report anything that could expose a key, sign or send something the user did not approve, or point the user at the wrong wallet.

## Reporting a vulnerability

- Use **GitHub Private Vulnerability Reporting** on [sd0xdev/passkey-recovery](https://github.com/sd0xdev/passkey-recovery/security) (Security → Report a vulnerability). If that button is not shown, private reporting has not been turned on yet: open a public issue that says only "security contact requested", with no details, and the maintainer will reply with a private channel.
- Do **not** put details, proof-of-concept code, transaction data, keystores, passkey assertions, RPC URLs or wallet addresses in a public issue.
- Never send anyone a seed phrase, private key, keystore password or 1Password item. The maintainer will never ask for them.

You can expect an acknowledgement within 7 days. This is a volunteer project with no bug bounty.

## Supported versions

Only the latest release receives fixes. 0.x releases may change behaviour between minor versions.

## Scope

| In scope | Out of scope |
|----------|--------------|
| The website build, the local runner and its signer, the bookmarklet and DevTools fallback, the redacted AI report | Coinbase Smart Wallet, EntryPoint, Plasma or any upstream contract (report to their maintainers) |
| A secret reaching logs, storage, URLs, argv, files or the network | Phishing sites that copy this project's name |
| Pairing, origin and CSP bypasses; SSRF through a custom RPC | Attacks that already require full control of the user's computer |
| Signing or sending without the user's action; a simulation that differs from what is sent | Lost passkeys (the tool cannot help) |

## Security model

The full threat model is in [docs/features/open-source-recovery/3-architecture.md](docs/features/open-source-recovery/3-architecture.md). Key properties:

- The tool never asks for a key of the wallet being recovered; passkey signing happens on `keys.coinbase.com` itself.
- Gas-wallet secrets live only in a browser tab's memory or in the local runner's isolated signer process.
- The runner binds to `127.0.0.1`; a website can reach it only after pairing with a code shown in your terminal, from an origin you allowed.
- Before anything is sent it is simulated on a local Anvil fork: each deploy step from a synthetic sender, the transfer exactly as signed. You confirm each deploy step and the transfer yourself.
- No analytics, no remote assets, a strict Content-Security-Policy on every page.

This project has not been audited.
