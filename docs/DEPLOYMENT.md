# Deploying Sample Fabrication Workflow

This guide describes a fresh installation. All names and identifiers below are placeholders. Each deployment must use resources owned by its own Cloudflare and storage accounts; never copy another installation's database ID, bucket name, hostname, Access audience, WebDAV path, or credentials.

The recommended production workflow is GitHub plus Cloudflare Workers Builds. It can be configured entirely through the GitHub and Cloudflare web interfaces.

## Prerequisites

- A GitHub fork of this repository.
- A Cloudflare account with Workers, D1, and R2 enabled.
- A hostname for the app: either a `workers.dev` hostname or a custom domain in your Cloudflare account.
- A Cloudflare Access identity provider and an Allow policy for the intended users.
- Optional: a supported managed-storage account for unchanged original-file attachments.

## 1. Create isolated storage resources

In the Cloudflare dashboard:

1. Go to **Storage & databases → D1** and create a new database.
2. Copy its database name and database ID.
3. Go to **Storage & databases → R2** and create one private bucket.

The binding names are part of the application contract:

- D1 must be exposed to the Worker as `DB`.
- R2 must be exposed to the Worker as `ASSETS`.

The resource names and IDs behind those bindings are installation-specific. The R2 bucket stores workbooks, diagrams, and compressed inline images. Do not create a second R2 bucket for unchanged original attachments; those use the optional `ManagedStorage` adapter.

## 2. Replace the deployment configuration

