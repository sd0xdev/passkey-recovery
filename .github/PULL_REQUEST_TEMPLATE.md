## What changed

<!-- One or two sentences, and why. -->

## How it was tested

- [ ] `npm run typecheck`, `npm run test`, `npm run build`
- [ ] `npm run test:integration` / `npm run test:e2e` (when the flow or UI changed)
- [ ] `npm run release:licenses` and `npm run release:scan`

## Safety checklist

- [ ] Only synthetic test data (no real keys, assertions, addresses or RPC URLs)
- [ ] No secret can reach logs, storage, URLs, argv, files or error messages
- [ ] CSP, SSRF guard, origin checks and loopback binding are unchanged or stricter
- [ ] New dependencies are pinned to exact versions and their licenses are allowed
- [ ] User-facing text exists in English and Traditional Chinese
