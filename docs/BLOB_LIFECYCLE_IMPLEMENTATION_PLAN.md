# Blob lifecycle implementation plan

Status: concrete plan for the next backend PR

This document translates
[the blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md) into an implementable
repository change. The contract is normative; this plan may change in naming or
file layout during review, but its boundaries and exit criteria should remain.

## Goal

The next PR makes blob reachability executable rather than descriptive. It
centralizes retention edges, makes retryability explicit, refactors Cancel and
scheduled cleanup onto the same query, makes complete export tolerant of
missing bytes, and prevents accidental physical deletion of stable sources.

It targets `v2/backend-foundation` only. It does not run remote migrations or
deploy the v3 Worker.

## Why this is the next PR

PR #120 established stable IDs, canonical Comments, occurrence identities, and
soft-delete/restore behavior. Those changes make future Project references
possible, but they also mean a row can be hidden while its bytes remain part of
history and export.

The current cleanup implementation independently infers reachability from
submission status, while export independently enumerates keys. That is safe only
while the system has few source types and no Project references. The next phase
must establish one extension point before `reference_targets` and Project-owned
attachments add more edges.

## Scope

The PR includes:

1. explicit retry lifetime/closure for unfinished Comment submissions;
2. one derived blob retention-edge surface;
3. a concurrency-safe GC ledger and provider deletion state machine;
4. shared use by Cancel and scheduled cleanup;
5. availability-aware export with non-fatal warnings;
6. database protection against accidental physical deletion of stable sources;
7. a dedicated CI, migration, and deployment gate.

The PR does not include:

- `reference_targets` or backlinks;
- a privileged permanent-delete endpoint;
- Project, Project content, Text, Inspector, or Map;
- semantic or deterministic search;
- a generalized content-management rewrite;
- production or remote v3 migration/deployment.

## Current seams to replace

The implementation should remove duplicated lifecycle knowledge from these
areas:

- `worker/comment-upload-cleanup.ts`, which currently protects only selected
  submission states;
- Comment Cancel and upload retry/finalize paths;
- R2 and managed-storage deduplication lookups;
- `/api/exports/all` and `src/lib/exportAll.ts`, which currently assume listed
  keys are downloadable;
- any source route that physically deletes a stable source row.

Provider-specific authentication and object operations remain inside R2 or
`ManagedStorage` adapters.

## Proposed database migration

Add one migration, provisionally
`migrations/0016_blob_lifecycle_control.sql`.

### Explicit retryability

Add fields to `comment_submissions` equivalent to:

```text
retry_until
retry_closed_at
retry_closed_by
```

Creation assigns a documented retry window. Retry/upload/finalize paths require
`retry_closed_at IS NULL`. Scheduled cleanup may close retryability only after
`retry_until` and must record the transition. Cancel also closes retryability.

The exact field names may change, but “failed and still retryable” must be a
stored state, not a private age calculation in one cleanup function.

### Retention-edge view

Create a `blob_retention_edges` view that emits the locator and edge columns in
the contract. Use `UNION ALL` branches for each current source relationship.
Soft-delete columns are deliberately not filters for durable history edges.

The view should include current R2, managed-storage, and direct-key roots. If a
direct-key class is not GC-managed in this PR, it still appears for export and
integrity reporting.

Add indexes on every foreign-key/source column used by the view so reachability
checks do not become full-table scans.

### GC ledger

Create a table equivalent to:

```sql
CREATE TABLE blob_gc_ledger (
  store_kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  object_key TEXT NOT NULL,
  blob_record_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('orphaned', 'deleting', 'deleted')),
  operation_id TEXT,
  orphaned_at TEXT,
  deletion_started_at TEXT,
  deleted_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store_kind, provider, object_key)
);
```

The ledger records cleanup work; it is not the source of reachability. Existing
upload readiness fields remain upload/integrity metadata.

#### Relationship to existing status columns

The migration must avoid creating two contradictory GC authorities:

- `assets.status` remains upload/registration readiness (`pending`, `ready`, or
  `failed`). Scheduled GC no longer changes a successfully registered asset to
  `failed` merely because its physical object was collected. Retrieval,
  deduplication, and export combine upload readiness with the GC ledger.
- `managed_storage_objects.status` currently includes `orphaned` and `deleted`.
  During this slice it may remain as a compatibility projection for existing
  routes, but `blob_gc_ledger` is the authoritative cross-provider GC state.
  Any compatibility status transition must be written from the same claimed
  operation and tested for consistency.
- a row that represents an upload failure is not equivalent to a ready blob
  later collected by GC;
