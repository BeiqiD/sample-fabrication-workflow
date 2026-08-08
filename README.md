# Sample Fabrication Workflow

A sample-centered fabrication record for small research groups. It keeps reusable process plans separate from the work actually performed, so deviations, added steps, comments, images, attachments, and sample-state changes remain traceable without rewriting history.

This is intentionally not a general LIMS, inventory system, or enterprise MES. The project is optimized for physical samples that move through evolving research processes.

## Core model

- A **process template** describes what should be done. Templates are versioned and reusable.
- Starting a **process run** locks the selected template version into a sample-bound execution plan.
- A **metrology template** is a directly editable, flat record preset. Adding it to a process or starting it independently copies a snapshot; later run edits never update the template, and later template edits never rewrite existing records.
- A run records what was actually done. Operators can change actual parameters, skip work, document deviations, or insert ad-hoc steps while retaining the planned step for comparison.
- Each run preserves its initial substrate structure. Later runs can continue from the sample's derived current structure or start from the new template definition.
- Meaningful actions append to the sample timeline. Completed runs and verified sample states remain traceable as later work is added.
- An unused template version can be edited or moved to trash. Once referenced by a run, it remains historical data and is hidden from future assignment rather than being physically removed.

These rules favor a durable and honest record of each physical sample. Groups with different approval, correction, or version-ownership rules should review the model before adopting the app.

## What it supports

- Create, search, pin, update, split, consume, lose, and store physical samples.
- Import FabuBlox Excel workbooks, including embedded process diagrams.
- Maintain versioned process/module/recipe families without changing records already assigned to samples.
- Create reusable SEM, TEM, AFM, optical-microscope, XRD, or custom metrology templates directly in the Templates page, with template-only equipment notes and manuals.
- Insert metrology records between fabrication steps or run them independently without changing process progress, sample status, or current structure.
- Run one process across one or several samples, with per-sample status, comments, parameter overrides, deviations, and additional steps.
- Track current structure, verified states, process lifecycle, sample notes, and a chronological timeline.
- Add compressed inline comment images, unchanged original-file attachments, and URL-only attachment links.
- Export versioned ZIP archives containing complete table snapshots, available physical blobs, final per-blob outcomes, and non-fatal integrity warnings.
- Resolve stable Sample, Run, Step, Comment, attachment-occurrence, metrology-reference, and Recipe-revision identities through one authenticated read-only batch boundary.
- Open every current reference target through one opaque, refresh-safe canonical URL, with lifecycle-aware read-only behavior when an ordinary source route is unavailable.
- Follow canonical references into the exact Run Step, Comment, attachment, execution image, Sample note, or metrology reference while preserving source context and browser history.
- Search all nine current reference target types through one bounded, explainable, lifecycle-aware read-only service without creating registry rows or exposing physical storage locators.

## Architecture

The application deploys as one Cloudflare Worker project.

| Component | Responsibility |
|---|---|
| React, React Router, Vite | Browser interface |
| Hono on Cloudflare Workers | API, authentication checks, reference resolution and search, exports, scheduled cleanup, and storage orchestration |
| Cloudflare D1 | Samples, templates, runs, events, comments, reference registry, hashes, retention edges, GC ledger, and file metadata |
| Private Cloudflare R2 | Imported workbooks, diagrams, and compressed inline images |
| `ManagedStorage` adapter | Optional unchanged original files; currently supports SWITCHdrive over WebDAV |
| Cloudflare Access | User authentication; the Worker validates the Access JWT again before serving protected API routes |

Original-file storage is deliberately provider-neutral at the application boundary. Comment and run logic call `ManagedStorage`; provider-specific authentication and requests remain inside the adapter.

Blob reachability is derived from stable source and occurrence relationships. Soft deletion preserves those identities and their bytes. Cancel, scheduled cleanup, complete export, and future permanent-delete planning share the same retention definition; physical cleanup uses a provider-neutral D1 ledger and operation IDs.

Reference resolution is similarly source-owned. The sparse `reference_targets` registry stores stable identity and validation metadata, while the batch resolver reads current source tables and returns no source-mutation capability. Attachment references use occurrence IDs and never expose provider object keys. Canonical reference navigation uses a shared versioned opaque route codec rather than relying on browser percent-decoding semantics. Source focus is URL-owned, read-only, and restored through refresh, Back, and Forward; stable execution-image reads share the ordinary asset MIME and GC safety boundary.

Deterministic reference search reads those same authoritative source and occurrence rows through bounded type-specific queries. It uses explicit exact-ID, exact-primary, prefix, target-content, and metadata ranking tiers, then revalidates candidates through the resolver. Search reads do not register targets. Actual Project backlinks and insertion remain deferred until `project_items` exists rather than being represented by a parallel placeholder table.

## Deploy your own instance

