# Website deploy plan

The website is the static build `dist-hosted/` served by **Cloudflare Workers Static Assets** on a `workers.dev` subdomain. There is no Worker script, binding, analytics or log collection. Configuration: [`wrangler.jsonc`](../../wrangler.jsonc); Wrangler is pinned as an exact devDependency.

**Status: not deployed.** Nothing in CI deploys; the steps below are run by the maintainer.

## Before deploying

```bash
npm ci
npm run build:hosted
npm run deploy:dry-run         # wrangler deploy --dry-run: lists the assets, uploads nothing
```

Check that `dist-hosted/_headers` exists and contains the Content-Security-Policy and the other security headers (`server/http.ts`, `hostedHeadersFile`).

**Release gate — the route matrix on the real Workers runtime.** The default `npm run test:e2e` checks the hosted routing against a local emulator (`test/support/e2e-servers.ts`, port 4179). Before a deploy, run the same matrix against Cloudflare's own runtime serving the built `dist-hosted/`, locally and without logging in:

```bash
npx wrangler dev --local --ip 127.0.0.1 --port 4191   # assets only; no account, no upload
E2E_WORKERD=http://127.0.0.1:4191 npm run test:e2e     # adds the `workerd` origin to test/e2e/site.spec.ts
```

The deploy waits until this run passes with the `workerd` origin included; keep its output with the release evidence. `test:e2e` rebuilds `dist-hosted/`, which the running `wrangler dev` then serves.

## Deploy (maintainer)

1. Log in with the maintainer's own Cloudflare account in a terminal (`npx wrangler login`); do not use a shared or global token.
2. `npx wrangler deploy` from the release tree. Wrangler prints the `https://passkey-recovery.<account>.workers.dev` URL.
3. Do not enable preview URLs, observability or custom routes; they are off in `wrangler.jsonc` on purpose.

## Runtime read-back

The deploy counts as done only after these checks pass against the live URL:

| Check | How | Expected |
|-------|-----|----------|
| Headers | `curl -sI https://<site>/` (check the response headers, not a file: `_headers` is configuration and is not served) | `Content-Security-Policy` equal to the one `dist-hosted/_headers` sets for `/*`; `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Strict-Transport-Security`, `Permissions-Policy` |
| Same artifact | For every publicly served file in `dist-hosted/` (skip `_headers`), fetch it at its effective URL — `index.html` at `/`, each `<page>/index.html` at `/<page>` and `404.html` at `/404`, since the `….html` and trailing-slash forms redirect there — with `curl -s https://<site>/<path> \| shasum -a 256` | Equal to the local file's sha256 |
| Unknown path | `curl -sI https://<site>/nope` | `404` (no SPA fallback) |
| Page paths | `curl -sI` each of `/recover`, `/guide`, `/how-it-works`, `/security`, `/download`; then `/guide/` | `200` for each page; `/guide/` answers `307` to `/guide`. An old `https://<site>/#/download` link opens `/download` in the browser |
| Version | Open `https://<site>/download` | Shows the released version and tarball name; the sha256 is on the release page |
| No third parties | Browser DevTools → Network on every page | Only the site itself and `rpc.plasma.to` (plus `127.0.0.1` when paired) |
| Pairing | Start the released runner with `--allow-origin https://<site>`, pair, check a wallet | Pairing succeeds; a second origin is refused |

## After the read-back

1. Add the exact live origin to `OFFICIAL_ORIGINS` in `server/runner/runner.ts`, so the released runner pairs with the official website without `--allow-origin`. That is a code change: review, test and ship it in the next runner version.
2. Update the README and the website copy from "not deployed" to the live URL.

## Rollback

`npx wrangler rollback` to the previous version, or `npx wrangler delete` to take the site down. The runner keeps working locally either way.
