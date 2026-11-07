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

1. Log in with the maintainer's own Cloudflare account in a terminal (`npx wrangler login`, which is the `default` auth profile, or a named auth profile you already have); do not use a shared or global token. Note the id of the account to deploy to. This step deploys nothing.
2. Deploy once from the release tree: a clean checkout of the public commit whose CI passed, the same `dist-hosted/` the route matrix above ran against. Always name both the account and the auth profile (`default` for a plain `wrangler login`), because without `--profile` Wrangler may use a profile bound to the directory: `CLOUDFLARE_ACCOUNT_ID=<account id> npx wrangler deploy --profile <auth profile>`. Wrangler prints the `https://passkey-recovery.<subdomain>.workers.dev` URL.
3. Do not enable preview URLs, observability or custom routes; they are off in `wrangler.jsonc` on purpose.

## Runtime read-back

The deploy counts as done only after these checks pass against the live URL:

| Check | How | Expected |
|-------|-----|----------|
| Headers | `curl -sI https://<site>/` (check the response headers, not a file: `_headers` is configuration and is not served) | `Content-Security-Policy` equal to the one `dist-hosted/_headers` sets for `/*`; `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Strict-Transport-Security`, `Permissions-Policy` |
| Same artifact | For every publicly served file in `dist-hosted/` (skip `_headers`), fetch it at its effective URL — `index.html` at `/`, each `<page>/index.html` at `/<page>` and `404.html` at `/404`, since the `….html` and trailing-slash forms redirect there — with `curl -s https://<site>/<path> \| shasum -a 256` | Equal to the local file's sha256 |
| Unknown path | `curl -sI https://<site>/nope` | `404` (no SPA fallback) |
| Page paths | `curl -sI` each of `/recover`, `/guide`, `/how-it-works`, `/security`, `/download`; then `/guide/` | `200` for each page; `/guide/` answers `307` to `/guide`. An old `https://<site>/#/download` link opens `/download` in the browser |
| Version | Open `https://<site>/download` | Shows the current version and package file name. Without a published Release it says so and starts from the source; once one exists, the sha256 is on the release page |
| No third parties | Browser DevTools → Network on every page | Only the site itself and `rpc.plasma.to` (plus `127.0.0.1` when paired) |
| Pairing | Start a runner built from the same source (or the released one) with `--allow-origin https://<site>`, pair, check a wallet | Pairing succeeds; a second origin is refused |

## After the read-back

1. Update the README, the install guides and this plan from "not deployed" to the live URL. The website's own pages describe it without a deployment claim, so this edit changes no served file; rebuild and compare to confirm.
2. Later, with the next runner version: add the exact live origin to `OFFICIAL_ORIGINS` in `server/runner/runner.ts`, so the runner pairs with the official website without `--allow-origin`. That is a code change: review, test and ship it. Until then the Download page shows the `--allow-origin` command for this exact address.

## Rollback

Name the same account and auth profile as the deploy. `npx wrangler rollback` returns to the previous version, which exists only after a second deploy; for a failed first deploy, `npx wrangler delete` takes the site down. The runner keeps working locally either way.
