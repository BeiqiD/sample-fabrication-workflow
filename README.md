# Sample Fabrication Workflow

A sample-centered fabrication record for small research groups. It keeps reusable process plans separate from the work actually performed, so deviations, added steps, comments, images, attachments, and sample-state changes remain traceable without rewriting history.

This is intentionally not a general LIMS, inventory system, or enterprise MES. The project is optimized for physical samples that move through evolving research processes.

## Development status

The active V3 integration line is `v2/backend-foundation` (last merged
checkpoint `474a038`); `main` has not received its first integrated V3 release.
A **separate synchronized development branch** at `3c1baf5`
contains locally qualified FP2–FP5 and C4/5D/5E changes, bounded 5F implementation
and follow-up research read-error, receipt and job-control ownership repairs,
not yet merged/deployed. **5F remains in progress**; complete
local and exact-head remote gates are not yet qualified at this checkpoint.
This README distinguishes that **development V24** from the **deployed V20**
runtime. See the [version-aware roadmap](./docs/PRODUCT_ROADMAP.md#current-checkpoint)
before using any capability on a live installation.

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
- Write Sample-note and process-Comment text with safe GFM/TeX rendering while keeping compressed images, unchanged original-file attachments, and URL-only links in the existing separate attachment flow.
- Export versioned ZIP archives containing complete table snapshots, available physical blobs, final per-blob outcomes, and non-fatal integrity warnings.
- Resolve stable Sample, Run, Step, Comment, attachment-occurrence, metrology-reference, and Recipe-revision identities through one authenticated read-only batch boundary.
- Open every current reference target through one opaque, refresh-safe canonical URL, with lifecycle-aware read-only behavior when an ordinary source route is unavailable.
- Follow canonical references into the exact Run Step, Comment, attachment, execution image, Sample note, or metrology reference while preserving source context and browser history.
- Search all nine current reference target types through one bounded, explainable, lifecycle-aware read-only service without creating registry rows or exposing physical storage locators.
- Create and open Projects, organize occurrences on a desktop Map with explicit Save and bounded autosave, switch desktop into deterministic Reading, and use Reading as the mobile default while editing only existing Project-owned Markdown and attachment metadata.
- Use one reusable, Project-oriented search and selection surface to find stable targets. Project now embeds discovery and authoritative repeated-reference insertion; the current `/search` page remains a thin reference browser and integration harness.

## Architecture

The application deploys as one Cloudflare Worker project.

| Component | Responsibility |
|---|---|
| React, React Router, Vite | Browser interface |
| Hono on Cloudflare Workers | API, authentication checks, reference resolution and search, exports, scheduled cleanup, and storage orchestration |
| Cloudflare D1 | Samples, templates, runs, events, comments, reference registry, hashes, retention edges, GC ledger, and file metadata |
| Private Cloudflare R2 | Default destination for both ordinary/internal files and unchanged originals after FP1 |
| File registry and exact-profile adapters | Logical File locations and lifecycle; historical SWITCHdrive/WebDAV access. Native S3 is implemented in the separate local successor and is not qualified on the historical deployed V20 runtime. |
| Cloudflare Access | User authentication; the Worker validates the Access JWT again before serving protected API routes |

File reads resolve their recorded profile and location. New writes select a storage role at acceptance, and retries retain that destination. Provider authentication and requests remain inside adapters; changing a future default will not migrate old files.

User-authored Project Markdown and displayed Sample-note and process-Comment bodies share one client-side safe rich-text renderer. Project Reading uses document spacing and allows ordinary Markdown images; Comment surfaces use compact spacing, preserve single line breaks, demote Markdown image syntax to safe links, and continue to display uploaded images/files through the existing attachment model. Source strings remain authoritative in D1; generated HTML and MathML are never persisted.

Blob reachability is derived from stable source and occurrence relationships. Soft deletion preserves those identities and their bytes. Cancel, scheduled cleanup, complete export, and future permanent-delete planning share the same retention definition; physical cleanup uses a provider-neutral D1 ledger and operation IDs.

Reference resolution is similarly source-owned. The sparse `reference_targets` registry stores stable identity and validation metadata, while the batch resolver reads current source tables and returns no source-mutation capability. Attachment references use occurrence IDs and never expose provider object keys. Canonical reference navigation uses a shared versioned opaque route codec rather than relying on browser percent-decoding semantics. Source focus is URL-owned, read-only, and restored through refresh, Back, and Forward; stable execution-image reads share the ordinary asset MIME and GC safety boundary.

Deterministic reference search reads those same authoritative source and occurrence rows through type-specific queries. It uses explicit exact-ID, exact-primary, prefix, target-content, and metadata ranking tiers, then revalidates candidates through the resolver. Query count, bindings, candidates, and resolver work are bounded, while the first source-scan backend still scales its row examination with the underlying tables.

The reusable reference-search surface keeps committed state separate from form drafts, submits explicitly instead of scanning on every keystroke, renders server order without client-side scoring, and returns a stable `ReferenceTarget` without registering it or writing source data. Project embeds that surface for authoritative repeated-reference placement, while the URL-owned `/search` page remains a thin browser and integration harness rather than a second insertion workflow.

The Map-first Project model stores one immutable per-Project `created_sequence` on each item occurrence. The desktop Map dynamically loads React Flow and persists compact placement mutations rather than frontend graph JSON. Reading projects those same occurrences in insertion order, is selectable on desktop and the default on mobile, keeps references read-only, and allows only existing Project-owned Markdown plus attachment caption/source-URL edits. It has no separate Reading-placement table, creation flow, manual reorder, or edge-derived ordering until real use justifies a later dedicated design.

The search domain contract is deployment-neutral. D1 currently supplies the portable SQLite query interface; a future Docker/self-hosted SQLite runtime can use the same contract, and a derived FTS5 backend can replace scans without becoming a second source of truth. Search reads do not register targets. Project backlinks derive from authoritative `project_items`, and insertion registration remains confined to the Project mutation boundary rather than a parallel placeholder table.

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
   It resolves the account from the standard `CLOUDFLARE_ACCOUNT_ID` variable or the sole account returned by the existing Wrangler build authentication; multi-account setups must provide the intended account. The same account and bucket are recorded in the runtime import storage namespace. See [deployment identity](docs/DEPLOYMENT.md#2-configure-the-deployment-environment).
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
8. Merge only a tested release into the configured production branch. The normal deploy command runs the blob-lifecycle, Reference, Project persistence, and Project Map gates, Wrangler migration and Worker/D1 smokes, complete tests, deployment build, remote D1 migrations, and Worker deployment in that order.
9. Sign in through Access and confirm `/api/ready` returns `{"ok":true}`.

`v2/backend-foundation` is an isolated integration branch, not a production branch. Its exact merged head must pass the dedicated v3 deployment gate before any isolated v3 remote migration or deployment is authorized.

See [the full deployment guide](./docs/DEPLOYMENT.md) for resource setup, first-deployment checks, upgrades, recovery, and optional SWITCHdrive setup. See [blob lifecycle activation and operations](./docs/BLOB_LIFECYCLE_OPERATIONS.md) for the integration-head gate, GC monitoring, incident rules, and explicit implementation limits.

## File storage and Settings

The accepted FP1 integration uses the existing R2 profile for both ordinary/internal
files and unchanged originals. Original uploads do not require SWITCHdrive.
Authenticated Storage Settings shows current destinations and configuration status.

Historically deployed FP2 adds administrator-scoped candidates, encrypted
credentials, checks and AWS S3 **read-only** profile admission under V20.
The **synchronized local implementation** adds native S3 File read/write,
publication/GC, independent internal/original role defaults and accepted
per-purpose destinations (`0018`/V21), with persistent migration jobs
(`0019`/V22). Those capabilities have local qualification **but have not been
integrated, deployed or validated against a real AWS provider**. A configured
candidate or local test does not make an upload destination active on the
existing deployment. See [phase and release gates](./docs/PRODUCT_ROADMAP.md#fp2-completion-units).

Historical SWITCHdrive files continue to use their recorded provider and require
working HTTPS WebDAV credentials. Configure that environment-backed adapter
through Worker variables/secrets; passwords and tokens belong in encrypted Secrets:

```text
MANAGED_STORAGE_PROVIDER=switchdrive
SWITCHDRIVE_WEBDAV_URL=<YOUR_SWITCHDRIVE_WEBDAV_URL>
SWITCHDRIVE_USERNAME=<APP_PASSCODE_USERNAME>
SWITCHDRIVE_APP_PASSWORD=<APP_PASSCODE_PASSWORD>
SWITCHDRIVE_ROOT=<YOUR_STORAGE_ROOT>
```

Stored provider credentials are never returned to the browser. Provider failure is reported;
no hidden fallback redirects an accepted operation. Bootstrap bindings/root keys
remain deployment configuration, while optional external candidates are managed
through the administrator Settings surface. See [deployment](./docs/DEPLOYMENT.md)
and the [File/data plan](./docs/FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md).

## Local development

Local development is optional:

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Cloudflare's Vite plugin runs the API in the Workers runtime with local D1 and R2 simulations. `AUTH_MODE=disabled` is intended only for local development.

The local migration script explicitly uses `.wrangler/state`, matching Vite's
storage directory. Use `--persist-to .wrangler/state` for other local D1 commands
as well; the generated configuration lives in `.wrangler/`, so Wrangler's default
would otherwise point at a different database.

Run the full verification suite with:

```bash
npm run verify
```

For the v3 integration/deployment boundary, run:

```bash
npm run verify:v3-deployment
```

## Data ownership and backup

The **deployed** complete content writer remains **V20**, writer **1**,
`fp2-native-profile-admission`. It retains canonical rows and available bytes
plus nonsecret S3 admission metadata, but not installation candidate secrets,
check history or root keys. Missing/unavailable/mismatched bytes still appear
as explicit `export-warnings.json` outcomes; a partial content archive is not
a complete system backup. The older browser ZIP path needs its own measured
memory ceiling.

The **synchronized, not deployed** implementation adds V21 native File archive,
V22 migration-job archive, V23 native Sample/**Project** export with matching
website **fresh-copy** import plus offline HTML/Markdown reports, and V24
privileged system backup/website **identity-preserving** recovery. These
separate V1 product envelopes use bounded streaming and persisted job execution.
Research packages have a 100 MiB complete-archive ceiling, 96 MiB File payload
ceiling, 100 Files, 1,200 records and 20 roots. They are not unlimited and local
workerd/S3 fixtures are not real-provider release tests. The system recovery
handoff still requires an independently provisioned fresh target and operator
approval; restored execution starts disabled. See
[FP4 local design](https://github.com/BeiqiD/sample-fabrication-workflow/blob/2060c745376862a379e8c952ee87c05d49982e02/docs/FP4_RESEARCH_PACKAGES.md),
[FP5 local goal](https://github.com/BeiqiD/sample-fabrication-workflow/blob/2060c745376862a379e8c952ee87c05d49982e02/docs/FP5_DEVELOPMENT_GOAL.md) and
[current release limits](./docs/PRODUCT_ROADMAP.md#near-term-order-and-first-integrated-release).

`npm run verify:export-restore -- --archive backup.zip --destination NEW_LOCAL_DIRECTORY --target-schema S2`
rehearses a trusted supported archive against current migrations in a new isolated
SQLite database and blob directory. It refuses an existing target, verifies
schema/rows/bytes and restores local execution paused. Historical readers remain
supported. See [isolated recovery](./docs/EXPORT_RESTORE_REHEARSAL.md) for limits
and the separate remote recovery boundary.

The integration line uses the immutable S2 baseline plus forward FP migrations.
Historical S0 SQL is retained in `migrations-history/s0/`; explicit historical
recovery uses `--migrations-dir migrations-history/s0 --target-schema S0`.
The completed same-D1 test rebuild is historical, not a routine upgrade procedure.

The [2026-10-01 FP1 acceptance](./docs/FP1_R2_ROLE_DEFAULTS.md#live-acceptance--2026-10-01)
records the 6 MiB R2 round trip and V19 recovery with 15/15 byte entries. V20
automated paired recovery passed; its live ZIP download/isolated restore was
explicitly waived after a browser download failure. Preserve this distinction
and repeat live archive exercises only for material persistence/addressing/
archive/recovery changes or investigation of a real export defect.

Historical conversion utilities are version-scoped diagnostics rather than
current universal migration tools: [FP1g planner](./docs/FP1_FILE_CONSUMER_MIGRATION_PLAN.md),
[V14 consumer inspection](./docs/FP1_SHADOW_CONVERSION_PREFLIGHT.md), and
[shadow runtime/inspection](./docs/FP1_SHADOW_RUNTIME.md). Their frozen inputs
remain historical, not a substitute for the separate synchronized FP3 job and V22 archive implementation.

## Further documentation

- [MVP scope](./MVP_SPEC.md)
- [Architecture and invariants](./docs/ARCHITECTURE.md)
- [Data model](./docs/DATA_MODEL.md)
- [Product goal and roadmap](./docs/PRODUCT_ROADMAP.md)
- [Long-term roadmap](./docs/LONG_TERM_ROADMAP.md)
- [Proposed file storage architecture](./docs/FILE_STORAGE_ARCHITECTURE.md)
- [Proposed reports, data packages and system recovery](./docs/DATA_EXPORT_IMPORT_DESIGN.md)
- [File/data portability implementation and compatibility plan](./docs/FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md)
- [FP1a file registry implementation boundary](./docs/FP1_FILE_REGISTRY_FOUNDATION.md)
- [FP1b byte-reader and legacy route boundary](./docs/FP1_BYTE_READER_BOUNDARY.md)
- [FP1c verified writes and bounded hashing](./docs/FP1_VERIFIED_BYTE_WRITES.md)
- [FP1d deletion and fenced GC recovery](./docs/FP1_FENCED_BYTE_DELETION.md)
- [FP1e import recovery byte verification](./docs/FP1_RECOVERY_BYTE_VERIFICATION.md)
- [FP1f durable import acceptance](./docs/FP1_DURABLE_IMPORT_ACCEPTANCE.md)
- [FP1g historical consumer conversion plan](./docs/FP1_FILE_CONSUMER_MIGRATION_PLAN.md)
- [FP1h durable ordinary/Project upload acceptance](./docs/FP1_DURABLE_R2_UPLOAD_ACCEPTANCE.md)
- [FP1i metrology reference acceptance](./docs/FP1_METROLOGY_REFERENCE_ACCEPTANCE.md)
- [FP1j durable Comment acceptance](./docs/FP1_COMMENT_ACCEPTANCE.md)
- [FP1k additive File-authority transition](./docs/FP1_FILE_AUTHORITY_TRANSITION.md)
- [File shadow runtime and versioned recovery](./docs/FP1_SHADOW_RUNTIME.md)
- [Historical File evidence review and adjudication boundary](./docs/FP1_HISTORICAL_EVIDENCE_REVIEW.md)
- [Live File consumer preflight and shadow-conversion protocols](./docs/FP1_SHADOW_CONVERSION_PREFLIGHT.md)
- [V3 architecture stabilization plan](./docs/V3_ARCHITECTURE_STABILIZATION_PLAN.md)
- [Current Map-first Project design foundation](./docs/PROJECT_DESIGN_FOUNDATION.md)
- [Project Canvas interaction contract](./docs/PROJECT_CANVAS_INTERACTION_CONTRACT.md)
- [Project Map kernel implementation record](./docs/PROJECT_MAP_KERNEL_IMPLEMENTATION_PLAN.md)
- [Project Map kernel review checklist](./docs/PROJECT_MAP_KERNEL_REVIEW_CHECKLIST.md)
- [v3 backend identity and lifecycle foundation](./docs/V3_BACKEND_FOUNDATION.md)
- [Blob lifecycle, export integrity, and permanent-delete contract](./docs/BLOB_LIFECYCLE_CONTRACT.md)
- [Blob lifecycle implementation plan](./docs/BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md)
- [Blob lifecycle activation and operations](./docs/BLOB_LIFECYCLE_OPERATIONS.md)
- [Reference registry and batch resolver implementation plan](./docs/REFERENCE_RESOLUTION_IMPLEMENTATION_PLAN.md)
- [Reference deep-link implementation plan](./docs/REFERENCE_DEEP_LINK_IMPLEMENTATION_PLAN.md)
- [Reference source-focus implementation plan](./docs/REFERENCE_SOURCE_FOCUS_IMPLEMENTATION_PLAN.md)
- [Deterministic reference search implementation plan](./docs/REFERENCE_SEARCH_IMPLEMENTATION_PLAN.md)
- [Project reference search surface implementation plan](./docs/REFERENCE_SEARCH_UI_IMPLEMENTATION_PLAN.md)
- [D1 SQL compatibility](./docs/D1_SQL_COMPATIBILITY.md)
- [FabuBlox import contract](./docs/FABUBLOX_IMPORT.md)
- [Deployment guide](./docs/DEPLOYMENT.md)
- [Comment and original-file uploads](./docs/comment-file-uploads.md)
