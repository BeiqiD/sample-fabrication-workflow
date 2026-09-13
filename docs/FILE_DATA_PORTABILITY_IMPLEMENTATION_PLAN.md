# File and data portability implementation plan

Status: proposed implementation sequence for owner review; documentation only.
No FP implementation or deployment is certified by this document.

Last reviewed: 2026-09-13 against `v2/backend-foundation` at
`4e78fa76b727f81b1431b60ff481bd686d83cb4c` (merged PR #206).

## Authority and reading order

The owner requests a systematic file model, purpose-based storage selection for
all managed files, explicit migration, and useful export/import round trips.
This supersedes the former large-originals-only storage direction. The requested
deliverable is a documentation Draft PR for review before implementation.

Read these documents together:

1. [Product roadmap](./PRODUCT_ROADMAP.md): product priority and current progress.
2. [File storage architecture](./FILE_STORAGE_ARCHITECTURE.md): target identities,
   purposes, configuration, physical locations and lifecycle invariants.
3. [Data export/import design](./DATA_EXPORT_IMPORT_DESIGN.md): reports, portable
   packages, backup/recovery and their shared machinery.
4. This plan: delivery dependencies, compatibility and acceptance.
5. [Long-term roadmap](./LONG_TERM_ROADMAP.md): Docker, small-group collaboration
   and optional capabilities beyond this track.

Existing architecture/data-model documents describe deployed implementation.
Existing attachment and blob contracts continue to govern ownership, trust and
retention. Their R2/managed locator forms are transition inputs, not constraints
on the target schema. An implementation PR must update each affected contract and
export/recovery consumer in the same slice; a target document does not make a
current consumer compatible.

## Starting checkpoint and scope

The current Worker uses D1, R2 `assets`, one environment-configured SWITCHdrive
adapter and `managed_storage_objects`. The common ingestion/lifecycle services
already protect registration, reuse, quarantine and GC. They do not yet provide
multiple configured storage instances, application-managed secrets, universal
file locations or native website package import.

The [S2 activation checkpoint](./CLOUDFLARE_S2_ACTIVATION_CHECKPOINT.md) records
the completed in-place test-database rebuild and retained file bindings. Phase
6A6 and non-empty S2 file/browser acceptance remain open. PR #206 improves
SWITCHdrive diagnostics; it does not repair credentials. The existing full
archive has bounded offline recovery; Sample/Project readable exports do not
constitute a native package import contract.

Keep the remaining S2 evidence explicit. The new capability track may be designed
and, after document review, implemented while SWITCHdrive is unavailable. Its
provider-specific live reads and migration tests remain deferred until access
works. R2 default behavior requires new non-empty live acceptance; no default
change retroactively qualifies the old SWITCHdrive path. The new track is an
intentional product/schema change, separate from behavior-preserving Phase 6A.

This PR changes no code, schema, bindings, credentials, live data or maintenance
controls. The earlier disposable-reset authorization is not a standing reset
strategy for FP. Keep the recorded Builds/Cron holds and their release owner
visible until an accepted operational handoff; this plan neither releases them
nor establishes that they are still present through a fresh live check.

## Delivery sequence

Each FP milestone may contain several focused PRs. Every implementation starts
from the latest integration head, preserves a usable frontend and carries its
affected schema, export/restore, file-lifecycle and authorization checks.

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| FP0 — design review | This architecture, export/import design, compatibility matrix and updated roadmaps | Owner can review a coherent target; unresolved implementation choices are bounded below. No implementation acceptance is claimed. |
| FP1 — universal file foundation | Files/locations/profile identities; both existing storage paths behind the registry; all direct-key consumers inventoried and adapted; R2 defaults for both roles on Cloudflare; basic authenticated storage status/Settings | Ordinary images, originals, previews, import/provenance and experimental images use the same location contract. Existing records keep their identities and locations. New originals round-trip through R2 without SWITCHdrive. Export/recovery preserves the new schema before activation. |
| FP2 — configurable storage | Minimal administrator capability; versioned application settings; encrypted secret store; test/activate flow; external S3 adapter; separate internal/original defaults | Two real provider instances coexist; defaults affect only new uploads; invalid candidates do not replace active settings. Credential rotation, namespace-change rejection, permissions and failed-provider behavior are exercised. |
| FP3 — jobs and migration | Persisted bounded job execution; migration planning/dry run, copy/verify/conditional switch, per-file retries and progress; GC/read holds and explicit source cleanup | Interrupted jobs resume safely; corruption never cuts over; concurrent delete/read/migration is safe; all file purposes can migrate. R2/S3 same-type and cross-type instances are exercised. SWITCHdrive live cases remain explicitly pending if inaccessible. |
| FP4 — portable research data | Native Sample/Project package export and matching website import; shared dependency/snapshot planner; offline readable projection included; report-only output | Complete non-empty package can be read offline and imported as a new copy with intact sources, comments, graph/placements and files on a different provider mapping. Retry does not duplicate records. Export and import ship as one product milestone. |
| FP5 — system recovery | Shared bounded archive engine for full backup; visible completeness; privileged website recovery into a fresh target with verified cutover; legacy archive recovery/conversion path | Recover all promised canonical state/history and file purposes, preserving IDs; validate partial-backup handling, provider remapping, protected settings recovery and safe treatment of old jobs. Source remains usable until successful cutover. |

FP1 is not a temporary R2-originals feature that leaves ordinary images bound to
R2 indefinitely. The universal model is designed before its first schema slice;
the milestone does not close while a supported file path bypasses it. FP1 may
retain a documented compatibility adapter for old locators, with retirement
criteria and no new legacy-key writers.

FP1 basic Settings shows profiles, configuration source and health under the
current authenticated boundary. Mutating defaults/configuration is enabled only
with the minimal server-side administrator checks delivered with or before that
mutation; FP2 cannot be used to justify an unprotected FP1 write endpoint.

FP2 implements S3 so the foundation is proven beyond a single physical backend.
Local storage is specified now but its supported runtime and Docker packaging
belong to the later portability milestone. Same-kind instances (two buckets or
two roots) must be distinguishable even before that milestone.

Job contracts are designed in FP0/FP1. FP3 supplies the durable runner used by
FP4/FP5. It must declare and test object-size, hashing, time, memory and temporary
storage bounds for each runtime. An implementation may resume between files and
restart an interrupted file when the adapter cannot resume within an object;
it must not advertise byte-level resumability or unlimited file sizes. Optional
multipart/range support requires capability qualification, including WebDAV
behavior. A single long browser request is not the runner.

Current export must remain recoverable throughout FP1–FP3; FP5 is the improved
product recovery experience, not permission to postpone schema export coverage.
Existing complete archives and their isolated restore fixtures remain supported.

## Compatibility matrix

| Boundary | Required behavior | How it is established |
|---|---|---|
| Old logical sources/occurrences → new file model | Preserve Sample, Comment, attachment, Project and Reference identity; convert physical-key references through an explicit mapping | Inventory and populated backfill fixtures covering every retention root, not only attachment tables |
| Old R2/managed locators → locations | Register the actual existing instance/key; never reinterpret a historical key through a newly edited account/root | Stable legacy-to-profile/location mapping, retained source bytes and audited classification |
| New default → existing files | New writes use the new policy; existing reads use their recorded location | Mixed-old/new reads after multiple default changes, including an unavailable old provider |
| Ordinary vs original use of identical bytes | Independent purpose identities and placement remain possible; reuse does not defeat policy | Same-hash cross-purpose/cross-profile fixtures; no initial cross-purpose physical aliasing |
| Existing browser/API clients → new server | Intentional protocol changes are negotiated; stale writes are rejected or handled by an explicitly tested bridge | Frontend/Worker compatibility tests and actual old-client retirement before removal |
| Existing media/deep links → file IDs | Preserve permitted source navigation and existing links through a bounded resolver bridge; all reads remain authorized | Old and new route fixtures, same-origin media/download behavior, cache and supported range tests |
| Current v7/v8 backups → future app | Retain a qualified offline reader; introduce explicit conversion/admission if website recovery supports these versions | Real old-archive fixtures, logical identity/hash checks and documented format limits |
| Future schema → export protocol | New authoritative fields/tables cannot be silently dropped or disguised as v8 | Versioned schema/profile contract and matching writer/reader update in the schema PR |
| Readable exports → native import | Old Sample/Reading outputs remain readable; missing graph/source history is never invented | Classify old outputs honestly; no unsupported lossless conversion promise |
| Native package → new installation | Preserve the business graph through fresh-ID mapping; apply destination storage policy | Re-export semantic comparison, origin/import ledger, no automatic name/hash matching of business objects |
| Full backup → restored installation | Preserve logical IDs/history; remap physical storage and separately handle protected configuration | Fresh-target recovery rehearsal; no automatic replay of old deletion/migration jobs |
| Cloudflare → server/Docker | Same domain, file-purpose and package contracts; D1 and SQLite runtime differences handled in adapters | Host SQLite/D1 tests now; actual bidirectional deployment recovery/import only after Docker exists |
| Single user → small group | Authorization follows business ownership, not file hash, provider or uploader | Admin checks now; later membership/root-capability tests across media/search/export/jobs |

Archive format version, native package profile version, application database
schema version and adapter configuration version are distinct. Their support
matrix must be explicit. A changed table or added profile/location registry does
not fit an old format simply because it can be serialized as JSON.

## Schema and API transition strategy

Use ordinary forward migrations from the current S2 baseline; retain historical
migrations and archive fixtures. Do not repeatedly replace the baseline or
clear the database to simplify this work. A future separately authorized
disposable test reset cannot stand in for data-preserving upgrade acceptance.

1. Enumerate every stored byte and physical locator, including imports, source
   workbooks, manifests, template sources, state/execution/metrology images,
   timeline thumbnails, canonical/legacy Comments, Project attachments,
   derivatives, staged uploads, GC/quarantine and export/recovery paths.
2. Add new identities and a deterministic legacy mapping. Classify purpose from
   the creating operation, provenance and actual consumers, never only MIME or
   size. Record ambiguous cases for explicit resolution. Existing unavailable
   bytes remain unavailable; backfill must not manufacture a verified hash or
   healthy location. Existing expected metadata remains evidence.
3. Introduce adapter-backed readers and new-file writers with tested overlap.
   If one old physical object serves incompatible purposes, stage independently
   verified copies before publishing independent new placements. Keep old
   references/retention until conversion is complete. An inaccessible source
   blocks its actual copying, not unrelated new uploads or development.
4. Adapt authoritative retention, dedup, import/provenance, media, Reference,
   export and recovery together. Preserve current registration-before-upload,
   unknown-write reconciliation, quarantine, same-ID restore and derivative
   trust guarantees; replace R2-specific representations deliberately.
5. Before retiring the bridge, compare populated data and file reachability,
   qualify old-client behavior and restore, and prove no reader/writer/retention
   root still depends on the retired locator shape. Remove only the verified
   compatibility surface. Schema rollback cannot depend on changing the binary
   alone after incompatible new records have been written.

The concrete schema SQL, backfill classification report, compatibility window,
rollback/recovery mechanism and protocol numbers are implementation-review
deliverables. This document selects the target and transition requirements; it
does not certify unimplemented SQL or reopen PRs #199/#200, whose S1 overlap
purpose is separate from the completed S2 reset.

## Shared execution and consistency requirements

Provider writes and database commits are not one transaction. Uploads/imports
stage durable candidates before external writes and publish reachable business
state only after required bytes and relationships are verified. Lost responses
are reconciled using operation identity; repeated execution must be safe.
Large imports may use bounded staging batches with an atomic visibility marker,
provided every read/search/export path respects it. Do not promise an unbounded
single SQL transaction.

Migration/export jobs pin the exact files and locations required by their frozen
plan. Lease renewal, cancellation, expired-owner recovery and GC claims must be
race-safe. A database snapshot plus later unconstrained file discovery is not a
consistent export. Exclude the current job's own output and disposable unreferenced
artifacts; prior generated files with durable business references remain required
opaque content, without recursive archive expansion. Persisted history and active
executable work are distinguished on system recovery.

Jobs, administrator changes and import provenance record the real actor. Future
membership revocation and export-scope checks must fit the same authorization
boundary; storage credentials never grant domain-level visibility by themselves.

## Acceptance scenarios for the combined track

The following are required scenarios, not results already obtained:

- Fresh Cloudflare installation provisions its necessary binding/bootstrap and
  uses existing R2 for both roles. An unavailable optional SWITCHdrive profile
  does not disable unrelated R2 uploads; its failures remain visible.
- Internal files on Amazon S3 and originals on R2: ordinary images, source
  images, previews and provenance all upload, display/download, export and
  migrate; switching defaults does not move historical files.
- After the server milestone: internal files local and originals SWITCHdrive,
  including reboot/volume persistence and a complete Cloudflare/server package
  and backup round trip. Before then, this scenario is a target, not acceptance.
- Move every managed persistent file off R2 to qualified destinations, then
  prove application-file operations no longer require R2. Any remaining local
  runtime cache or bundled application asset is explicitly outside user-file
  identity; it must not hide an authoritative file dependency.
- Change a default during an upload: the accepted upload uses its frozen profile
  and settings revision. Provider removal checks active uploads, historical
  files, migration jobs and retained copies before deactivation or deletion.
- Corrupt a target, lose an acknowledgement, restart a job, race GC and retain
  source reads during cutover. No unverified target becomes active and no last
  required copy is deleted.
- Export/import a Sample and a Project that references it, including duplicate
  occurrences, shared Comments, immutable template revisions, graph geometry,
  original files and previews. Same-package retries preserve exactly one import;
  an explicitly requested second copy is distinct.
- A missing original yields visible incomplete status and an explicit salvage
  decision. It cannot pass complete-package or complete-backup acceptance.
- Recover old v7/v8 fixtures and new backup profiles without interpreting archive
  SQL as executable code, leaking credentials or activating old cleanup work.
- Import foreign previews with intact bytes but unverified generation claims;
  they remain viewable without entering the trusted shared-derivative registry.
  Back up a previously generated archive attached as durable evidence exactly
  once, without including the running backup's own output.

## Relationship to longer-term work

The backend-first product priority continues. FP's affected upload/storage/data
UI is part of its own milestones; it does not repeat completed Canvas work or
absorb the entire Phase 5 media/appearance pass. Remaining C4 acceptance and
Phase 5D/5E/5F retain their scope and resume at the checkpoint in the roadmap.
Phase 6B validates the actual integrated release and its enabled FP capabilities,
not merely the previous zero-blob S2 state. Delaying an FP feature requires an
explicit scope update rather than marking its tests passed.

Later Docker distribution adds Node runtime composition, SQLite behavior,
durable local volume defaults, background execution, authentication bootstrap,
and installation/upgrade/recovery instructions. It reuses the above files and
packages; it does not fork the domain or require PostgreSQL. Merely running
SQLite unit tests or a local storage mock does not qualify Docker support.

Small-group collaboration later adds membership and domain-root capabilities
for Samples, Projects and Recipes. System administrator checks and setting
scope are needed now; full workspace/resource ACL tables are not added merely
for future-proofing. Preserve actor attribution, optimistic conflicts and
idempotent operations. Real-time editing, cross-scope deduplication, replication,
automatic failover/tiering, distributed queues and large-organization tenancy
are outside this plan unless a later measured need changes the roadmap.
