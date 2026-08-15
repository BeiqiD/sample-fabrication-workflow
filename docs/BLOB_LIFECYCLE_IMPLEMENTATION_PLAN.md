# Blob lifecycle implementation record

Status: implemented by the blob-lifecycle safety slice; remote activation requires the exact merged integration head to pass the v3 deployment gate

Last reviewed: 2026-08-15 after reachability-preserving FabuBlox
publication and through-0024 recovery hardening

This document records how the normative
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md) is implemented in the
repository. The contract owns the invariants; this document owns the concrete
schema, module, route, test, and deployment boundaries. Operational activation
and incident handling are defined in
[blob lifecycle activation and operations](./BLOB_LIFECYCLE_OPERATIONS.md).
Current product sequencing is defined only in
[the product roadmap](./PRODUCT_ROADMAP.md).

## Purpose

PR #120 established stable source identities, canonical Comments, occurrence
identities, and soft-delete/restore behavior. Those changes made future Project
references possible, but also made provider-byte retention a graph problem:
hidden, unfinished, retryable, archived, and shared sources may all continue to
protect the same physical bytes.

The blob-lifecycle slice turns that graph into executable policy before later
reference and Project-owned attachment types add more edges.

## Implemented scope

The slice includes:

1. explicit retry lifetime and closure for unfinished Comment submissions;
2. one derived `blob_retention_edges` surface for every current blob-bearing
   source or occurrence;
3. a provider-neutral `blob_gc_ledger` and operation-ID two-phase deletion
   state machine;
4. shared reachability use by Cancel and scheduled cleanup;
5. guarded deduplication/edge creation against `deleting` and `deleted`
   locators;
6. complete-export schema v5 with per-locator final outcomes, quarantine
   metadata, and non-fatal warnings;
7. database triggers that reject accidental physical deletion of stable source
   and occurrence tables;
8. internal, deterministic, fail-closed permanent-delete blocker queries;
9. dedicated lifecycle CI plus migration/deployment command gates;
10. migration compatibility repairs for malformed historical event metadata and
    legacy managed-object duplicate states;
11. provider `HEAD`/`stat` verification before content-addressed reuse, with
    terminal integrity quarantine for definite absence or size mismatch;
12. leased FabuBlox staging, primary-authoritative finalization recovery,
    owning-import publication guards across template, step, event, and asset
    relationships, and a persistent GC queue for stale or failed import objects;
13. through-0024 recovery for partial pending or failed imports, including Run
    step-FK detachment, import/template provenance cleanup, release of only
    exclusive failed-template state edges, and standalone re-homing of any
    import asset still protected by another durable source.

The slice does not include:

- the reference registry or resolver that followed it;
- Project or Project-owned attachments;
- object-level deep links or deterministic/semantic reference search;
- a privileged permanent-delete or force-delete endpoint;
- a streaming/server-side export implementation;
- production or remote v3 migration/deployment as part of feature development.

## Runtime boundary

The implementation remains inside the existing deployment:

```text
one Worker
+ D1
+ private R2
+ optional ManagedStorage / SWITCHdrive
```

No Queue, Workflow, Durable Object, Container, or second Worker is required.
Domain operations are ordinary TypeScript plus guarded SQL so a future queue,
Workflow, or self-hosted executor can call the same services without changing
retention semantics.

## Ordered migration set

The implementation relies on eight ordered migration positions around the
existing source-lifecycle work:

```text
0015_atomic_mutation_identity.sql
0015_managed_orphan_dedupe_repair.sql
0016_blob_lifecycle_control.sql
0017_blob_lifecycle_review_fixes.sql
0024_blob_integrity_quarantine.sql
0025_fabublox_publication_boundaries.sql
0026_fabublox_recovery_ownership.sql
0027_fabublox_dependency_publication.sql
```

Wrangler discovers migration files in deterministic order. The managed-object
repair deliberately shares the `0015` numeric prefix but sorts after the earlier
atomic-identity migration and before `0016`.

### Pre-0016 managed-object repair

Legacy Cancel/cleanup could leave this valid old-schema state:

```text
managed object A: orphaned, still referenced by an unfinished item
managed object B: ready, same provider + SHA-256 + byte size
```

The old partial uniqueness index allowed B because A was not ready. Migration
0016 restores reachable orphaned objects to ready, which would violate that
index if A and B coexist.