Every installation must use its own Cloudflare account, Worker name, hostname, D1 database, R2 bucket, Access application, and secrets. Installation-specific identifiers are supplied as Cloudflare Build Variables; they are not committed to `wrangler.jsonc`.

The recommended workflow needs no persistent local checkout:

1. Fork this repository.
2. In Cloudflare, create one D1 database and one private R2 bucket.
3. Create or connect a Cloudflare Worker to the fork.
4. In **Workers Builds → Variables and secrets**, add:

   ```text
   DEPLOY_WORKER_NAME=<existing-worker-name>
   DEPLOY_D1_DATABASE_NAME=<database-name>
   DEPLOY_D1_DATABASE_ID=<database-uuid>
   DEPLOY_R2_BUCKET_NAME=<private-bucket-name>
   DEPLOY_WORKERS_DEV=true|false
   ```

   The build generates an ignored `.wrangler/deploy.jsonc`. Do not add Worker names, D1/R2 identifiers, routes, hostnames, or credentials back to the checked-in base configuration.
5. Configure Workers Builds:

   ```text
   Production branch: main
   Build command: npm run build:deploy
   Deploy command: npm run deploy:remote
   ```

   Disable non-production branch builds unless every preview has a separate Worker, hostname, D1 database, R2 bucket, and deployment command.
6. Protect the application's complete hostname with a Cloudflare Access self-hosted application and an Allow policy.
7. In the Worker's runtime **Variables and Secrets**, add:

   ```text
   AUTH_MODE=access
   ACCESS_TEAM_DOMAIN=https://<YOUR_TEAM>.cloudflareaccess.com
   ACCESS_AUD=<YOUR_ACCESS_APPLICATION_AUD>
   ```

   `ALLOWED_EMAILS` is an optional comma-separated second allowlist. Store passwords and tokens as encrypted Worker Secrets.
8. Merge only a tested release into the configured production branch. The normal deploy command runs the blob-lifecycle gate, reference host tests, Wrangler migration verification, real Worker/D1 resolver and deterministic-search smokes, complete tests, deployment build, remote D1 migrations, and Worker deployment in that order.
9. Sign in through Access and confirm `/api/ready` returns `{"ok":true}`.

`v2/backend-foundation` is an isolated integration branch, not a production branch. Its exact merged head must pass the dedicated v3 deployment gate before any isolated v3 remote migration or deployment is authorized.

See [the full deployment guide](./docs/DEPLOYMENT.md) for resource setup, first-deployment checks, upgrades, recovery, and optional SWITCHdrive setup. See [blob lifecycle activation and operations](./docs/BLOB_LIFECYCLE_OPERATIONS.md) for the integration-head gate, GC monitoring, incident rules, and explicit implementation limits.

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

For the v3 integration/deployment boundary, run:

```bash
npm run verify:v3-deployment
```

## Data ownership and backup

A full-system export preserves every database table row and packages each available physical locator once. Missing, unavailable, or integrity-mismatched bytes are recorded in `export-warnings.json` instead of aborting unrelated entries. Keep periodic verified ZIP exports outside the deployment account.

The first full-export implementation builds the ZIP in browser memory. Large archives therefore require an explicit scalability review and, eventually, a streaming/server-side or desktop export path. Opening and inspecting the generated archive is part of backup verification.

## Further documentation

- [MVP scope](./MVP_SPEC.md)
- [Architecture and invariants](./docs/ARCHITECTURE.md)
- [Data model](./docs/DATA_MODEL.md)
- [Project, Text, and Map design foundation](./docs/PROJECT_DESIGN_FOUNDATION.md)
- [v3 backend identity and lifecycle foundation](./docs/V3_BACKEND_FOUNDATION.md)
- [Blob lifecycle, export integrity, and permanent-delete contract](./docs/BLOB_LIFECYCLE_CONTRACT.md)
- [Blob lifecycle implementation plan](./docs/BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md)
- [Blob lifecycle activation and operations](./docs/BLOB_LIFECYCLE_OPERATIONS.md)
- [Reference registry and batch resolver implementation plan](./docs/REFERENCE_RESOLUTION_IMPLEMENTATION_PLAN.md)
- [Reference deep-link implementation plan](./docs/REFERENCE_DEEP_LINK_IMPLEMENTATION_PLAN.md)
- [Reference source-focus implementation plan](./docs/REFERENCE_SOURCE_FOCUS_IMPLEMENTATION_PLAN.md)
- [Deterministic reference search implementation plan](./docs/REFERENCE_SEARCH_IMPLEMENTATION_PLAN.md)
- [D1 SQL compatibility](./docs/D1_SQL_COMPATIBILITY.md)
- [FabuBlox import contract](./docs/FABUBLOX_IMPORT.md)
- [Deployment guide](./docs/DEPLOYMENT.md)
- [Comment and original-file uploads](./docs/comment-file-uploads.md)
