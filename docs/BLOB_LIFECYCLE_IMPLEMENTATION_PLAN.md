# Blob lifecycle implementation record

Status: implemented by the blob-lifecycle safety slice; remote activation requires the exact merged integration head to pass the v3 deployment gate

Last reviewed: 2026-08-08 against PR #123

This document records how the normative
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md) is implemented in the
repository. The contract owns the invariants; this document owns the concrete
schema, module, route, test, and deployment boundaries. Operational activation
and incident handling are defined in
[blob lifecycle activation and operations](./BLOB_LIFECYCLE_OPERATIONS.md).

## Purpose

PR #120 established stable source identities, canonical Comments, occurrence
identities, and soft-delete/restore behavior. Those changes made future Project
references possible, but also made provider-byte retention a graph problem:
hidden, unfinished, retryable, archived, and shared sources may all continue to
protect the same physical bytes.

The blob-lifecycle slice turns that graph into executable policy before
`reference_targets`, backlinks, Project-owned attachments, Text, or Map add more
edges.

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
6. complete-export schema v3 with per-locator final outcomes and non-fatal
   warnings;
7. database triggers that reject accidental physical deletion of stable source
   and occurrence tables;
8. internal, deterministic, fail-closed permanent-delete blocker queries;
9. dedicated lifecycle CI plus migration/deployment command gates;
10. migration compatibility repairs for malformed historical event metadata and
    legacy managed-object duplicate states.

The slice does not include:

- `reference_targets`, backlinks, or a reference resolver;
- Project, Project content, Text, Inspector, or Map;
- object-level deep links or deterministic/semantic reference search;
- a privileged permanent-delete or force-delete endpoint;
- provider-stat-based deduplication repair;
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

The implementation relies on four ordered migration positions around the
existing source-lifecycle work:

```text
0015_atomic_mutation_identity.sql
0015_managed_orphan_dedupe_repair.sql
0016_blob_lifecycle_control.sql
0017_blob_lifecycle_review_fixes.sql
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

- `assets.status` remains upload/registration readiness.
- `managed_storage_objects.status` remains a compatibility projection during
  this slice.
- `blob_gc_ledger` is authoritative for cross-provider GC state.

A collected R2 asset keeps its content hash and metadata. The same content may
be registered again under a new live locator after the previous locator reaches
`deleting` or `deleted`.

## Module boundary

```text
worker/blob-lifecycle/
  types.ts
  reachability.ts
  gc.ts
  export.ts
  storage.ts
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

Normalizes provider retrieval and removal, distinguishing:

```text
available
missing
provider_unavailable
```

A provider `HEAD`/`stat` probe before every deduplication reuse is explicitly
deferred to a later storage-integrity slice.

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

Every relationship write is protected at the authoritative SQL boundary:

1. source/occurrence must still be writable;
2. blob metadata must be ready;
3. locator must not be `deleting` or `deleted`;
4. edge write succeeds;
5. an unclaimed `orphaned` row is released atomically.

Content-addressed winner recovery handles concurrent live-SHA registration
without returning a spurious server error.

### Scheduled cleanup

The checked-in cron calls the same GC service daily. Work is bounded to avoid
unbounded D1 bindings, Worker duration, and provider pressure. A large backlog
may require multiple runs.

### Complete export

The server returns schema v3:

```text
all table/view snapshots
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
- export warnings and integrity mismatches;
- total permanent-delete blocker planning;
- physical-delete rejection without cascade;
- D1's 100-binding limit.

Repository commands are:

```text
npm run verify:blob-lifecycle
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

- provider `HEAD`/`stat` and missing-byte self-healing before dedup reuse;
- independent physical GC for every direct-key provenance class;
- streaming/server-side or desktop export for archives beyond browser memory;
- exponential cleanup retry backoff, alerts, and an administrative GC dashboard;
- privileged permanent deletion, tombstones, and force-delete policy.

## Completion and next phase

The blob-lifecycle slice completed in PR #123, and PR #124 corrected its
D1/workerd migration compatibility. Feature-branch success still does not
authorize a remote operation: the exact merged integration head must pass the
full deployment gate.

PR #125 implements the sparse reference registry and base batch resolver.
Actual Project backlinks remain intentionally deferred until
`project_items.reference_target_id` exists. The remaining product sequence is:

1. object-level deep links and archived read-only destinations;
2. deterministic reference search and insertion;
3. Project-owned data, `project_items` backlinks, Text, and Inspector;
4. Map after the data/read model is stable.

Every future Project attachment must extend the existing retention, export,
edge-guard, blocker, and test surfaces rather than introducing a parallel blob
lifecycle.
