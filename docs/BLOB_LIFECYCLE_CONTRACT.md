# Blob lifecycle, export integrity, and permanent-delete contract

Status: normative v3 backend contract

Last reviewed: 2026-08-08 against `v2/backend-foundation`

This document is the single source of truth for physical file retention,
garbage collection, complete export, and permanent-delete safety. It applies to
R2 assets, managed-storage objects, direct import/provenance keys, and every
current or future attachment occurrence.

The source identity and soft-delete foundation is defined in
[v3 backend foundation](./V3_BACKEND_FOUNDATION.md). The product reason for that
foundation and the later Project/Text/Map phases is defined in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md). The concrete first
implementation is specified in
[blob lifecycle implementation plan](./BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md).

## Why this contract exists

PR #120 converted stable source records from destructive deletion to
soft-delete/restore semantics and separated attachment occurrences from shared
bytes. That conversion was required before Project references could be safe:
Project must point to a durable source or occurrence ID, not to copied content,
a timeline event, or a provider key.

Soft deletion also changes storage safety. A deleted parent row still exists,
shared bytes may be needed by active and deleted occurrences, and an unfinished
submission may share a deduplicated object with another submission. A cleanup
query based only on `ready`, `failed`, `cancelled`, or row age can therefore
remove bytes that the application still promises to restore or export.

This contract closes that boundary before reference registry, backlinks,
Project-owned content, Text, or Map are implemented.

## Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are used in their ordinary architecture
sense. A future implementation may choose different table or module names, but
it may not weaken the invariants in this document without a new design review.

## Terms

A **source** is a stable application record such as a Sample, Run, Run step,
canonical Comment, Recipe revision, verification, or future Project content.

An **occurrence** is the stable application identity through which bytes appear
in one source context. Current examples are `comment_submission_items`,
`run_step_assets`, `run_step_comments.asset_id`, and
`metrology_template_references`.

A **blob record** is database metadata describing physical bytes. Current blob
records are `assets` and `managed_storage_objects`. Imports and a few legacy
records also retain direct provider keys without a normalized blob record.

A **blob locator** identifies physical bytes independently of a source or
occurrence. The logical shape is:

```text
store kind + provider + object key
```

A **retention edge** is one reason a source or occurrence requires a blob to
remain recoverable.

A blob is **reachable** while at least one effective retention edge exists.
Reachability is about whether bytes must be retained; it is not proof that the
provider object currently exists.

A blob is **available** when its metadata is ready and the storage provider
confirms that the object exists or successfully streams it.

An **orphan candidate** is a blob with no retention edge. It is not immediately
eligible for physical deletion: age, grace-period, and concurrency guards still
apply.

A **reverse reference** is any stable relationship that would become invalid or
silently disappear if a source row were physically deleted.

## Core invariants

1. Occurrences and sources own meaning; blob records own bytes and deduplication.
2. Soft deletion never removes a retention edge by itself.
3. One source becoming terminal never releases bytes still reachable from
   another source, including another unfinished or retryable submission.
4. Cancel, scheduled cleanup, export planning, integrity checks, and any future
   permanent-delete planner MUST use the same reachability definition.
5. Reachability MUST be rechecked in the authoritative mutation that changes GC
   state. A preflight query alone is insufficient.
6. Physical provider deletion is never performed by an ordinary source Delete,
   Restore, or Cancel request.
7. Missing bytes are an integrity condition. They do not authorize source-row
   deletion and do not remove database history.
8. Full export always preserves database rows and continues when one or more
   physical objects are missing or temporarily unavailable.
9. Permanent deletion is conflict-first, privileged, explicit, and non-cascading.
10. Every new blob-bearing source type MUST extend the shared retention surface
    and its contract tests before it can be deployed.

## Authoritative reachability surface

The implementation MUST expose one repository-owned retention surface, ideally
an SQL view named `blob_retention_edges` plus a small TypeScript query API.
Routes and jobs MUST NOT carry private copies of large `NOT EXISTS` trees.