- direct-key provenance rows have no readiness column of their own and use
  owning-row state plus provider availability.

A later migration may simplify the compatibility columns, but this PR must
state and test which value is authoritative for every read and write.

### Physical-delete protection

Add `BEFORE DELETE` triggers for the stable referenceable source and occurrence
tables. The initial protected set is:

```text
samples
runs
run_steps
comment_submissions
run_step_comments
comment_submission_items
run_step_assets
metrology_template_references
template_versions
```

The first implementation keeps these triggers unconditional because no
permanent-delete endpoint is enabled. If review identifies another current
stable target, add it to both the trigger list and the source-identity contract
rather than silently broadening one side only.

Do not block legitimate deletion of ephemeral staging rows or Project-local
presentation rows that are not stable source targets. Local cascade rules for
future Project placements/edges are designed separately from source deletion.

Tests must execute representative direct `DELETE` statements and prove that no
parent, descendant, audit row, occurrence, or blob edge changes.

## Proposed modules

Prefer small modules over adding more lifecycle SQL directly to `worker/index.ts`.
A practical layout is:

```text
worker/blob-lifecycle/
  types.ts
  reachability.ts
  gc.ts
  export.ts
  storage.ts
  permanent-delete.ts
```

Equivalent flat filenames are acceptable if the repository avoids new
subdirectories.

### `types.ts`

Owns `BlobLocator`, `RetentionEdge`, `BlobExportEntry`, warning codes, GC states,
and structured permanent-delete blockers.

### `reachability.ts`

Owns all reads of `blob_retention_edges` and the guarded SQL used to mark or
release orphan candidates. No caller writes its own status-specific substitute.

Expected operations:

```text
listRetentionEdges(locator)
isBlobReachable(locator)
markOrphanCandidate(locator, operationId)
releaseOrphanCandidate(locator)
```

### `storage.ts`

Normalizes R2 and `ManagedStorage` operations behind:

```text
head/stat
get
remove
```

The provider result distinguishes confirmed absence from authentication or
transport failure. The interface never exposes credentials.

R2 uses `bucket.head/get/delete`. SWITCHdrive should use `HEAD` or `PROPFIND`
for metadata when available and fall back to a documented strategy.

### `gc.ts`

Implements:

```text
close expired retry windows
mark orphan candidates
claim aged candidates
perform provider deletion
finalize or record retryable failure
```

Provider calls occur after a guarded D1 claim. Every final update matches the
operation ID. The job is idempotent.

### `export.ts`

Builds a deduplicated blob export plan from database rows and retention edges,
then maps retrieval outcomes to warning records. It does not silently omit table
rows.

### `permanent-delete.ts`

For this PR, exposes blocker types and current source-specific blocker queries,
and verifies that physical deletion remains disabled. It does not expose an
actual destructive route.

The later reference-registry PR extends this module with Project backlinks and
tombstones rather than creating another deletion implementation.

## Route and job changes

### Submission creation and retry

- assign/extend the explicit retry window;
- reject retry/finalize after retry closure;
- deduplication queries exclude locators in `deleting` or `deleted` GC state;
- if the only matching bytes are being deleted, upload a new object or return a
  retryable conflict.

### Edge creation and deduplication

Every path that links an occurrence to existing bytes uses one authoritative
statement that:

1. confirms the source/occurrence is still writable;
2. confirms the blob metadata is ready;
3. confirms the locator is not `deleting` or `deleted`;
4. inserts the edge;
5. clears an unclaimed `orphaned` ledger row or makes the edge creation prevent
   the orphan claim.

A read-before-write deduplication lookup alone is insufficient.

### Cancel

1. marker-gate the authoritative transition;
2. close retryability;
3. collect affected locators;
4. ask shared reachability to mark only newly unreachable locators orphaned;
5. return without provider deletion.

### Scheduled cleanup

1. mark abandoned uploads failed without closing retryability prematurely;
2. close retry windows through an explicit guarded transition;
3. mark unreachable locators orphaned;
4. claim a bounded batch whose orphan grace elapsed;
5. delete/confirm absence at the provider;
6. finalize each claim by operation ID;
7. retain and report retryable failures.

Use small bounded batches. Do not build unbounded `IN` lists or exceed D1's
100-binding limit; use JSON bindings where a variable set can be large.

### Complete export

Bump the v3 export schema and replace the assumption that every `assetKeys`
entry is fetchable.

The server response should expose a deduplicated list such as:

```text
export_id
store_kind
provider
object_key or opaque export locator
blob_record_id
filename
expected_byte_size
expected_sha256
source_occurrences[]
download_url when metadata is ready
```