`0015_managed_orphan_dedupe_repair.sql` therefore:

1. selects a deterministic ready content-identical winner;
2. rewires `comment_submission_items.storage_object_id` from the orphan to the
   winner;
3. preserves submission and item identity;
4. leaves the redundant orphan locator for ordinary ledger/grace cleanup.

A dedicated regression seeds this exact state and applies every later migration.

### `0016_blob_lifecycle_control.sql`

This migration adds:

- `retry_until`, `retry_closed_at`, and `retry_closed_by`;
- `blob_gc_ledger`;
- the initial `blob_retention_edges` view;
- reverse-lookup indexes;
- live-locator SHA uniqueness for R2 assets;
- edge-creation triggers that clear only unclaimed orphans and reject claimed or
  terminal locators;
- compatibility transitions for legacy managed-storage status;
- unconditional physical-delete blockers for stable sources and occurrences.

### `0017_blob_lifecycle_review_fixes.sql`

This migration rebuilds the retention surface to:

- include `events.metadata_json.thumbnailKey` as a distinct Sample-record
  thumbnail occurrence;
- require `retry_closed_at IS NULL` for every unfinished/retryable submission
  edge;
- tolerate malformed historical event metadata in the view, expression index,
  and triggers;
- keep the custom live-SHA constraint compatible with concurrent winner
  recovery.

### `0024_blob_integrity_quarantine.sql`

This migration adds `blob_integrity_quarantine` as a terminal record of definite
physical-locator failure. A locator enters quarantine only after the provider
confirms absence or reports a byte-size mismatch. Authentication, transport, and
provider errors do not quarantine metadata.

Quarantine preserves historical metadata and existing relationships for audit,
export, and repair, while:

- excluding the locator from future deduplication reuse and every ordinary/live
  media-delivery route while preserving authenticated export retrieval for
  integrity warnings;
- rejecting new relationships, including Sample-record thumbnail INSERT
  and UPDATE bindings, to the locator at the SQL boundary;
- releasing the content hash so identical bytes can be registered at a fresh
  physical locator;
- keeping the old locator terminal rather than silently reusing a recycled key.

FabuBlox assets remain `pending` while their owning import lease is active. The
import request and finalization each have an immutable identity. A finalization
error is followed by a primary D1 read before any cleanup decision: a committed
matching finalization is returned as success, an unknown outcome leaves provider
bytes untouched, and only an authoritatively unfinished matching operation can
be moved to failed recovery. Recovery first removes only the failed import's
own direct provenance and failed-template structure. An import asset that is
still reachable through another durable occurrence is detached from the failed
import and kept ready with its content hash; only an asset that is unreachable
under `blob_retention_edges` releases its hash and enters `blob_gc_ledger`.
Provider deletion is then retried by the ordinary operation-ID GC state machine
rather than performed destructively in the request catch path.

### `0025_fabublox_publication_boundaries.sql`

This migration makes owning-import readiness an authoritative SQL boundary, not
only an HTTP/service convention. It rejects new INSERT or relationship-changing
UPDATE operations that would expose an unfinished import through:

- `runs.template_version_id` and `run_plan_revisions.template_version_id`;
- `run_steps.template_step_id` and
  `run_step_plan_links.template_step_id`;
- Recipe proposals, recipe-revision reference targets, and metrology template
  references;
- normalized asset relationships;
- `events.asset_key` and `events.metadata_json.thumbnailKey` when the direct key
  resolves to staged or failed asset metadata.

Provider-only historical event keys remain compatible when no asset metadata row
exists. Through-0024 fixtures prove that the migration can be applied over
legacy interrupted data and that subsequent recovery:

1. claims either a stale pending import or a failed partial import without a
   recovery identity;
2. clears only import workbook/manifest and partial-template source provenance,
   while preserving independent event primary and thumbnail occurrences;
3. deletes `run_step_plan_links` and nulls the nullable Run-step FK before
   removing partial template steps;
4. removes a state-image relationship only when the state is exclusive to the
   failed partial template, preserving other templates, independent Run-step
   states, `runs.initial_state_hash`, `samples.inherited_state_hash`, and
   explicit verification history;
5. detaches any still-reachable import asset from the failed import so it
   remains a ready standalone canonical winner with its SHA reservation;
