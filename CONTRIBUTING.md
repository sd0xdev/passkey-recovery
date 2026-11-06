# Contributing

Thanks for helping. This tool handles real funds, so changes are reviewed for safety first and features second.

## Before you start

- Open an issue for anything larger than a small fix, so the approach can be agreed first.
- Security problems go through [SECURITY.md](SECURITY.md), never a public issue.
- New chains or wallet brands are out of scope for now (Coinbase Smart Wallet v1.1 on Plasma only).

## Set up

```bash
nvm use        # Node.js 24.22.1 (.nvmrc); npm 11.19.1
npm ci
npm run build
npm run test
```

Integration tests need Anvil (`npm run test:integration`); browser tests need Chromium (`npx playwright install chromium`, then `npm run test:e2e`). See [docs/INSTALL.md](docs/INSTALL.md).

## Rules for changes

| Rule | Why |
|------|-----|
| Tests only use synthetic data: synthetic passkeys, Anvil dev keys, `*.example` names | Real assertions, keys or addresses must never enter the repository |
| No secret in logs, `localStorage`, URLs, argv, files or error messages | Reports and screenshots get shared |
| Dev servers bind `127.0.0.1` with `--strictPort` | A recovery tool must not be reachable from the network |
| No CDN, analytics or remote assets; keep the CSP strict | Every byte the page runs is in this repository |
| Do not weaken the SSRF guard, origin checks or source-scan tests | They are the security boundary |
| Pin exact dependency versions | Reproducible builds |
| User-facing text in English and Traditional Chinese (`src/ui/copy*.ts`, `src/ui/site/copy-site.ts`) | Both locales are complete |

Before opening a pull request run `npm run typecheck`, `npm run test`, `npm run build`, `npm run release:licenses` and `npm run release:scan`. CI also runs integration, end-to-end and accessibility tests.

## Pull requests

Keep them focused, describe what changed and how you tested it, and fill in the template. By contributing you agree that your contribution is licensed under [Apache-2.0](LICENSE).

AI-assisted contributions are welcome when you have read and tested the result yourself; see [docs/AI_COLLABORATION.md](docs/AI_COLLABORATION.md).
