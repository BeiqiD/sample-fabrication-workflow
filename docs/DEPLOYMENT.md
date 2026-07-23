# Cloudflare deployment checklist

Production uses the existing `sample-management-system` Worker at [samples.run](https://samples.run). `wrangler.jsonc` keeps that Worker name, binds the custom domain, and disables both its ordinary `workers.dev` endpoint and version preview URLs. Changing the displayed application or repository name does not require renaming the Worker.

Do not deploy until the Access application covers `samples.run`. The committed configuration is deliberately fail-closed: without valid Access settings the UI may load, but protected API requests return `403`.

## Branch safety during development

Keep `main` as the production branch. While a feature is unfinished, go to **Worker → Settings → Build → Branch control** and turn off **Builds for non-production branches**. Cloudflare will then ignore pushes to branches such as `agent/sample-run-workflows`; only a later merge to `main` can start the production build.

If preview builds are enabled later, first give the preview trigger a separate deploy command, hostname, and D1/R2 resources; then explicitly revisit `preview_urls`. Never place `wrangler d1 migrations apply ... --remote` in a non-production deploy command: a preview Worker can otherwise migrate or write the production database even though its URL is not the production URL. Workers Builds exposes `WORKERS_CI_BRANCH` when a branch-aware command is needed. See Cloudflare's current [build branch controls](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/) and [build environment variables](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables).

## 1. Connect and verify bindings

1. Authenticate Wrangler with the intended Cloudflare account.
2. Confirm that `DB` identifies the intended D1 database and `ASSETS` identifies the private inline-image bucket.
3. File attachments remain disabled until an external file-storage adapter is configured and authenticated. Do not create a second R2 bucket as a temporary attachment store.
4. Keep the production Worker name and resource bindings unchanged during ordinary deployments. A fork or clean installation must provision its own resources and replace the committed identifiers before applying migrations.

## 2. Protect the hostname with Access

1. Create a Cloudflare Access self-hosted application covering all paths on `samples.run`.
2. Add the intended users or identity groups to an Allow policy.
3. Copy the team's domain, including `https://`, and the application's Audience (AUD) tag.
4. Store them as Worker secrets:

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_AUD
```

`ALLOWED_EMAILS` is optional. When set, it is a comma-separated second allowlist checked after the JWT is validated.

Cloudflare recommends validating `Cf-Access-Jwt-Assertion` at the Worker and checking both issuer and audience. The implementation follows the official [Workers JWT validation example](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## 3. Migrate, verify, deploy

> Alpha-v2 replaces the original schema with a clean baseline and deliberately has no compatibility migration. Provision fresh D1 and R2 resources and switch the Worker bindings before applying `0001_alpha_state_chain.sql`. Do not apply it over the existing alpha database. Keep the old resources until the new deployment passes the smoke checks, then remove them separately.

```bash
npm run verify
npm run db:migrate:remote
npm run deploy
```

After deployment:

1. Confirm an unauthenticated `https://samples.run/api/samples` request is rejected.
2. Sign in through Access and confirm `https://samples.run/api/ready` returns `{ "ok": true }`.
3. Create a disposable sample; add a text comment, compressed comment image, and external link; then confirm the comment and timeline show the authenticated email. Also confirm file attachment controls are disabled while no external storage provider is connected.
4. Preview the intended FabuBlox workbook and confirm the import before upload.
5. Download a full ZIP export and inspect `export-manifest.json` and at least one inline asset.

## Local development

Copy the example local variables before starting Vite:

```bash
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`AUTH_MODE=disabled` is intended only for local development and attributes writes to `local-development`.

## Recovery

Keep periodic full-system ZIP exports outside Cloudflare. D1 also provides point-in-time recovery through [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/); its retention depends on the account plan. A destructive restore should always be preceded by a fresh export and bookmark capture.