6. marks and queues only assets that have no remaining edge in
   `blob_retention_edges`.

### `0026_fabublox_recovery_ownership.sql`

This migration separates physical retention from public availability. It
installs public-consumer and unresolved-import projections, provider-aware legacy
asset recovery, and operation-safe ownership transfer. Recovery may preserve a
locator for a pending successor without making that locator live.

### `0027_fabublox_dependency_publication.sql`

This migration installs the complete `fabublox_import_asset_dependencies`
surface and makes it authoritative for both successor recovery and finalization.
The graph covers direct import assets, workbook/manifest provenance, template
source, initial and expected state images, and metrology references. The
`pending -> ready` trigger rejects any required asset that is failed, missing a
hash, quarantined, terminal in GC, or owned by an unpublished import. Final
workbook and manifest keys are validated from `NEW` because a trigger query over
`imports` still observes the old pending row.

The same migration rewires `fabublox_recovery_import_asset_edges` to derive from
this graph, preventing recovery and publication from evolving separate notions
of import dependency.

## Authoritative schema surfaces

### `blob_retention_edges`

The view emits:

```text
store_kind
provider
object_key
blob_record_id
source_type
source_id
occurrence_type
occurrence_id
retention_reason
retain_until
```

It covers:

- state-representation assets;
- Run-step execution/observation assets;
- metrology reference occurrences;
- legacy Run-step Comment images;
- State-verification evidence;
- ready Comment image/file occurrences;
- unfinished and retryable Comment occurrences;
- timeline/event primary assets;
- Sample-record thumbnails;
- import workbook and manifest provenance;
- Template source provenance.

Soft-delete and archive columns are deliberately not filters for durable
history edges.

### `blob_gc_ledger`

The ledger owns cleanup work, not reachability:

```text
no row -> live/not considered
orphaned -> unreachable and waiting through grace
 deleting -> claimed by one operation
 deleted -> provider deletion/absence finalized
```

It stores operation ID, timestamps, attempt count, and last error. A `deleted`
locator is terminal and is not revived by manually recreating bytes at the same
provider key.

### Existing readiness columns

- `assets.status` remains upload/registration readiness. FabuBlox registers
  new hash reservations as `pending`; an atomic import-status trigger promotes
  them to `ready` only when the owning import commits `ready`. Ordinary delivery,
  relationship creation, and content-addressed reuse therefore reject staged
  bytes until both the asset and its owning import are ready. Recovery may clear
  `import_id` only after another durable edge is authoritative, allowing the
  canonical asset row to continue as a standalone ready winner.
- `managed_storage_objects.status` remains a compatibility projection during
  this slice.
- `blob_gc_ledger` is authoritative for cross-provider GC state.
- `blob_integrity_quarantine` is authoritative for definite provider-byte
  absence or size mismatch discovered during reuse verification.

A collected or quarantined R2 asset keeps its metadata. The same content may be
registered again under a new live locator after the previous locator reaches
`deleting` or `deleted`, or after quarantine releases its content identity.

## Module boundary

```text
worker/blob-lifecycle/
  types.ts
  reachability.ts
  gc.ts
  export.ts
  storage.ts
  reuse.ts
  permanent-delete.ts
```

### `types.ts`

Owns locator, edge, ledger, export, and permanent-delete blocker types.

### `reachability.ts`

Owns every query of `blob_retention_edges` and the guarded operations for:

```text
listRetentionEdges
isBlobReachable
markOrphanCandidate
refresh/release an unclaimed orphan
claimBlobDeletion
reclaim a stale operation-ID claim
```

Routes and jobs do not maintain private status-specific reachability trees.
FabuBlox recovery likewise uses the view before changing asset ownership,
readiness, hash reservation, or GC state.

### `gc.ts`

Implements:

1. abandoned-upload transition;
2. explicit retry expiry into system cancellation;
3. bounded orphan discovery;
4. grace-period deletion claim;
5. provider deletion;
6. operation-ID finalization or retryable error recording.

Provider I/O occurs after the D1 claim and outside a database transaction.

### `storage.ts`

Normalizes provider retrieval, metadata-only `HEAD`/`stat`, and removal,
distinguishing:

```text
available
missing
provider_unavailable
```

Provider unavailability is never reinterpreted as physical absence.

### `reuse.ts`