Before connecting the fork to Workers Builds, edit `wrangler.jsonc` in the fork. A minimal fresh-installation configuration looks like this:

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "<YOUR_WORKER_NAME>",
  "main": "./worker/index.ts",
  "compatibility_date": "2026-07-20",
  "workers_dev": true,
  "preview_urls": false,
  "triggers": {
    "crons": ["17 3 * * *"]
  },
  "assets": {
    "not_found_handling": "single-page-application"
  },
  "vars": {
    "AUTH_MODE": "access"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "<YOUR_D1_DATABASE_NAME>",
      "database_id": "<YOUR_D1_DATABASE_ID>"
    }
  ],
  "r2_buckets": [
    {
      "binding": "ASSETS",
      "bucket_name": "<YOUR_R2_BUCKET_NAME>"
    }
  ]
}
```

Use `workers_dev: true` for the initial deployment, or replace it with a route/custom-domain configuration that belongs to your account. Remove any route inherited from the source repository. The Worker name in Cloudflare and `name` in `wrangler.jsonc` must match.

Do not commit authentication secrets, storage passwords, or Access identifiers to `wrangler.jsonc`.

## 3. Connect the fork to Cloudflare Workers Builds

In **Cloudflare Dashboard → Workers & Pages**:

1. Create a Worker or connect an existing Worker to the GitHub fork.
2. Select `main` as the production branch.
3. Use the repository root as the root directory.
4. Set:

   ```text
   Build command:
   npm run build

   Deploy command:
   npx wrangler d1 migrations apply DB --remote && npx wrangler deploy
   ```

5. Under **Settings → Build → Branch control**, disable builds for non-production branches.

The deploy command intentionally applies D1 migrations before deploying the new Worker. Because the commands are joined with `&&`, a failed migration prevents code that expects the new schema from being deployed.

Do not use that remote-migration command for preview branches. If previews are introduced later, give them a separate Worker, hostname, D1 database, R2 bucket, and deploy command.

## 4. Protect the application with Cloudflare Access

Before storing real sample data:

1. In Cloudflare Zero Trust, create a **self-hosted Access application** for the complete hostname that will serve the app.
2. Add an Allow policy for the intended people or identity groups.
3. Copy the Access team domain and the application's Audience (AUD) tag.
4. Open the Worker, then go to **Settings → Variables and Secrets**.
5. Add these as encrypted secrets:

   ```text
   ACCESS_TEAM_DOMAIN=https://<YOUR_TEAM>.cloudflareaccess.com
   ACCESS_AUD=<YOUR_ACCESS_APPLICATION_AUD>
   ```

6. Optionally add:

   ```text
   ALLOWED_EMAILS=user-one@example.org,user-two@example.org
   ```

`ALLOWED_EMAILS` is a second allowlist checked after the Access JWT has been validated. It is not a replacement for an Access policy.

The application is fail-closed when `AUTH_MODE=access`: protected API routes reject requests if Access is absent, misconfigured, or supplies an invalid issuer/audience.

## 5. Deploy and verify

Push or merge the sanitized configuration to `main`. Workers Builds should:

1. Install dependencies.
2. Run `npm run build`.
3. Apply every unapplied file in `migrations/` to the bound remote D1 database.
4. Deploy the Worker only after migrations succeed.

Check the build log for either applied migration names or `No migrations to apply`.

Then verify:

1. An unauthenticated request to a protected API route is rejected.
2. After Access sign-in, `/api/ready` returns:

   ```json
   { "ok": true }
   ```

3. Create a disposable sample and add a text comment.
4. Add a compressed inline image and an external attachment link.
5. Confirm file-upload controls remain disabled if managed storage is not configured.
6. Import a representative FabuBlox workbook through the preview/confirm flow.
7. Download a ZIP export and inspect `export-manifest.json` plus at least one asset.

## 6. Optional unchanged original-file attachments

Without managed storage, the system still supports text, compressed inline images, and URL-only attachment links.

The included SWITCHdrive adapter uses HTTPS WebDAV with a dedicated App Passcode. In the Worker's **Variables and Secrets**, add:

| Secret | Value |
|---|---|
| `MANAGED_STORAGE_PROVIDER` | `switchdrive` |
| `SWITCHDRIVE_WEBDAV_URL` | The complete WebDAV URL copied from your SWITCHdrive account |
| `SWITCHDRIVE_USERNAME` | The username shown when the App Passcode is created |
| `SWITCHDRIVE_APP_PASSWORD` | The dedicated App Passcode, not the SWITCH edu-ID password |
| `SWITCHDRIVE_ROOT` | A folder name owned by this application |

After deploying the secrets, sign in and inspect `/api/storage/status`. `available: true` means the server-side WebDAV check succeeded and original-file controls can be enabled.

The browser never receives the WebDAV credentials. Original bytes are streamed unchanged to managed storage, while D1 stores only submission state, paths, hashes, sizes, and related metadata.

## Upgrades

For an existing installation:

1. Review the release diff and new migrations before merging.
2. Keep the production deploy command migration-first.
3. Merge the tested version into the configured production branch.
4. Confirm the build log and `/api/ready`.
5. Run a small workflow smoke test when a release changes imports, comments, runs, or storage.

Applied D1 migrations are recorded and are not executed again.

## Local development and CLI deployment

Local development is optional:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

`AUTH_MODE=disabled` is only for local development. Local D1/R2 simulations do not contain production data by default.

An operator who prefers Wrangler can deploy from a trusted checkout:

```bash
npm run verify
npm run db:migrate:remote
npm run deploy
```

Confirm the active Cloudflare account and every binding before applying remote migrations.

## Backup and recovery

- Keep periodic full-system ZIP exports outside the Cloudflare account.
- D1 Time Travel can restore database state within the retention window offered by the account plan.
- Before any destructive restore, create a fresh export and record the current D1 bookmark.
- Managed original files are backed up according to the external storage provider's own retention and recovery rules.

## Security checklist

- No credentials, account identifiers, resource IDs, or deployment hostnames are committed to Git.
- The complete application hostname is covered by Access.
- The Worker validates the Access JWT issuer and audience.
- Sensitive runtime values are encrypted Worker secrets.
- D1 and R2 belong to the installing account and are not shared with another deployment.
- Preview branches cannot migrate or write production storage.
- Original-file credentials stay server-side and are never returned to the browser.
