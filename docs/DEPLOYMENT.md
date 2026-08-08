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

## 2. Configure the deployment environment

The checked-in `wrangler.jsonc` contains only application-level configuration. It deliberately omits Worker names, routes, D1 and R2 resource identifiers, and authentication values.

In the Worker's **Settings → Builds → Variables and secrets**, add these Build Variables:

| Variable | Value |
|---|---|
| `DEPLOY_WORKER_NAME` | The existing Worker name |
| `DEPLOY_D1_DATABASE_NAME` | The existing D1 database name |
| `DEPLOY_D1_DATABASE_ID` | The existing D1 database UUID |
| `DEPLOY_R2_BUCKET_NAME` | The existing private R2 bucket name |
| `DEPLOY_WORKERS_DEV` | `true` for a `workers.dev` deployment; otherwise `false` |

These identifiers are not credentials, so Build Variables are sufficient. The build generates `.wrangler/deploy.jsonc`, which is ignored by Git. Missing or malformed variables stop the build before migration or deployment; the generator never guesses or provisions a resource.

Do not add deployment identifiers back to `wrangler.jsonc`. Do not commit authentication secrets, storage passwords, Access identifiers, generated configuration, or deployment hostnames.

## 3. Connect the fork to Cloudflare Workers Builds

In **Cloudflare Dashboard → Workers & Pages**:

1. Create a Worker or connect an existing Worker to the GitHub fork.
2. Select `main` as the production branch.
3. Use the repository root as the root directory.
4. Set:

   ```text
   Build command:
   npm run build:deploy

   Deploy command:
   npm run deploy:remote
   ```

5. Under **Settings → Build → Branch control**, disable builds for non-production branches.

The deploy command regenerates the configuration, applies D1 migrations with that file, and then deploys the Worker bundle and static assets produced by the Vite build. Because the commands are joined with `&&`, a failed migration prevents code that expects the new schema from being deployed.

Do not use that remote-migration command for preview branches. If previews are introduced later, give them a separate Worker, hostname, D1 database, R2 bucket, and deploy command.

### v3 integration branch gate

`v2/backend-foundation` is an integration branch, not the production branch.
Even with dedicated preview resources, do not run its remote migrations or
deploy it until the
[v3 backend deployment gate](./V3_BACKEND_FOUNDATION.md#v3-deployment-gate) is
complete.

The normative requirements are in
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md), and the next code slice
is specified in
[blob lifecycle implementation plan](./BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md).
The gate requires one concurrency-safe retention-edge definition across
submission cancellation, scheduled cleanup, complete export, and future
permanent-delete planning.

Shared uploads, unfinished/retryable submissions, archived sources, and
soft-deleted ready sources must remain protected. Full export must preserve all
database rows, package each available blob once, and record unavailable bytes
in `export-warnings.json` instead of aborting the ZIP.

The implementation must add a dedicated check such as:

```text
npm run verify:blob-lifecycle
```

The normal v3 remote-migration and deployment commands must execute that check,
the complete test suite, and the deployment build before touching remote D1 or
storage. Passing an ordinary build or using resources isolated from `main` does
not waive the gate.

Until the implementation and dedicated tests are merged:

- do not apply v3 migrations to a remote D1 database;
- do not deploy the v3 Worker;
- keep non-production branch builds disabled;
- do not change the production resources used by `main`.

## 4. Protect the application with Cloudflare Access

Before storing real sample data:

1. In Cloudflare Zero Trust, create a **self-hosted Access application** for the complete hostname that will serve the app.
2. Add an Allow policy for the intended people or identity groups.
3. Copy the Access team domain and the application's Audience (AUD) tag.
4. Open the Worker, then go to **Settings → Variables and Secrets**.
5. Add these Runtime Variables:

   ```text
   AUTH_MODE=access
   ACCESS_TEAM_DOMAIN=https://<YOUR_TEAM>.cloudflareaccess.com
   ACCESS_AUD=<YOUR_ACCESS_APPLICATION_AUD>
   ```

6. Optionally add:

   ```text
   ALLOWED_EMAILS=user-one@example.org,user-two@example.org
   ```

`ALLOWED_EMAILS` is a second allowlist checked after the Access JWT has been validated. It is not a replacement for an Access policy.

These values describe the runtime environment but are not credentials. Actual tokens, passwords, and client secrets must use encrypted Secrets instead. The base Wrangler configuration sets `keep_vars: true`, so deployments preserve Runtime Variables managed in the Cloudflare dashboard.

The application is fail-closed when `AUTH_MODE=access`: protected API routes reject requests if Access is absent, misconfigured, or supplies an invalid issuer/audience.

## 5. Deploy and verify

Push or merge the application version to the production branch configured in Workers Builds. It should:

1. Install dependencies.
2. Run the repository's required verification and deployment build.
3. Apply every unapplied file in `migrations/` to the bound remote D1 database.
4. Deploy the Worker only after verification and migrations succeed.

Check the build log for the required status checks and either applied migration names or `No migrations to apply`.

Then verify:

1. An unauthenticated request to a protected API route is rejected.
2. After Access sign-in, `/api/ready` returns:

   ```json
   { "ok": true }
   ```

3. Create a disposable Sample and add a text Comment.
4. Add a compressed inline image and an external attachment link.
5. Confirm file-upload controls remain disabled if managed storage is not configured.
6. Import a representative FabuBlox workbook through the preview/confirm flow.
7. Download a ZIP export and inspect `export-manifest.json`, `export-warnings.json` when supported by that version, and at least one packaged asset.

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
2. Keep the production deploy command verification- and migration-first.
3. Merge the tested version into the configured production branch.
4. Confirm the build log and `/api/ready`.
5. Run a small workflow smoke test when a release changes imports, Comments, Runs, or storage.

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

An operator who prefers Wrangler can export the required `DEPLOY_*` values in a trusted shell and deploy from a trusted checkout:

```bash
npm run verify
npm run deploy
```

For v3, use the dedicated lifecycle/deployment gate added by the implementation
slice rather than bypassing it with a direct Wrangler command. Confirm the
active Cloudflare account and every binding before applying remote migrations.

## Backup and recovery

- Keep periodic full-system ZIP exports outside the Cloudflare account.
- D1 Time Travel can restore database state within the retention window offered by the account plan.
- Before any destructive restore, create a fresh export and record the current D1 bookmark.
- Managed original files are backed up according to the external storage provider's own retention and recovery rules.
- Treat export warnings about missing or unavailable bytes as integrity incidents; preserve the database export and investigate the provider separately.

## Security checklist

- No credentials or installation-specific identifiers are committed to Git. Each environment supplies its own Build Variables, Runtime Variables, and Secrets in Cloudflare.
- The complete application hostname is covered by Access.
- The Worker validates the Access JWT issuer and audience.
- Sensitive runtime values are encrypted Worker Secrets; non-secret runtime configuration uses Runtime Variables.
- D1 and R2 belong to the installing account and are not shared with another deployment.
- Preview branches cannot migrate or write production storage.
- Original-file credentials stay server-side and are never returned to the browser.