Each edge exposes at least:

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

`retain_until` is null for durable history and may be populated for an explicit
lease or retry window. The edge surface is derived from source relationships;
there is no mutable `is_reachable` boolean on a blob row.

The TypeScript boundary exposes one locator type and a small set of operations,
for example:

```ts
type BlobLocator =
  | { store: "r2"; key: string; assetId: string | null }
  | {
      store: "managed";
      provider: string;
      key: string;
      objectId: string | null;
    };

listRetentionEdges(db, locator)
isBlobReachable(db, locator)
markOrphanCandidate(db, locator, operationId, now)
claimBlobDeletion(db, locator, operationId, now)
```

Names are illustrative. The important rule is that every caller reaches the
same SQL definition.

## Current retention-edge matrix

### Durable R2 edges

The following rows retain the referenced `assets` bytes for as long as the
relationship row exists, even when that row or an ancestor is soft-deleted:

| Relationship | Retention reason |
|---|---|
| `state_representation_assets.asset_id` | Expected or inherited state representation |
| `run_step_assets.asset_id` | Execution or observation occurrence, including trash |
| `metrology_template_references.asset_id` | Metrology reference occurrence, including trash |
| `run_step_comments.asset_id` | Legacy Comment image occurrence, including independently deleted image state |
| `state_verifications.evidence_asset_id` | Verification evidence while the relationship exists |
| Ready `comment_submission_items.asset_id` under a durable canonical Comment | Canonical Comment attachment/image history |

A non-null legacy `events.asset_key` is a compatibility retention edge until it
is resolved to a stable occurrence or explicitly detached. `events` remains an
audit timeline and MUST NOT become the preferred attachment model.

### Durable managed-storage edges

A ready `comment_submission_items.storage_object_id` under a durable canonical
Comment retains the corresponding `managed_storage_objects` bytes. The item and
canonical Comment may be active or soft-deleted; both remain restorable and part
of complete export.

### Direct-key provenance edges

The following direct keys are retention roots until they are normalized into
ordinary blob records or their owning provenance row is permanently deleted:

- `imports.workbook_asset_key`;
- `imports.manifest_asset_key`;
- `template_versions.source_asset_key` when populated;
- any other documented compatibility field that promises later download.

Direct-key rows participate in export and integrity reporting even when the
first GC implementation does not physically collect them.

### Future Project edges

Project-owned attachment occurrences and any reference-owned attachment type
MUST emit ordinary retention edges. Adding Project tables must not require a
second cleanup algorithm.

## Submission reachability matrix

Comment submission status alone is not sufficient; item state and explicit
retryability also matter.

| Canonical submission | Item/blob state | Retention result |
|---|---|---|
| `ready`, active or soft-deleted | ready item with blob link | Durable edge |
| `draft` or `uploading` | non-cancelled item with registered blob | Unfinished edge |
| `failed`, retry still open | non-cancelled item with registered blob | Retry edge |
| `failed`, retry explicitly closed | no other edge | No submission edge |
| `cancelled` or explicitly expired | no other edge | No submission edge |
| any status | item itself cancelled before becoming durable | No item edge |

Retryability MUST be explicit. The implementation may use fields such as
`retry_until` and `retry_closed_at`, but Cancel, retry routes, scheduled cleanup,
and the retention view MUST all read the same authoritative state. Cleanup MUST
NOT infer “non-retryable” from age while the API would still accept retry or
Finalize.

A newly registered but not-yet-linked blob may be unreachable for a short
period. GC eligibility therefore also requires a minimum upload/registration
grace period; this grace is separate from reachability.

## Garbage-collection state machine

Reachability and GC state are separate. A dedicated ledger SHOULD represent GC
work without overloading upload readiness fields such as `assets.status`.

Recommended states:

```text
no ledger row  -> live or never considered for cleanup
orphaned       -> unreachable, waiting through grace period
deleting       -> claimed by one operation; new links may not reuse it
deleted        -> provider confirmed deletion or confirmed absence
```

The ledger records at least the locator, operation ID, orphaned time, deletion
claim time, terminal time, attempt count, and last error.

### Marking an orphan candidate

A mutation may mark a blob `orphaned` only when all of these hold in the same
guarded database operation:

1. no retention edge exists;
2. the minimum registration grace has elapsed;
3. no other cleanup operation owns the locator;
4. the candidate metadata is in a state that cleanup understands.

Creating a new edge clears an unclaimed orphan state or makes it ineffective.

### Claiming physical deletion

Scheduled cleanup may move `orphaned` to `deleting` only after the orphan grace
has elapsed and the shared reachability definition still returns no edges.
The claim writes a unique operation ID.

All deduplication and edge-creation paths MUST reject a blob in `deleting` or
`deleted` state. They may reuse another ready blob, upload new bytes, or return a
retryable conflict; they may not attach a new occurrence to a blob that cleanup
has already claimed.

### Provider deletion and finalization

Provider I/O occurs outside a D1 transaction:

1. claim the locator with an operation ID;
2. delete or confirm absence at the provider;
3. finalize `deleted` only if the operation ID still matches;
4. on retryable provider failure, retain the claim/error or return it to
   `orphaned` according to one documented policy.

The operation is idempotent. Retrying after provider success but before the
final database update MUST converge to `deleted`.

Cancel may close retryability and mark newly unreachable blobs as orphan
candidates, but only scheduled cleanup performs ordinary physical deletion.

## Shared use by Cancel, cleanup, export, and permanent deletion

### Cancel

Cancel first performs its authoritative submission transition. It then asks the
shared reachability layer which linked blobs became unreachable. It never
orphan-marks a blob while another active, unfinished, retryable, ready,
soft-deleted, archived, or future Project edge exists.

### Scheduled cleanup

Scheduled cleanup closes retryability only through an explicit state
transition, marks orphan candidates through the shared reachability query,
claims aged candidates, performs provider deletion, and records the outcome.
It does not maintain a separate list of protected statuses.

### Export

Export uses the same edge surface to explain why a blob is retained and to map
all occurrences to one physical export entry. Export availability checks do not
change reachability or GC state.

### Permanent deletion

Removing a source edge through a future permanent-delete plan may create an
orphan candidate, but the request does not delete physical bytes. It delegates
the resulting locator to the same GC flow.

## Complete-export contract

A complete export includes every database row, including:

- active, archived, and soft-deleted sources;
- failed and cancelled submissions;
- blob metadata in ready, orphaned, deleted, failed, or missing condition;
- retention/GC metadata needed to understand the snapshot.

The export byte plan is deduplicated by physical locator. The manifest records
all source/occurrence edges that led to one packaged object.

Only metadata that claims a ready object is scheduled for byte retrieval. A
provider existence probe or successful stream confirms availability. A later
GET failure is still handled as a warning because availability may change after
planning.

Each blob has a machine-readable result:

```text
packaged
missing
provider_unavailable
metadata_not_ready
download_failed
size_mismatch
hash_mismatch
```

Only `packaged` entries receive bytes in the ZIP. The ZIP MUST still be created
when other entries fail.

The final archive contains:

- all table JSON files;
- every successfully retrieved physical blob, once;
- `export-manifest.json` with final per-blob outcomes and occurrence mappings;
- `export-warnings.json`, even when empty.

Warnings include a stable code, locator or blob-record ID, affected source and
occurrence IDs, and a human-readable message. They MUST NOT contain provider
credentials, Access tokens, temporary URLs, or secrets.

The manifest is finalized after byte attempts; it must not claim a blob was
packaged before the download succeeds.

## Missing and unavailable bytes

A reachable blob may be physically missing. That condition:

