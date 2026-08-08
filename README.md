# Sample Fabrication Workflow

A Cloudflare Workers application for managing physical samples, fabrication recipes, metrology templates, process runs, execution comments, and attachments.

The repository is currently developing the v3 backend and reference foundation on the isolated `v2/backend-foundation` integration branch. The deployed production branch remains separate until the v3 migration, lifecycle, reference, and deployment gates are complete.

## Product principles

- A Template describes what should happen; a Run records what actually happened.
- Stable source and occurrence IDs are preserved through archive and soft deletion.
- Attachments are referenced by their logical occurrence, not by an R2 key or provider locator.
- Complete export preserves database history and reports unavailable physical bytes rather than silently omitting them.
- Reference resolution and search are read-only; Project insertion will be a later guarded server-side operation.

## Current capabilities

- Create, edit, split, archive, restore, and inspect Samples.
- Import and version process or metrology Templates.
- Start, update, complete, reopen, and inspect process or metrology Runs.
- Record Step status, comments, attachments, execution images, and Sample notes.
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

Deterministic reference search reads those same authoritative source and occurrence rows through type-specific queries. It uses explicit exact-ID, exact-primary, prefix, target-content, and metadata ranking tiers, then revalidates candidates through the resolver. Candidate backends carry a private specificity so byte-exact IDs and primary fields remain ahead of newer ASCII-folded fallbacks under both per-type candidate caps and final result limits. Query count, bindings, candidates, and resolver work are bounded, while the first source-scan backend still scales its row examination with the underlying tables.

The search domain contract is deployment-neutral. D1 currently supplies the portable SQLite query interface; a future Docker/self-hosted SQLite runtime can use the same contract, and a derived FTS5 backend can replace scans without becoming a second source of truth. Search reads do not register targets. Actual Project backlinks and insertion remain deferred until `project_items` exists rather than being represented by a parallel placeholder table.

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
   DEPLOY_R2_BUCKET_NAME=<bucket-name>
   DEPLOY_WORKERS_DEV=true|false
   ```

   The build generates an ignored `.wrangler/deploy.jsonc`. Do not add Worker names, D1/R2 identifiers, routes, hostnames, or credentials back to the checked-in base configuration.
5. Configure Workers Builds:

   ```text
   Build command: npm run build:deploy
   Deploy command: npm run deploy:remote
   Non-production branch deploys: disabled while v3 is isolated
   ```
6. Configure the Worker secrets and ordinary variables described in [Deployment](./docs/DEPLOYMENT.md), including Access audience/team data and optional managed-storage credentials.
7. Keep `AUTH_MODE=access` outside local development. `AUTH_MODE=disabled` is only for local verification. `ALLOWED_EMAILS` is an optional comma-separated second allowlist. Store passwords and tokens as encrypted Worker Secrets.
8. Merge only a tested release into the configured production branch. The normal deploy command runs the blob-lifecycle gate, reference host tests, Wrangler migration verification, real Worker/D1 resolver and deterministic-search smokes, complete tests, deployment build, remote D1 migrations, and Worker deployment in that order.
9. Sign in through Access and confirm `/api/ready` returns `{"ok":true}`.

`v2/backend-foundation` is an isolated integration branch, not a production branch. Its exact merged head must pass the dedicated v3 deployment gate before any isolated v3 remote migration or deployment is authorized.

## Local development

```bash
npm ci
npm run dev
```

The local configuration generator writes `.wrangler/deploy.jsonc` with non-production placeholder resources. The generated file is ignored by Git.

Useful commands:

```bash
npm test
npm run test:blob-lifecycle
npm run test:reference-foundation
npm run verify:d1-migrations
npm run verify:reference-worker
npm run verify:reference-search-worker
npm run verify:v3-deployment
npm run build
```

Do not run `db:migrate:remote`, `deploy:remote`, or `deploy` against a production installation until the isolated v3 branch has been reviewed, merged, and explicitly approved for activation.

## Export

Complete export includes all database tables, including archived, failed, cancelled, and soft-deleted records. Physical files are deduplicated by provider locator. Missing or unavailable bytes are recorded in `export-manifest.json` and `export-warnings.json` rather than aborting unrelated entries.

The first full-export implementation builds the ZIP in browser memory. Large archives may eventually need a streaming, server-side, or desktop export path.

## Documentation

- [Architecture](./docs/ARCHITECTURE.md)
- [Data model](./docs/DATA_MODEL.md)
- [v3 backend foundation](./docs/V3_BACKEND_FOUNDATION.md)
- [Project design foundation](./docs/PROJECT_DESIGN_FOUNDATION.md)
- [Reference registry and batch resolver implementation plan](./docs/REFERENCE_RESOLUTION_IMPLEMENTATION_PLAN.md)
- [Reference deep-link implementation plan](./docs/REFERENCE_DEEP_LINK_IMPLEMENTATION_PLAN.md)
- [Reference source-focus implementation plan](./docs/REFERENCE_SOURCE_FOCUS_IMPLEMENTATION_PLAN.md)
- [Deterministic reference search implementation plan](./docs/REFERENCE_SEARCH_IMPLEMENTATION_PLAN.md)
- [D1 SQL compatibility](./docs/D1_SQL_COMPATIBILITY.md)
- [FabuBlox import contract](./docs/FABUBLOX_IMPORT.md)
- [Deployment guide](./docs/DEPLOYMENT.md)
