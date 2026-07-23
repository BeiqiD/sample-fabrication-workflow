# Sample Fabrication Workflow

A sample-centered fabrication record for small research groups. It keeps reusable process plans separate from the work actually performed, so deviations, added steps, comments, images, attachments, and sample-state changes remain traceable without rewriting history.

This is intentionally not a general LIMS, inventory system, or enterprise MES. The project is optimized for physical samples that move through evolving research processes.

## Core model

- A **process template** describes what should be done. Templates are versioned and reusable.
- Starting a **process run** locks the selected template version into a sample-bound execution plan.
- A run records what was actually done. Operators can change actual parameters, skip work, document deviations, or insert ad-hoc steps while retaining the planned step for comparison.
- Each run preserves its initial substrate structure. Later runs can continue from the sample's derived current structure or start from the new template definition.
- Meaningful actions append to the sample timeline. Completed runs and verified sample states remain traceable as later work is added.
- An unused template version can be edited or deleted. Once referenced by a run, it becomes historical data and can only be archived.

These rules favor a durable and honest record of each physical sample. Groups with different approval, correction, or version-ownership rules should review the model before adopting the app.

## What it supports

- Create, search, pin, update, split, consume, lose, and store physical samples.
- Import FabuBlox Excel workbooks, including embedded process diagrams.
- Maintain versioned process/module/recipe families without changing records already assigned to samples.
- Run one process across one or several samples, with per-sample status, comments, parameter overrides, deviations, and additional steps.
- Track current structure, verified states, process lifecycle, sample notes, and a chronological timeline.
- Add compressed inline comment images, unchanged original-file attachments, and URL-only attachment links.
- Export portable ZIP archives containing structured data, Markdown summaries, and assets referenced by relative paths.

## Architecture

The application deploys as one Cloudflare Worker project.

| Component | Responsibility |
|---|---|
| React, React Router, Vite | Browser interface |
| Hono on Cloudflare Workers | API, authentication checks, exports, and storage orchestration |
| Cloudflare D1 | Samples, templates, runs, events, comments, hashes, and file metadata |
| Private Cloudflare R2 | Imported workbooks, diagrams, and compressed inline images |
| `ManagedStorage` adapter | Optional unchanged original files; currently supports SWITCHdrive over WebDAV |
| Cloudflare Access | User authentication; the Worker validates the Access JWT again before serving protected API routes |

Original-file storage is deliberately provider-neutral at the application boundary. Comment and run logic call `ManagedStorage`; provider-specific authentication and requests remain inside the adapter.

## Deploy your own instance

Every installation must use its own Cloudflare account, Worker name, hostname, D1 database, R2 bucket, Access application, and secrets. Do not deploy a fork until the installation-specific values in `wrangler.jsonc` have been replaced.

The recommended workflow needs no persistent local checkout:

1. Fork this repository.
2. In Cloudflare, create one D1 database and one private R2 bucket.
3. Edit `wrangler.jsonc` in your fork:
   - keep the binding names `DB` and `ASSETS`, because the code uses those names;
   - replace the Worker name, D1 database name and ID, and R2 bucket name;
   - remove or replace any route or custom-domain entry;
   - enable a `workers.dev` hostname or add a custom domain owned by your account.
4. Create or connect a Cloudflare Worker to the fork. The Worker name in Cloudflare must match `name` in `wrangler.jsonc`.
5. Configure Workers Builds:

   ```text
   Production branch: main
   Build command: npm run build
   Deploy command: npx wrangler d1 migrations apply DB --remote && npx wrangler deploy
   ```

   Disable non-production branch builds unless previews have separate D1/R2 resources and a separate deploy command.
6. Protect the application's complete hostname with a Cloudflare Access self-hosted application and an Allow policy.
7. In the Worker's runtime **Variables and Secrets**, add:

   ```text
   ACCESS_TEAM_DOMAIN=https://<YOUR_TEAM>.cloudflareaccess.com
   ACCESS_AUD=<YOUR_ACCESS_APPLICATION_AUD>
   ```

   `ALLOWED_EMAILS` is an optional comma-separated second allowlist. Store deployment-specific values as encrypted secrets rather than committing them to Git.
8. Push or merge the configuration to `main`. Workers Builds will compile the app, apply all unapplied D1 migrations, and deploy only if the migrations succeed.
9. Sign in through Access and confirm `/api/ready` returns `{"ok":true}`.

See [the full deployment guide](./docs/DEPLOYMENT.md) for a sanitized `wrangler.jsonc` example, first-deployment checks, upgrades, recovery, and optional SWITCHdrive setup.

## Optional original-file storage

The app works without an external file provider: text comments, compressed inline images, and attachment links remain available. Unchanged original-file uploads stay disabled until a managed-storage adapter passes its server-side connection check.

The included SWITCHdrive adapter uses HTTPS WebDAV with a dedicated App Passcode. Configure it only through Worker secrets:

```text
MANAGED_STORAGE_PROVIDER=switchdrive
SWITCHDRIVE_WEBDAV_URL=<YOUR_SWITCHDRIVE_WEBDAV_URL>
SWITCHDRIVE_USERNAME=<APP_PASSCODE_USERNAME>
SWITCHDRIVE_APP_PASSWORD=<APP_PASSCODE_PASSWORD>
SWITCHDRIVE_ROOT=<YOUR_STORAGE_ROOT>
```

The browser never receives these credentials. Original files are streamed unchanged to managed storage; no second R2 bucket is used as a fallback. See [comment file uploads](./docs/comment-file-uploads.md) for the storage and retry model.

## Local development

Local development is optional:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Cloudflare's Vite plugin runs the API in the Workers runtime with local D1 and R2 simulations. `AUTH_MODE=disabled` is intended only for local development.

Run the full verification suite with:

```bash
npm run verify
```

## Data ownership and backup

Exports contain JSON tables, Markdown summaries where applicable, and assets using relative paths; they do not depend on temporary signed URLs or a running deployment. Keep periodic full-system exports outside the deployment account.

## Further documentation

- [MVP scope](./MVP_SPEC.md)
- [Architecture and invariants](./docs/ARCHITECTURE.md)
- [Data model](./docs/DATA_MODEL.md)
- [FabuBlox import contract](./docs/FABUBLOX_IMPORT.md)
- [Deployment guide](./docs/DEPLOYMENT.md)
- [Comment and original-file uploads](./docs/comment-file-uploads.md)