Do not expose managed-storage credentials or a raw provider URL. An export
locator may remain an authenticated application URL even when the manifest
records the internal provider/object-key identity in table JSON.

The browser:

1. writes all table JSON;
2. retrieves each ready export entry once;
3. records success or warning instead of throwing on the first failure;
4. writes the final manifest after retrieval attempts;
5. writes `export-warnings.json`;
6. generates the ZIP even when some bytes are missing.

A successful GET is the final confirmation that bytes were packaged. A prior
`head` result is advisory because the object can disappear before streaming.

### Permanent delete

No destructive route is enabled. Tests must prove that direct SQL deletion of a
stable source is rejected and cannot cascade. The blocker API remains internal
until `reference_targets`, backlinks, authorization, and tombstones exist.

## Concurrency design

D1 transactions cannot include provider I/O, so the design is intentionally
two-phase.

### Edge creation versus cleanup

A cleanup claim changes the ledger to `deleting`. All link/dedup paths check the
ledger in their authoritative SQL. A concurrent link created before the claim
makes the claim fail; a link attempted after the claim cannot reuse that blob.

### Restore versus cleanup

Soft-deleted durable occurrences remain retention edges, so ordinary Restore
should never race with GC for their bytes. A test must prove that such blobs
cannot be orphan-marked in the first place.

### Export versus cleanup

Export does not acquire a long retention lease. If cleanup wins after planning,
the retrieval becomes a structured warning. This keeps export bounded and avoids
leaking abandoned leases.

### Provider success versus D1 failure

A retry with the same claim operation checks provider absence and finalizes the
ledger. Provider delete is treated as idempotent.

## Tests

Create dedicated suites, for example:

```text
worker/blob-reachability.test.ts
worker/blob-gc.test.ts
worker/blob-export.test.ts
worker/permanent-delete-protection.test.ts
```

Use the existing SQLite D1 adapter with:

- a 100-bound-parameter assertion;
- hooks before authoritative statements and batches;
- fake R2 and managed-storage providers;
- controllable provider absence/failure;
- exact database-state assertions after conflicts.

The test matrix is defined normatively in
[BLOB_LIFECYCLE_CONTRACT.md](./BLOB_LIFECYCLE_CONTRACT.md#required-regression-tests).

## Verification and deployment commands

Add scripts equivalent to:

```json
{
  "test:blob-lifecycle": "vitest run worker/blob-*.test.ts worker/permanent-delete-protection.test.ts",
  "verify:blob-lifecycle": "npm run test:blob-lifecycle",
  "verify:v3-deployment": "npm run verify:blob-lifecycle && npm test && npm run build:deploy"
}
```

The exact glob should not accidentally exclude a contract suite.

Add a dedicated CI status, for example `pre-pr/blob-lifecycle`. Make it a hard
requirement for the integration branch.

Both `db:migrate:remote` and `deploy:remote` must run the v3 gate before applying
migrations. Low-level Wrangler commands should be kept in clearly named
internal scripts so the normal operator path cannot apply a migration first and
check the contract later.

The required order is:

```text
contract tests -> complete tests -> deploy build -> remote migration -> deploy
```

No command may apply a migration and then discover that the blob contract tests
failed.

## Recommended commit sequence

1. `Add blob lifecycle schema and retention view`
2. `Centralize blob reachability queries`
3. `Make retry closure, Cancel, and cleanup share reachability`
4. `Add guarded GC provider state machine`
5. `Make complete export availability-aware`
6. `Block physical deletion of stable sources`
7. `Add blob lifecycle deployment gate`

Each behavior commit includes its tests. Avoid one final test-only commit.

## Exit criteria

The PR is complete only when:

- one retention surface covers every current edge;
- explicit retry closure is enforced by API and cleanup;
- Cancel and scheduled cleanup use the shared surface;
- shared unfinished/ready/soft-deleted sources cannot lose bytes;
- GC claims are concurrency-safe and idempotent;
- existing status columns and the ledger cannot contradict each other;
- export packages available bytes once and records every failure as a warning;
- all database rows remain in complete export;
- stable source physical deletion is blocked without cascade;
- the dedicated CI and remote-operation gates pass;
- no remote migration or deployment was run while developing the PR.

## What follows

After this PR is merged and the gate is satisfied, the next phase may add:

1. `reference_targets` and backlinks;
2. a batch read-only resolver;
3. object-level deep links;
4. deterministic reference search;
5. Project-owned data and Text;
6. Map after the data and read models are stable.
