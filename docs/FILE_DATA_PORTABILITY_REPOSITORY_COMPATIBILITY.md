# File/data portability: repository compatibility review

Status: static cross-module review and proposed implementation requirements;
not runtime, migration or deployment acceptance.

Reviewed on 2026-09-13 against development branch `v2/backend-foundation` at
`4e78fa76b727f81b1431b60ff481bd686d83cb4c` and documentation PR #207 at
`bfbe2762e7a12d6323ccb32896ba3ef91be87fda`, before this follow-up. The PR changes
Markdown, not the application code at that development checkpoint.

This supplements the [FP implementation plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md)
and its [execution gates](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md#reviewed-execution-decisions-and-implementation-gates).
It does not introduce another phase order. The [product roadmap](./PRODUCT_ROADMAP.md)
owns priority; the [file architecture](./FILE_STORAGE_ARCHITECTURE.md) and
[data design](./DATA_EXPORT_IMPORT_DESIGN.md) own the proposed target contracts.

## Review conclusion and scope

The target is compatible with the repository's source/occurrence identity model,
Map/Reading separation, canonical Comments, immutable content-addressed history,
recoverable deletion and later runtime portability. It is **not** a drop-in
replacement of the two current storage functions. Several public contracts,
source queries, database guards and executable verification assumptions must
change together before implementation can claim compatibility.

This is a repository-wide boundary/impact review: current schema definitions,
shared contracts, representative source and frontend consumers, export/recovery,
build/migration verification and governing documentation were inspected at the
pinned revision. It is not a claim that every implementation/test line was read,
that the complete repository was executed locally, or that future FP behavior
passed tests. Required evidence below is prospective, not a test result.

Database-resident Markdown, canonical JSON and relational records remain domain
data. Uniform file management does not require converting every string or row
into a File, externalizing the database, or storing React Flow state as authority.
Bundled application assets are also distinct from managed research files.

## Cross-module compatibility map

| Boundary and inspected source | Current coupling or invariant | Required FP treatment |
| --- | --- | --- |
| [Worker composition](../worker/index.ts) and [shared ownership](../shared/README.md) | Worker routes use Cloudflare bindings; shared contracts/domain are pure and dependency-constrained. | FP1 introduces narrow runtime seams without moving provider/SQL/job services into shared or redoing unaffected domain extraction. |
| [S2 schema](../migrations/0001_v3_baseline.sql) and [baseline test](../scripts/current-schema-source.test.mjs) | Active SQL is the exact S2 baseline; the test currently permits no later SQL file. | First FP1 schema slice admits reviewed forward suffixes while retaining baseline/history hashes and qualifying populated upgrades. |
| [Registration](../worker/blob-lifecycle/registration.ts), [ingestion](../worker/attachment-ingestion.ts) and [storage dispatch](../worker/blob-lifecycle/storage.ts) | R2/managed handles, candidate registration, dedup and GC checks are embedded in the current two-path model. | Replace locator representations, uniqueness and authoritative retention together; adding registry tables alone leaves old behavior active. |
| [Sample directory](../worker/samples/routes.ts) and [split-state preparation](../worker/sample-split-state.ts) | Thumbnail queries join R2 assets; split consistency captures occurrence, asset, hash, key and position. | FP1 converts source queries and guarded writes, preserving structure meaning, ordered images and split snapshots under migration. |
| [Template routes](../worker/process-definition/routes.ts) and [publication helpers](../worker/template-publication.ts) | Definitions/states, source workbooks and imported assets have template-specific publication rules. | Preserve process/metrology distinctions and provenance; universal Files must not bypass owning-import publication. |
| [Comment contract](../shared/contracts/comment-submissions.ts) and S2 Comment tables | Image/attachment/link kinds, reciprocal preview-original relationships, common targets and bounded retries are domain/API behavior. | FP1 separates these kinds from storage purpose; changing originals to R2 must update capability checks and all consumers, not remove original/preview distinctions. |
| [Reference contract](../shared/contracts/reference-types.ts) and [routes](../worker/reference-routes.ts) | Nine closed source types, bounded resolution and source-specific navigation; Files are not public Reference targets. | Keep source/occurrence identity stable. FP4 must explicitly represent unresolved imported dependencies rather than fabricate or retarget local sources. |
| [Project API](../shared/contracts/project-api.ts), [geometry contract](../shared/contracts/project-types.ts) and S2 Project tables | Attachment locators are an asset/managed-object union; content/item/placement/edge IDs and revisions are distinct. | FP1 updates the versioned locator boundary. FP4 reconstructs the Project graph under its actual ownership, ordering, numeric and lifecycle constraints. |
| [Sample export](../src/lib/exportSample.ts) and [Project attachment presentation](../src/lib/project-owned-content.ts) | Sample export enumerates image keys from page DTOs; frontend preview/geometry decisions use MIME and mutation outcomes. | Adapt DTOs and consumers without changing rendering meaning, uncertain-result handling or committed geometry. Old page exports are not native package serializers. |
| [Export catalog](../worker/export-catalog.ts), [v8 snapshot](../worker/export-v8-snapshot.ts) and [coverage test](../worker/export-schema-coverage.test.ts) | Explicit tables/views, negotiated compatibility projection and locator-derived file inventory. | Every schema slice updates versioned writer/reader/catalog/retention coverage; new settings/secrets/jobs require explicit recovery classification. |
| [Offline restore](../scripts/lib/export-restore.ts) and [CLI](../scripts/verify-export-restore.mjs) | Trusted bounded archives, exact table/column matching and isolated Node/SQLite reconstruction; not a live importer. | Preserve v7/v8 fixtures. FP4/FP5 need explicit conversion, untrusted admission, safe publication and deployment-specific execution. |
| [Application shell](../src/App.tsx) and [frontend plan](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md) | Lazy routes, existing `/export`, current local light/night preference, protected Canvas and source UI behavior. | Add Settings/data routes with compatible navigation and lazy loading; do not reopen completed controls or claim basic theme support is absent. |
| [Deployment generator](../scripts/generate-wrangler-config.mjs) and [package scripts](../package.json) | Deploy config requires a named R2 bucket and emits `ASSETS`; build/deploy run Cloudflare-specific generation and verification. | File operations independent of R2 do not yet prove an R2-free deploy. Later binding retirement and Docker build composition require explicit tooling changes. |

## Required clarifications exposed by this review

### 1. Preserve current data semantics, not obsolete documentation

The previous `DATA_MODEL.md` still described Projects/backlinks as future work,
independent Text/Map placements, registration after provider writes, and an active
`samples.process_revision`. Those descriptions contradicted the inspected S2
schema, registration path and Project API. This follow-up corrects them and adds
the missing Project, derivative and quarantine tables to the current inventory.
`shared/README.md` now includes the existing export/schema helper modules and
states where shared archive machinery may actually live.

Do not "fix" historical evidence by modifying immutable SQL bytes or deleting
compatibility code solely because its names look old. The S2 baseline's generated
header is retained provenance, explained by [its README](../migrations/README.md).
The export catalog's historical Sample/Comment field lists are overridden by the
actual v8 snapshot before query execution; their presence alone is not evidence
of a broken S2 export. Current-state descriptions, historical qualifications and
new target requirements must remain distinguishable.

### 2. File routing and client protocols must migrate together

`requiresManagedStorage()` currently returns true for every Comment attachment.
Project attachment creation accepts exactly one of `assetId` and `storageObjectId`.
Sample export and source thumbnails directly use asset keys. These contracts do
not automatically become provider-neutral when a File table is added.

The FP1 inventory must include validators, DTO serialization, client capability
messages, upload acceptance and retry, source previews, downloads, directory
thumbnails and existing readable exports. Maintain a tested compatibility bridge
or negotiated stale-client rejection; do not silently reinterpret an old field as
a File ID. Preserve current limits until a separately qualified transfer contract
changes them. "Universal storage" does not mean all sizes/formats are accepted.

`comment_image`, `attachment` and `link` remain occurrence kinds, not provider
names or the five File purposes. Preserve TIFF-original requirements, reciprocal
relationships, captions and ordering. The application's simple Comment editor
and Markdown source contract do not become a general rich-text/file editor.

### 3. Source history includes non-file and non-FK relationships

Storage migration must not change Sample status, process/metrology classification,
plan alignment, verification coverage or historical content hashes. In particular,
convert the physical-key assumptions in split guards without weakening their
source-change detection. A location move does not change the research structure;
changed source bytes or image order do. Revalidate both same-hash/unchanged-state
and genuine source-change conflicts, with retained read/GC protection.

Native import needs a typed relationship inventory beyond foreign keys. The S2
schema includes Sample parent links, run groups/predecessors/anchors, current plan
pointers, effective-after-step IDs, common Comment operation groups, verification
predecessors and ordered coverage, plus IDs/locators embedded in event metadata.
Preserve those meanings through explicit destination mappings. Do not copy a
foreign group token into an unrelated local operation, rewrite arbitrary user
text, or assume every meaningful relationship is discoverable by foreign-key
inspection. Unsupported required relationships block native publication.

A copied Sample does not automatically include all siblings, every use of its
Template, or every target of a common Comment. Before FP4 ships, define and test
closure for all nine Reference types: required owning context and immutable
history, authorized shared records once, included common-target contexts, and
explicit exclusions. Keep source identity/provenance for excluded relationships
without leaking unauthorized labels or inventing destination parents. Do not
call a package fully self-contained if required relationships remain excluded.

### 4. Fresh IDs and partial import must satisfy actual domain constraints

The existing Project schema requires a content/reference subtype, ownership,
unique creation sequence and one stored placement at most; product publication
requires a placement for each active item. A content row belongs to one item;
repeated source References are allowed. Edges connect items within a Project,
not arbitrary global IDs. Preserve handles, dimensions, z-order, Reading order
and deletion-operation groupings. Reconcile `next_created_sequence` with imported
items, including retained historical rows, rather than reusing a display number.

Fresh IDs alone do not resolve Sample-code or Template-family/name/version
uniqueness. Validate import into a non-empty destination, freeze the displayed
conflict-resolution mapping at acceptance, and record original names separately
when destination names must change. Do not silently reuse existing business
objects by matching those names. Preserve supported canonical content hashes as
specified in [the data design](./DATA_EXPORT_IMPORT_DESIGN.md#13-identity-and-recovery-cutover-clarifications).

The current Reference registry is not a foreign-identity placeholder service.
Do not insert an untrusted source-installation ID as though it were a local source,
retarget an immutable registry row later, or misuse `tombstoned` for an excluded
package dependency. Unresolved provenance needs a reviewed representation that
cannot resolve accidentally to an unrelated local object. If current item/DTO
constraints cannot represent that state, keep the import unpublished and report
it as unsupported; do not weaken existing guards. Complete-package import can
ship before broader salvage states only with an explicit supported-mode boundary.

### 5. Online import cannot reuse offline trigger suspension

The current publication helper covers FabuBlox-owned templates and assets.
Sample/Processing directory queries do not contain a general package-import
visibility predicate. An import-job flag added in isolation would therefore not
hide partially inserted Samples, Projects, search results or backlinks.

FP4 must qualify its staging/publication strategy across every read, mutation,
resolver/search, media and export boundary. A staged-record area or reviewed
consistent visibility gate is required; success cannot mean only that the upload
route knows the operation is pending. Failed/cancelled staging belongs to explicit
operational recovery, not ordinary visible research data.

The offline utility deliberately loads exact historical rows with triggers
removed in a newly created, isolated database, reinstalls the original schema,
and validates final relationships. Do not transplant that procedure into a live
D1/SQLite package importer. Likewise, replaying normal UI mutations may generate
new timeline events or alter current state rather than preserve history. Define
import-specific publication and separate original actor/time provenance from the
actual destination import actor. The live source and unrelated records must
remain protected throughout.

### 6. Export coverage also needs a security and operational classification

The current coverage test rejects every unexported application table and
unclassified view; the recovery reader requires an exact catalog and column set.
Thus File/location/profile tables cannot be added while assuming v8 or a generic
JSON serializer will remain a complete restore path. Preserve historical readers
and explicitly qualify the new protocol/converter when the first schema changes.

The same issue applies to FP2 secrets and FP3 jobs. Do not mechanically add
`SELECT *` over new credential tables to a downloadable archive, nor silently
omit new canonical state to make a test pass. Distinguish canonical research,
eligible privileged configuration, separately protected credential recovery,
reconstructible projections and non-executable operational provenance. Use an
explicit reviewed classification with tests rejecting unknown omissions and
credential leakage. Restoring a job record must not restart source-side writes
or GC. Retention coverage must include every old and new location root.

### 7. Runtime independence extends to build and deployment tooling

The existing shared boundary forbids external libraries and ambient Node/Worker
services. Reusing one archive protocol does not authorize putting JSZip, storage
SDKs, filesystem access, database repositories or a scheduler in `shared/`.
Share protocol types and pure validation there; compose reusable application
services and runtime adapters outside that boundary.

The Cloudflare generator currently requires `DEPLOY_R2_BUCKET_NAME` and emits
an `ASSETS` binding on every deployment. The first suffix also conflicts with
the baseline-only assertion in `current-schema-source.test.mjs`. These are real
executable assumptions, not merely documentation terminology. Update affected
gates with the implementation, preserving safety rather than disabling checks.

Distinguish "no authoritative files or runtime reads depend on old R2" from
"the deployment can omit its R2 binding". The latter additionally needs config,
Env typing, readiness and test-tooling qualification. Do not remove the current
binding as a shortcut. Docker similarly needs its own build/start composition,
authentication and persistent-volume verification; the current npm build invokes
Cloudflare configuration and is not a ready server-distribution command.

### 8. FP frontend work is bounded but not absent

Preserve the actual Project mutation/conflict/uncertain-result state machines,
source navigation and responsive behavior when changing file contracts. Settings
and package preview/progress are FP-owned UI, not a reason to repeat completed
Canvas keyboard/editor/panel work. Test `/export` compatibility when moving its
entry point; keep expensive archive/provider code outside the eagerly loaded
shell and ordinary Map path. Keep the existing light/night preference intact.

The frontend plan remains authoritative for visual/interaction rules within its
scope; its earlier backend checkpoint wording does not override the Product
roadmap's later FP ordering. Outstanding C4/S2/6A6 checks remain explicit. Do not
turn a documentation compatibility review or green unchanged-code CI into their
acceptance.

## Minimum implementation evidence by milestone

| Milestone | Repository-specific evidence required in addition to the FP plan |
| --- | --- |
| FP1 | Populated S2-to-new-schema upgrade and fresh install; matched new export/restore; old/new API-client matrix; Comment attachment upload to R2 without the old managed-only gate; Sample directory/Processing/Timeline images, split inheritance and Template provenance after conversion; every retention root and safe media path. |
| FP2 | Profile/default editing under explicit administrator checks; approved credential/config export policy; original/preview semantics unchanged through different destinations; shared-boundary and frontend bundle gates preserved. |
| FP3 | Races involving real source/Project retention, cancellation and stale attempts; file migration without changing semantic state/revisions; no hidden authoritative R2 read, with binding-retirement support stated separately. |
| FP4 | Non-empty destination with name conflicts; all nine Reference types and their closure; cross-Sample common Comments, split lineage, process/metrology history and verification; Project sequence/geometry/Trash invariants; pending data invisible to directories/search/media/export; unsupported partial states rejected without fake local references. |
| FP5 | New and historical protocol fixtures; exact canonical history with destination-specific physical mappings; current schema protections reinstated and validated; secrets/old jobs safe; same-bucket recovery isolation and operator-controlled final cutover. |

Use the existing verification graph in [package.json](../package.json): source and
mounted tests, shared-boundary checks, storage/lifecycle/Reference/Project gates,
D1/Worker verification and bundle checks. Add targeted fixtures where the new
behavior requires them; merely keeping old suites green is insufficient.
Do not weaken fixed invariants just to make a new schema pass. Conversely, do not
freeze historical migration count or provider-specific representations forever
when a reviewed replacement supplies equivalent or stronger guarantees.

Concrete per-consumer backfill mappings, new SQL/DTO versions and runnable test
cases remain implementation deliverables. This document makes those obligations
traceable; it neither implements them nor authorizes a reset, live file migration,
binding change, deployment or release of held operational controls.
