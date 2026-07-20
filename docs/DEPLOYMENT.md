# Cloudflare deployment checklist

Do not deploy until the Access application exists. The committed configuration is deliberately fail-closed: without valid Access settings the UI may load, but protected API requests return `403`.

## Branch safety during development

Keep `main` as the production branch. While a feature is unfinished, go to **Worker → Settings → Build → Branch control** and turn off **Builds for non-production branches**. Cloudflare will then ignore pushes to branches such as `agent/sample-run-workflows`; only a later merge to `main` can start the production build.

If preview builds are enabled later, give the preview trigger a separate deploy command and separate D1/R2 resources. Never place `wrangler d1 migrations apply ... --remote` in a non-production deploy command: a preview Worker can otherwise migrate or write the production database even though its URL is not the production URL. Workers Builds exposes `WORKERS_CI_BRANCH` when a branch-aware command is needed. See Cloudflare's current [build branch controls](https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/) and [build environment variables](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#default-variables).

## 1. Connect and provision

1. Authenticate Wrangler with the intended Cloudflare account.
2. Deploy once so Wrangler can provision the `samples` D1 database and `ASSETS` R2 bucket declared without fixed IDs.
3. Record the provisioned identifiers in the generated configuration if Wrangler requests it.

## 2. Protect the hostname with Access

1. Create a Cloudflare Access self-hosted application covering the entire production hostname.
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

```bash
npm run verify
npm run db:migrate:remote
npm run deploy
```

After deployment:

1. Confirm an unauthenticated `/api/samples` request is rejected.
2. Sign in through Access and confirm `/api/ready` returns `{ "ok": true }`.
3. Create a disposable sample, add a record, and confirm the timeline shows the authenticated email.
4. Preview the intended FabuBlox workbook and confirm the import before upload.
5. Download a full ZIP export and inspect `export-manifest.json` plus at least one asset.

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