Owns provider-verified content-addressed reuse for R2 and managed storage. It
checks byte existence and size before releasing an orphan or returning a winner,
records definite failures in `blob_integrity_quarantine`, and surfaces temporary
provider failures as retryable service errors without changing metadata.

### `export.ts`

Builds one deduplicated export entry per physical locator, retains every source
occurrence mapping, supplies authenticated export-only download routes, and
maps final download/integrity results to warnings.

### `permanent-delete.ts`

Provides total, fail-closed blocker queries for every declared target type. It
does not authorize or execute source deletion. Database triggers continue to
reject all physical deletion of protected stable tables.

## Route and job behavior

### Submission creation, upload, retry, finalize, and Cancel

- creation assigns an explicit retry deadline;
- upload/retry/finalize require `retry_closed_at IS NULL`;
- retry extends the explicit window;
- expiry is an atomic system cancellation and hides the submission from ordinary
  recovery UI while preserving rows for export;
- Cancel closes retryability and then asks shared reachability to mark only newly
  unreachable locators;
- no HTTP route physically deletes provider bytes.

### Edge creation and deduplication

Every content-addressed reuse and relationship write is protected at the
authoritative boundaries:

1. a candidate locator must not be `deleting`, `deleted`, or quarantined;
2. R2 `HEAD` or managed-storage `stat` must confirm that bytes exist;
3. a definite provider byte-size must match registered metadata;
4. provider/auth/transport failure returns a retryable service error and leaves
   metadata unchanged;
5. ordinary/live media delivery must exclude quarantined locators, while
   authenticated complete-export delivery remains readable for warning capture;
6. source/occurrence and blob metadata must still be writable and ready;
7. an asset relationship additionally requires any owning import to be ready;
8. the relationship write succeeds;
9. an unclaimed `orphaned` row is released atomically.

A definite missing or size-mismatched candidate is quarantined and skipped. The
upload then registers the same bytes at a fresh locator. Content-addressed winner
recovery still handles concurrent registration without returning a spurious
server error.

### Scheduled cleanup

The checked-in cron calls the same GC service daily. Work is bounded to avoid
unbounded D1 bindings, Worker duration, and provider pressure. A large backlog
may require multiple runs. The FabuBlox reaper processes both expired pending
leases and through-0024 failed partial imports that never received a durable
recovery identity. Before changing an import asset to failed or queueing it, the
reaper removes only the failed import's provenance and then checks the same
`blob_retention_edges` surface used by ordinary GC.

### Complete export

The current complete export returns schema v5:

```text
all table/view snapshots, including integrity quarantine
+ one deduplicated blob plan
+ expected size/hash
+ every source occurrence
+ authenticated download URL only when metadata is ready
```

The browser:

1. writes every table JSON file;
2. downloads each physical locator at most once;
3. verifies size and SHA-256 when available;
4. records final outcomes rather than aborting on one failure;
5. writes `export-manifest.json` and `export-warnings.json`;
6. generates the ZIP.

The first version builds the ZIP in browser memory; this is a documented scale
boundary, not a streaming guarantee.

### Permanent delete

No destructive route is enabled. Protected tables reject direct SQL deletion
before foreign-key cascades can modify descendants. Blocker queries include
structural relations, canonical/occurrence ownership, timeline links, and
Recipe-change evidence, and fail closed for unknown target types.

## Concurrency model

### Edge creation versus cleanup

A link created before the claim makes the claim fail because reachability is
rechecked. A link attempted after `deleting` is rejected by the relationship
trigger.

### Failed-import recovery versus another durable source

A failed import never owns an event or state occurrence merely because its asset
row supplied the bytes. Recovery first releases only import/template provenance.
If another ready import, Run, Sample, event, Comment, metrology reference, or
verification still contributes an edge, the asset is re-homed as standalone and
cannot enter GC. Only the absence of all authoritative edges permits failure and
queueing.

### Restore versus cleanup

Soft-deleted durable occurrences remain edges, so ordinary Restore does not race
with GC for their bytes.

### Export versus cleanup

Export holds no long lease. If cleanup wins after planning, retrieval records a
structured warning and the rest of the archive continues.

### Provider success versus D1 failure

The same operation ID may reclaim a stale `deleting` claim and repeat the
idempotent provider delete before finalizing `deleted`.

## Dedicated verification

The lifecycle gate includes:

