# File and data portability implementation plan

Status: design reviewed and merged in PR #207; FP1 implementation in progress.
The [FP1a foundation](./FP1_FILE_REGISTRY_FOUNDATION.md) supplies the first bounded
schema/mapping and archive slice. [FP1b](./FP1_BYTE_READER_BOUNDARY.md) adds an
instance-bound byte reader and converges legacy read routes; verified ingestion
and complete consumer/lifecycle conversion remain open.
[FP1c](./FP1_VERIFIED_BYTE_WRITES.md) now adds bounded full-byte verification to
current writes and selected reuse; [FP1d](./FP1_FENCED_BYTE_DELETION.md) adds bound
deletion and fenced GC reconciliation without releasing uncertain deletion
claims. File authority remains dormant. FP1 remains incomplete; no deployment
is certified by this document.

Last reviewed: 2026-09-13 against `v2/backend-foundation` at
`4e78fa76b727f81b1431b60ff481bd686d83cb4c` (merged PR #206).

## Authority and reading order

The owner requests a systematic file model, purpose-based storage selection for
all managed files, explicit migration, and useful export/import round trips.
This supersedes the former large-originals-only storage direction. The requested
design was reviewed and merged before the owner requested development.

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

The original design PR changed no runtime state. Implementation now starts with
the explicitly bounded FP1a slice; it changes no live data or maintenance controls.
The earlier disposable-reset authorization is not a standing reset
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

## Reviewed execution decisions and implementation gates

These clarifications refine FP1–FP5 rather than introduce another roadmap.
They are proposed implementation requirements, not evidence of deployed behavior.

### Runtime seams and bounded review slices

The inspected [Worker entry](../worker/index.ts),
[attachment ingestion](../worker/attachment-ingestion.ts), and
[blob storage dispatcher](../worker/blob-lifecycle/storage.ts) still consume
Cloudflare environment objects or select the singleton managed provider.
Wrapping that singleton in a Registry does not by itself establish portability.
New file/settings/job services receive explicit storage, persistence, identity,
clock and execution capabilities; runtime composition supplies their adapters.
Do not require a Node deployment to fabricate a Cloudflare `Env` or duplicate
business services. Existing unaffected modules need not all be rewritten in FP1.

The persistence boundary must preserve atomic guarded publication, authoritative
reconciliation reads, affected-row/conflict semantics and snapshot/hold behavior.
D1's atomic statement batch is not an arbitrary long-lived JavaScript transaction;
the SQLite implementation must provide equivalent business guarantees rather
than merely mimic method names. Qualify rollback, foreign keys, contention and
lost acknowledgements on D1 and host-SQLite contract fixtures now; repeat against
the actual server adapter before declaring Docker support. Object-store I/O stays
outside database transactions. No new ORM, PostgreSQL or distributed coordination service is a
prerequisite for introducing these narrow interfaces.

Review FP1 in bounded slices: schema/profile mapping with matching recovery;
provider-neutral ingestion/resolution and complete consumer/lifecycle conversion
(including the FP1b reader, FP1c verified-write and FP1d fenced-deletion precursors);
then deployment defaults, readiness and basic Settings acceptance. These are
review boundaries within FP1, not independently completed product milestones.
Maintain the overlap/retirement gates above; do not bundle FP2 credentials or
FP4 graph import into the first schema PR. Before FP3 implementation, record a
runtime/provider capability matrix and an executable transfer spike, including
hashing and interrupted archive output. Estimates depend on those results.

The [FP1d handoff inventory](./FP1_FENCED_BYTE_DELETION.md#next-authority-transition-complete-inventory)
identifies the concrete relational, direct-key, import/recovery, API and
export/restore consumers for the next authority conversion. Bound read/write/
delete adapters do not themselves convert those consumers. Preserve the FP1a
unresolved-state guards until accepted operation identity, profile/default races,
guarded publication and the complete retention/dedup/quarantine/recovery
transition are reviewed together. R2 original defaults and basic Settings follow
that conversion.

### Bootstrap, configuration authority and health

Fresh-install defaults are initialized once; restarting or redeploying must not
replace persisted role choices with environment defaults. Upgrades first record
the exact existing R2/SWITCHdrive instance and configuration source. The planned
FP1 change of new-original writes to R2 is an explicit, tested policy transition,
not a reinterpretation of historical locations. Existing environment credentials
can remain referenced during the bridge; users must not have to reconnect storage
merely because profile IDs are introduced. Moving credentials into the encrypted
store is a separate tested activation, without changing the namespace.

The shallow health endpoint remains independent of optional providers. Readiness
reports core database/settings availability and the capability required by each
active write-role default. An unavailable historical-only profile is reported as
degraded and blocks its own file operations, not unrelated healthy-role uploads.
A failing selected default remains visibly unavailable with no fallback; Settings
must remain reachable to repair it when core services work. Deployment admission
uses core readiness; authenticated storage status separately reports role/profile
capability failures. Do not let an aggregate provider-health probe take healthy
operations and the repair UI offline. Status responses are bounded, redacted and
timestamped. This intentionally replaces the current
[readiness route](../worker/platform/http.ts), which requires native R2 and fails
when the configured managed provider fails.

Distinguish read-only historical profiles from profiles eligible for new writes.
A historical connection may be registered even when unavailable or lacking delete
permission; it is not thereby qualified as a write destination. Default activation
requires the selected operation's tested capabilities. Read-only profiles retain
pending cleanup visibly; failed cleanup must not erase their location records.

### Accepted operations, settings races and credential rotation

At durable operation acceptance, record actor/scope, purpose, declared immutable
input, resolved destination and policy revision. A retry looks up that operation
before consulting current defaults or dedup candidates. Lost acknowledgement plus
a default change must not route the same upload/import to a second destination.
A reused operation ID with conflicting input is rejected; a genuinely new copy
requires a new operation. Unverified declared hashes remain claims until verified.

Settings activation compares the expected active revision and the exact tested
candidate, including namespace, credential revision and required capabilities.
Concurrent edits cannot activate an untested mixture or silently lose an update.
A test result is dated evidence, not a guarantee that future I/O will succeed.
Tests use isolated, tracked keys and apply endpoint/redirect credential policy to
all adapter methods, including directory creation, reads, writes and deletion.

Freeze physical identity, not an obligation to retain revoked passwords forever.
A retry may use an activated replacement credential for the same verified namespace,
with the credential revision audited. Credential revocation can pause a job;
it cannot redirect it or authorize replay using a revoked secret. Preserve the
configuration/operation metadata needed for reconciliation and cleanup. Bootstrap
key loss leaves encrypted profiles unavailable while provisioned native storage
can still work; restoration or re-entry must be explicit, never a silent reset.

### Durable execution, fencing and protected snapshots

FP3 needs both persisted work and an independently invoked executor. The initial
small-installation option to qualify is a database job ledger with bounded
scheduled dispatch; Node later supplies a restartable local execution loop.
Cloudflare scheduling cadence, plan limits and operational setup must be recorded
before enabling jobs. The current daily cleanup handler is not acceptance of this
runner. Any trigger/control change needs its own deployment review; the existing
Builds/Cron holds are not implicitly released. Queues/Workflows may be selected
through a later justified adapter decision, not leaked into domain contracts.

Neither an in-memory promise, a browser polling loop nor HTTP `waitUntil()` is a
durable scheduler. Missing/stale executor heartbeats expose queued/paused work and
an actionable status instead of progress that promises eventual execution without
an active runner. Test browser disconnect, missed invocations and process restart.

Job leases carry a fencing generation checked at authoritative publication and
cutover. A stale executor cannot publish after another has taken ownership. Each
external write attempt has its own registered candidate key; a lease timeout does
not prove that an earlier remote PUT has stopped. Retain holds until the attempt
is reconciled or its enforced I/O lifetime has ended and cleanup is safe. Prevent
late writes from recreating supposedly collected objects. Cancellation stops at a
safe boundary; it does not undo already committed per-file switches. Report moved,
remaining, failed and cleanup-pending files separately. Dry runs include staging
space, retained source copies and transfer/verification work, not only final size.

Selecting snapshot locations and acquiring their holds must be atomic with respect
to authoritative GC/cutover decisions, or use a qualified guarded retry protocol.
A later hold insert after an unprotected location read is insufficient. The current
[v8 snapshot](../worker/export-v8-snapshot.ts) supplies a table batch but no durable
export job/hold protocol; preserve its recovery evidence without claiming it solves
this new race. Chunked snapshot construction must retain one documented consistent
revision boundary, not concatenate unrelated live pages.

### Verification evidence and administration

The current [managed adapter](../worker/managed-storage.ts) exposes size/ETag,
and [SWITCHdrive PUT](../worker/switchdrive-storage.ts) checks reported length;
neither alone establishes a provider-verified full-content SHA-256. The FP1c
ingestion composition independently reads and hashes destination bytes for its
current write/reuse operation; it does not strengthen every historical row.
Legacy `ready`
status, client-declared hashes and copied custom checksum metadata must not be
promoted into stronger verification evidence during backfill. Preserve expected
values and their provenance; unavailable or insufficiently evidenced files remain
explicitly unresolved until qualified verification is possible.

A transfer capability records checksum algorithm, whole-object versus composite
meaning, encoding, exact object/version and how the service verified it. Multipart
S3 SHA-256 evidence may be composite rather than the File's whole-byte SHA-256.
Use independently hashed destination bytes or a qualified equivalent; multipart
part hashes/ETags and an S3-compatible label are not sufficient. Demonstrate bounded
streaming hash computation or reject unsupported sizes before acceptance.

Current [authentication](../worker/auth.ts) validates Access email or uses a
development-only disabled mode; it has no local-account or administrator model.
Early administration needs an explicit bootstrap-approved identity/capability,
not every allowed email or the first visitor. Historical actor email remains
provenance, not a grant of future privileges. Recheck current authorization at
job acceptance, execution/publication and output download; safe orphan cleanup
uses its separately authorized system boundary even after an initiating user
loses access. No speculative workspace schema is required for these checks.

The later Node/Docker milestone includes local-account login, secure session and
account-recovery/bootstrap behavior without requiring Cloudflare Access. Disabled
authentication is not its production login solution. Map authenticated principals
to stable internal identity while retaining old Access actor attribution; imported
actor claims never create accounts or permissions. Keep full membership/resource
sharing later, as the long-term roadmap specifies.

### Additional acceptance and remaining decisions

Require fixtures for restart without default reset; legacy credentials without
re-entry; read-only historical-provider failure; lost-response retry across default
and credential changes; concurrent candidate activation; stale executors and late
PUT completion; snapshot-hold/GC races; claimed/composite checksum rejection; and
administrator revocation during a job. Also exercise the
[identity and recovery cutover rules](./DATA_EXPORT_IMPORT_DESIGN.md#13-identity-and-recovery-cutover-clarifications).

Concrete SQL, adapter packages, size/CPU/concurrency budgets, dispatch cadence,
lease/deadline/grace durations and platform-specific recovery commands remain
reviewed implementation deliverables. They cannot be left unspecified when the
corresponding feature ships. FP5's website-assisted fresh-target restore includes
the explicit operator/deployment cutover described in the data design; it does not
promise arbitrary D1 rebinding from Settings. File migration, package copy-import
and whole-installation/database cutover remain separate operations.

Platform references checked on 2026-09-13:
[Workers execution limits](https://developers.cloudflare.com/workers/platform/limits/),
[D1 batch semantics and bindings](https://developers.cloudflare.com/d1/worker-api/d1-database/),
[S3 checksum types](https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html),
and [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/).
Recheck applicable limits when qualifying the actual runtime, plan and adapter.