- does not remove its source or occurrence row;
- does not make the source eligible for permanent deletion;
- does not convert soft deletion into permanent deletion;
- does not abort unrelated export entries;
- does produce an integrity/export warning.

Confirmed absence, provider authentication failure, provider timeout, and
metadata-not-ready are distinct outcomes.

## Permanent-delete contract

Ordinary Delete remains soft delete.

The next backend slice MUST hard-disable accidental physical deletion of stable
source tables. A privileged permanent-delete endpoint remains disabled until
`reference_targets`, backlinks, source-specific blocker queries, and tombstone
creation exist.

When permanent deletion is later enabled, it is eligible only when:

1. the source is already soft-deleted;
2. the required retention period has elapsed;
3. the caller has privileged authorization;
4. all reverse references and structural dependants have been checked;
5. the final blocker check and source mutation are concurrency-safe.

Any blocker returns HTTP `409`. A blocker result exposes stable fields such as:

```text
source_type
source_id
relation
blocker_type
blocker_id
blocker_state
```

Permanent deletion MUST NOT rely on foreign-key cascade. Parent deletion is not
a shorthand for deleting descendants. Every intended source removal is planned
and guarded explicitly, and a blocked operation leaves the entire graph
unchanged.

Force deletion is outside the first implementation. If ever introduced, it
requires a distinct operation, stronger authorization, a tombstone created
before content removal, and dedicated tests. A tombstone preserves only stable
identity, target type, last-known path, and deletion metadata; it does not
retain permanently deleted bodies or bytes.

Blob GC is not source permanent deletion. GC removes unreachable physical bytes
while preserving database and audit history.

## Required regression tests

### Reachability truth table

Cover every current retention edge and the full submission matrix, including
active, archived, soft-deleted, unfinished, retryable failed, retry-closed, and
cancelled states.

### Shared-object tests

At minimum:

- two unfinished submissions share one managed object;
- two unfinished submissions share one R2 asset;
- cancelling either one does not break the other;
- one soft-deleted ready source and one active source share bytes;
- one physical blob is shared across different occurrence types;
- an orphan candidate becomes reachable before deletion claim.

### Race tests

At minimum:

- Cancel versus upload completion;
- Cancel versus Finalize;
- retry versus retry closure;
- orphan marking versus creation of a new edge;
- deletion claim versus deduplicated edge creation;
- provider deletion success versus final database update retry;
- export planning/download versus cleanup;
- permanent-delete blocker check versus creation of a reverse reference.

### Missing-object and export tests

At minimum:

- missing R2 object with ready metadata;
- missing managed object with ready metadata;
- unavailable provider;
- metadata not ready;
- one missing shared object referenced by several occurrences;
- duplicate locators downloaded once;
- all table rows preserved;
- warning files written;
- ZIP generation succeeds despite one or several missing blobs.

### Permanent-delete protection tests

At minimum:

- stable source tables reject accidental physical deletion;
- known reverse references produce deterministic blockers;
- no blocked operation cascades into descendants;
- concurrent reference creation prevents deletion;
- future Project/reference edges can join the blocker surface without creating
  a second implementation.

## v3 migration and deployment gate

The blob lifecycle suite is a hard gate for:

- merging the implementation slice into `v2/backend-foundation`;
- applying any v3 remote migration;
- deploying the v3 Worker.

The repository MUST expose a dedicated command such as:

```text
npm run verify:blob-lifecycle
```

CI publishes a dedicated required status for this suite. The remote-migration
and v3 deployment commands run the same gate before touching remote resources.
A general TypeScript build or unrelated unit-test pass is not a substitute.

No v3 migration or deployment is allowed while any reachability, shared-object,
race, missing-object, export, or permanent-delete protection test fails.

## Non-goals of the next slice

The next implementation does not add Project tables, `reference_targets`,
backlinks, search, deep links, Text, Map, force delete, or source editing through
Project. It establishes the storage and deletion safety on which those phases
depend.