```text
worker/blob-reachability.test.ts
worker/blob-gc.test.ts
worker/blob-export.test.ts
worker/permanent-delete-protection.test.ts
worker/blob-lifecycle-review-fixes.test.ts
worker/blob-lifecycle-migration-safety.test.ts
worker/blob-lifecycle-legacy-managed-migration.test.ts
worker/blob-integrity.test.ts
worker/switchdrive-storage.test.ts
```

The suites cover:

- every current retention class and submission state;
- shared R2 and managed objects;
- Cancel/Finalize/upload/retry races;
- orphan/edge and claim/dedup races;
- provider failure and operation-ID convergence;
- malformed historical event metadata;
- Sample-record thumbnails;
- legacy managed orphan/ready duplicates;
- through-0024 pending/failed FabuBlox data and missing publication guards;
- Run-step FK recovery and exclusive-state cleanup;
- A-to-B import deduplication where ready Import B retains Import A's asset;
- `runs.initial_state_hash` and `samples.inherited_state_hash` state-image
  preservation;
- event primary-attachment and thumbnail preservation while import provenance
  is removed;
- standalone re-homing of externally reachable failed-import assets and GC of
  only unreachable assets;
- export warnings and integrity mismatches;
- total permanent-delete blocker planning;
- physical-delete rejection without cascade;
- D1's 100-binding limit;
- R2 and SWITCHdrive metadata-only verification;
- missing and size-mismatched quarantine;
- provider-outage fail-closed behavior;
- fresh-locator registration after a quarantined winner.

Repository commands are:

```text
npm run verify:blob-lifecycle
npm run verify:storage-integrity
npm run verify:v3-deployment
```

Normal remote migration and deployment commands run the lifecycle suite,
complete suite, and deployment build before touching Cloudflare resources.

## Activation boundary

Feature-branch success does not authorize a remote operation. After squash merge:

1. identify the exact `v2/backend-foundation` integration-head SHA;
2. run `npm run verify:v3-deployment` from that exact checkout;
3. create and verify a fresh full-system backup;
4. confirm isolated v3 D1/R2/Worker bindings;
5. use only the gated remote migration/deployment commands.

No remote migration or deployment was run while developing this slice.

## Explicit deferrals

The following are outside this implementation and are tracked operationally in
[BLOB_LIFECYCLE_OPERATIONS.md](./BLOB_LIFECYCLE_OPERATIONS.md):

- independent physical GC for every direct-key provenance class;
- streaming/server-side or desktop export for archives beyond browser memory;
- exponential cleanup retry backoff, alerts, and an administrative GC dashboard;
- privileged permanent deletion, tombstones, and force-delete policy.

## Completion and roadmap ownership

The blob-lifecycle slice completed in PR #123, and PR #124 corrected its
D1/workerd migration compatibility. The storage-integrity maintenance slice now
extends that foundation with provider-verified reuse, terminal quarantine, and
owning-import publication/recovery boundaries. Feature-branch success still does
not authorize a remote operation: the exact merged integration head must pass
the full deployment gate.

Reference identity, navigation, deterministic search, and the reusable Project
discovery surface were subsequently completed through PR #130. This
implementation record does not define their product ordering or the later
Project sequence; those are governed exclusively by
[PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md) and
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).

Every future Project attachment must extend the existing retention, export,
edge-guard, blocker, and test surfaces rather than introducing a parallel blob
lifecycle.

## 0026 recovery ownership projection

`0026_fabublox_recovery_ownership.sql` deliberately leaves the generic GC view unchanged and adds recovery-only projections for publication and private ownership succession. Recovery performs provider preflight before claiming the import, then atomically cleans failed-import provenance, repairs legacy metadata, transfers private ownership when necessary, and queues only genuinely unowned locators.

Ordinary `/assets` registration uses the same exact-outcome principle: after an uncertain INSERT response it first reconciles its stable `id` and R2 key on the primary database. It deletes the uploaded key only after proving that a different canonical winner committed.

## Shared registration reconciliation

`worker/blob-lifecycle/registration.ts` owns primary-authoritative exact-record reconciliation for both R2 and managed objects. Ordinary assets and both Comment upload paths use it before calling the provider-verified reusable-winner lookup. This keeps the uncertain-outcome ordering identical across storage backends and prevents a committed upload from deleting its own locator.
