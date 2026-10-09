# File and data portability implementation plan

Status: FP0 design reviewed (#207), FP1 historically deployed and accepted.
**Synchronized local FP2–FP5 implementation and qualification are complete**;
real-provider/deployed/integrated release exits remain open.
Last reviewed: 2026-10-09 at integration `474a038` and separate synchronized
implementation `20176fc51d77301c58706d8ae0ff7d87ca6a8422`. This document records **contracts and acceptance
exits**, while [Product roadmap](./PRODUCT_ROADMAP.md#current-checkpoint)
owns active implementation/deployment/CI state.

The 2026-10-03 deployed runtime remained `0017` / V20, R2 defaults and
active File authority. The **separate local development branch** has:
- FP2 `0018` / V21: exact-profile native File S3/R2 operations, accepted
  writes/read/GC, candidate activation and independent original/internal roles;
- FP3 `0019` / V22: persisted bounded migration jobs, execution, complete
  byte verification, pause/resume/cancel/retry, source holds and explicit cleanup;
- FP4 `0020` / V23: paired native **Sample and Project** export and website
  fresh-copy import, plus standalone readable reports;
- FP5 `0021`–`0022` / V24: privileged full backup, identity-preserving
  website fresh-target recovery, protected settings and operator-assisted handoff.

The recorded local qualification includes nonempty R2/S3 fixture round trips,
but it does **not** qualify a real AWS account, deployed runner or operator
handoff. Local File mode remains legacy with execution disabled. The historical
`2060c745` remote CI failed a default-five-second V21 restore test; its unrun
dependent gates were not independent failures. The later `4479295` run exhausted
the 20-minute whole-job budget. Current head `20176fc5` uses a 40-minute job
budget; the default Vitest deadline remains 5 seconds and existing case-specific
limits are unchanged. Complete local and remote results are not yet qualified. The Product checkpoint owns current gate status.
See [FP2/3 evidence](https://github.com/BeiqiD/sample-fabrication-workflow/blob/2060c745376862a379e8c952ee87c05d49982e02/docs/FP3_LOCAL_DEVELOPMENT_ACCEPTANCE.md),
[FP4 evidence](https://github.com/BeiqiD/sample-fabrication-workflow/blob/2060c745376862a379e8c952ee87c05d49982e02/docs/FP4_RESEARCH_PACKAGES.md) and
[FP5 goal](https://github.com/BeiqiD/sample-fabrication-workflow/blob/2060c745376862a379e8c952ee87c05d49982e02/docs/FP5_DEVELOPMENT_GOAL.md).
Preserve frozen historical readers/migrations and current V20 deployment
semantics until each explicitly reviewed rollout. The owner-waived V20 live
ZIP/download rehearsal is not reimposed for unrelated work, although material
V21–V24 release changes require their relevant new evidence.

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
5. [FP1k additive transition](./FP1_FILE_AUTHORITY_TRANSITION.md): the installed
   legacy-mode substrate and required expand/shadow/activate sequence.
6. [Shadow-conversion preflight](./FP1_SHADOW_CONVERSION_PREFLIGHT.md): executable
   read-only inspection, complete slot inventory and remaining overlap protocols.
7. [Shadow runtime](./FP1_SHADOW_RUNTIME.md): deployed occurrence/conversion
   protocol, V15 recovery acceptance and read-only catch-up inspection.
8. [Long-term roadmap](./LONG_TERM_ROADMAP.md): Docker, small-group collaboration
   and optional capabilities beyond this track.

Existing architecture/data-model documents describe deployed implementation.
Existing attachment and blob contracts continue to govern ownership, trust and
retention. Their R2/managed locator forms are transition inputs, not constraints
on the target schema. An implementation PR must update each affected contract and
export/recovery consumer in the same slice; a target document does not make a
current consumer compatible.

## Starting checkpoint and scope

The core integration application is a modular Hono Worker with D1, R2 and
historical SWITCHdrive support. Its active File registry separates logical
File purpose, physical location, profile identity, accepted operation, retention
and execution ownership. Changing a role default never rewrites an existing File.
The deployed 2026-10-03 R2 configuration is accepted FP1/early FP2, whereas
the synchronized development branch contains implemented native S3 and
independent role routing. Those are distinct generations and environments.

The S2 baseline and historical migration chain stay immutable; the synchronized
branch adds forward `0018`–`0022` and paired V21–V24 writers/readers. These
are **implemented local checkpoints** rather than an instruction to reset D1,
activate a provider or change deployment bindings. 6A6 and provider/device/manual
acceptance remain open. SWITCHdrive live credential issues remain explicit and
do not silently become qualified when R2 or AWS fixtures pass.

## Delivery sequence

Each FP milestone may contain several focused PRs. Every implementation starts
from the latest integration head, preserves a usable frontend and carries its
affected schema, export/restore, file-lifecycle and authorization checks.

The accepted FP1 conversion/publication history is retained. On the synchronized
branch, the native generation and purpose-specific, per-item FabuBlox accepted
destinations are already implemented and qualified locally. The historical
single-profile import note applies only to the earlier `0017`/V20 deployment;
it is no longer a missing implementation task. See
[FP2 completion evidence and release boundaries](./PRODUCT_ROADMAP.md#fp2-completion-units).

FP2–FP5 are already built in local development and must not be scheduled as
future greenfield implementation. The first integrated V3 release is scoped
after reviewed code integration, 5F, 6A6 and 6B; the **enabled** subset of
FP2–FP5 must individually pass real-provider, deployed, recovery and operator
gates. Explicit server-side deferral is valid when qualified operations
are unavailable; a deferral is not a success claim.

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| FP0 — design review | This architecture, export/import design, compatibility matrix and updated roadmaps | Completed in PR #207. This remains historical design acceptance, not implementation acceptance. |
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

FP1 basic Settings shows profiles and configuration source under the current
authenticated boundary. Its read-only subset may ship alongside catch-up and
reports connection health as not checked; configuration matching is not a live
connection test. Active connection tests and later configuration controls retain
their own capability and authorization gates. Mutating defaults/configuration is enabled only
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

### Accepted ZIP and validation cadence

The latest [FP1 role-default acceptance](./FP1_R2_ROLE_DEFAULTS.md#live-acceptance--2026-10-01)
records the 2026-10-01 6 MiB HTTP round trip and actual V19 isolated recovery:
15/15 byte entries, zero warnings, equal canonical rows/schema and execution paused.
Exact archive/deployment identities and byte hashes belong to that focused
checkpoint rather than the roadmaps. This closes FP1 live acceptance and retains
the same non-repetition policy below.

The owner-supplied `sample-log-2026-09-28(1).zip`, exported at
`2026-09-28T19:02:40.879Z`, closes actual V17 recovery acceptance after #233.
SHA-256: `9751370e5945e5dae02e8b04871269c5821520933d0544289b6e84246c18756a`.
Isolated S2 recovery restored 72 canonical base tables / 245 rows, rebuilt derived
state into 75 tables, reinstalled 618 triggers, and recovered all 10 blobs with
zero warnings. Rows, schema, foreign keys, integrity and byte hashes passed.
Recovery stayed paused, performed no provider I/O and activated no authority.

Per the owner's 2026-09-28 direction, do not repeat routine live ZIP generation,
download and isolated restore for unrelated feature work. Repeat that rehearsal
only when a major underlying change to canonical persistence, file addressing,
archive format or recovery semantics invalidates this evidence, or when an
actual export failure needs investigation. Retain affected automated checks and
required CI; this changes manual acceptance cadence, not data-integrity checks.

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
absorb the entire Phase 5 media/appearance pass. Bounded local C4, 5D and 5E
development is complete; their remaining formal acceptance retains its scope.
Phase 5F is in progress alongside exact-head qualification and synchronized
implementation review; its initial bounded repairs do not complete cross-product
acceptance. These exits precede the scoped Phase 6B release. Phase 6B validates
the actual enabled FP capabilities,
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

The following FP1 review sequence is **completed historical work**: registry and
paired recovery; immutable-legacy FP1k expansion; read-only preflight; complete
shadow capture/conversion and ledgered catch-up; separately reviewed atomic
consumer/lifecycle activation; R2 role defaults and basic Storage Settings.
The [FP1d consumer inventory](./FP1_FENCED_BYTE_DELETION.md#next-authority-transition-complete-inventory),
[frozen preflight](./FP1_SHADOW_CONVERSION_PREFLIGHT.md),
[shadow runtime](./FP1_SHADOW_RUNTIME.md) and
[File-authority runtime](./FP1_FILE_AUTHORITY_RUNTIME.md) retain those versioned
contracts and evidence. Their intermediate dormant/overlap restrictions are not
today's runtime state. Future compatibility retirement still needs the supported
reader/writer/retry/retention/recovery inventory above; it does not restart FP1.

Before FP3 implementation, record a runtime/provider capability matrix and an
executable transfer spike, including bounded hashing and interrupted archive
output. Estimates and supported transfer limits depend on those results. Keep
provider I/O, persisted work and snapshot/retention ownership explicit instead of
hiding long operations inside a browser request.

### Bootstrap, configuration authority and health

Fresh-install defaults are initialized once; restarting or redeploying must not
replace persisted role choices with environment defaults. Upgrades first record
the exact existing R2/SWITCHdrive instance and configuration source. The accepted
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
timestamped. The core [readiness route](../worker/platform/http.ts) already checks
only the database after the FP1 R2 role-default slice; optional provider failure
does not take it offline. Authenticated Storage Settings separately reports
configuration metadata without probing providers. Selected-role capability
readiness must be extended alongside external provider activation.

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
runner. Any trigger/control change needs its own deployment review; historical
Builds/Cron holds need a current disposition at handoff. Queues/Workflows may be selected
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
A later hold insert after an unprotected location read is insufficient. The historical
[V8 snapshot](../worker/export-v8-snapshot.ts) and current
[V20 snapshot](../worker/export-v20-snapshot.ts) supply a table batch without the
FP3 durable export job/hold protocol. Preserve their recovery evidence without
claiming that it solves this new race. Chunked snapshot construction must retain one documented consistent
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
development-only disabled mode. The delivered [system-administrator policy](../worker/storage/system-administrator.ts)
adds an independent bootstrap-approved administrator capability; it does not yet
provide local accounts or general group/resource permissions. Preserve this explicit
grant rather than treating every allowed email or the first visitor as an administrator. Historical actor email remains
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
