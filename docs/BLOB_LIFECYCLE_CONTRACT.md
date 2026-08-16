# Blob lifecycle, export integrity, and permanent-delete contract

Status: normative v3 backend contract, implemented by the blob-lifecycle safety slice

Last reviewed: 2026-08-16 during the provider-integrity and recovery
architecture review in PR #141

This document is the single source of truth for physical file retention,
garbage collection, complete export, and permanent-delete safety. It applies to
R2 assets, managed-storage objects, direct import/provenance keys, and every
current or future attachment occurrence.

The source identity and soft-delete foundation is defined in
[v3 backend foundation](./V3_BACKEND_FOUNDATION.md). Project ownership and
interaction are defined in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md) and
[Project Canvas interaction contract](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).
Current product sequencing is defined only in
[the product roadmap](./PRODUCT_ROADMAP.md). Implementation and operational
details are recorded in
[blob lifecycle implementation plan](./BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md)
and
[blob lifecycle activation and operations](./BLOB_LIFECYCLE_OPERATIONS.md).

## Why this contract exists

PR #120 converted stable source records from destructive deletion to
soft-delete/restore semantics and separated attachment occurrences from shared
bytes. That conversion was required before Project references could be safe:
Project must point to a durable source or occurrence ID, not to copied content,
a timeline event, or a provider key.

Soft deletion also changes storage safety. A hidden parent row still exists,
shared bytes may be needed by active and deleted occurrences, and an unfinished
submission may share a deduplicated object with another submission. A cleanup
query based only on `ready`, `failed`, `cancelled`, or row age can therefore
remove bytes that the application still promises to restore or export.

This contract closed that boundary before later reference and Project-owned
attachment types added more edges.

## Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are used in their ordinary architecture
sense. A future implementation may choose different table or module names, but
it may not weaken these invariants without a new design review.

## Terms

A **source** is a stable application record such as a Sample, Run, Run step,
canonical Comment, Recipe revision, verification, or future Project content.

An **occurrence** is the stable application identity through which bytes appear
in one source context. Current examples include `comment_submission_items`,
`run_step_assets`, `run_step_comments.asset_id`,
`metrology_template_references`, timeline image events, and Sample-record
thumbnails stored in event metadata.

A **blob record** is database metadata describing physical bytes. Current blob
records are `assets` and `managed_storage_objects`. Imports and a few legacy
records also retain direct provider keys without a normalized blob record.

A **blob locator** identifies physical bytes independently of a source or
occurrence:

```text
store kind + provider + object key
```

A **retention edge** is one reason a source or occurrence requires a blob to
remain recoverable.

A blob is **reachable** while at least one effective retention edge exists.
Reachability says bytes must be retained; it does not prove that the provider
object currently exists.

A blob is **available** when its metadata is ready and the storage provider
confirms that the object exists or successfully streams it.

An **orphan candidate** is a blob with no retention edge. It is not immediately
eligible for physical deletion: age, grace-period, and concurrency guards still
apply.

A **reverse reference** is any stable relationship that would become invalid or
silently disappear if a source row were physically deleted.

## Core invariants

1. Occurrences and sources own meaning; blob records own bytes and deduplication.
2. Soft deletion or archival never removes a durable retention edge by itself.
3. One source becoming terminal never releases bytes still reachable from
   another source, including another unfinished or retryable submission.
4. Cancel, scheduled cleanup, export planning, integrity checks, and future
   permanent-delete planning MUST use the same reachability definition.
5. Reachability MUST be rechecked in the authoritative mutation that changes GC
   state. A preflight query alone is insufficient.
6. Physical provider deletion is never performed by an ordinary source Delete,
   Restore, or Cancel request.
7. Missing bytes are an integrity condition. They do not authorize source-row
   deletion and do not remove database history.
8. Full export preserves database rows and continues when one or more physical
   objects are missing or temporarily unavailable.
9. Permanent deletion is conflict-first, privileged, explicit, and
   non-cascading.
10. A locator finalized as `deleted` is terminal and MUST NOT be silently reused
    for different bytes.
11. Every new blob-bearing source type MUST extend the shared retention surface,
    export occurrence map, edge guards, blocker surface, and contract tests
    before deployment.
12. Runtime orchestration may change, but Queue, Workflow, cron, or self-hosted
    execution MUST NOT change the retention semantics.

## Authoritative reachability surface

The repository exposes one retention surface, implemented as the
`blob_retention_edges` SQL view plus a small TypeScript query API. Routes and
jobs MUST NOT carry private copies of large status-specific `NOT EXISTS` trees.

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
retry window. The edge surface is derived from relationships; there is no
mutable `is_reachable` boolean on a blob row.

The TypeScript boundary uses one locator type and shared operations equivalent
to:

```text
listRetentionEdges
isBlobReachable
markOrphanCandidate
claimBlobDeletion
reclaimBlobDeletion
```

Names may evolve. The important rule is that all callers reach the same SQL
definition.

## Current retention-edge matrix

### Durable R2 edges

The following relationships retain referenced R2 bytes for as long as the
relationship exists, including when the occurrence or an ancestor is
soft-deleted:

| Relationship | Retention reason |
|---|---|
| `state_representation_assets.asset_id` | Expected or inherited state representation |
| `run_step_assets.asset_id` | Execution or observation occurrence, including trash |
| `metrology_template_references.asset_id` | Metrology reference occurrence, including trash |
| `run_step_comments.asset_id` | Legacy Comment image occurrence, including independently deleted image state |
| `state_verifications.evidence_asset_id` | Verification evidence while the relationship exists |
| Ready `comment_submission_items.asset_id` under a durable canonical Comment | Canonical Comment attachment/image history |
| `events.asset_key` while non-null | Legacy/timeline image compatibility edge |
| `events.metadata_json.thumbnailKey` when distinct and valid | Sample-record thumbnail occurrence |

A timeline event remains an audit record and MUST NOT become the preferred model
for new attachment types. The primary event asset and its thumbnail are separate
edges; detaching or deleting the Sample record must remove both keys from the
active event representation.

Malformed historical event metadata MUST NOT make a migration, retention view,
index, blocker query, or cleanup job fail. JSON-derived edges use guarded
parsing and simply omit an invalid value.

### Durable managed-storage edges

A ready `comment_submission_items.storage_object_id` under a durable canonical
Comment retains the corresponding `managed_storage_objects` bytes. The item and
canonical Comment may be active or soft-deleted; both remain restorable and part
of complete export.

### Direct-key provenance edges

The following direct keys remain retention roots until normalized into ordinary
blob records or their owning provenance row is permanently deleted:

- `imports.workbook_asset_key`;
- `imports.manifest_asset_key`;
- `template_versions.source_asset_key` when populated;
- any documented compatibility field that promises later download.

Direct-key rows participate in reachability, export, and integrity reporting
even when the first GC scanner does not physically collect that class.

### Future Project edges

Project-owned attachment occurrences and any reference-owned attachment type
MUST emit ordinary retention edges. Adding Project tables must not require a
second cleanup algorithm.

## Submission reachability matrix

Comment status alone is insufficient; item state and explicit retryability also
matter.

| Canonical submission | Item/blob state | Retention result |
|---|---|---|
| `ready`, active or soft-deleted | ready item with blob link | Durable edge |
| `draft` or `uploading`, retry open | non-cancelled item with registered blob | Unfinished edge |
| `failed`, retry open | non-cancelled item with registered blob | Retry edge |
| retry explicitly closed | no other edge | No submission edge |
| `cancelled` or system-expired | no other edge | No submission edge |
| any status | item itself cancelled before becoming durable | No item edge |

Retryability is stored through explicit fields such as `retry_until` and
`retry_closed_at`. Cancel, retry routes, scheduled cleanup, and the retention
view all read the same state.

When an unfinished retry window expires, the first implementation performs an
explicit system cancellation: the canonical submission becomes `cancelled`,
`retry_closed_at`/`retry_closed_by` are recorded, and unfinished items become
`cancelled`. The rows remain in complete export but disappear from ordinary
recovery UI and no longer retain bytes by themselves.

A newly registered but not-yet-linked blob may be unreachable briefly. GC
eligibility therefore also requires a minimum registration grace; this grace is
separate from reachability and retryability.

## Legacy managed-object migration rule

Before the shared ledger existed, legacy Cancel/cleanup could mark managed
object A `orphaned` while an unfinished submission still referenced it. Because
the old content-uniqueness index covered only `status = 'ready'`, a later upload
could create ready object B with identical provider, SHA-256, and byte size.

Before migration 0016 promotes reachable orphaned objects back to ready, a
pre-0016 repair MUST rewire Comment item occurrences from A to an already-ready
content-identical winner B. Stable submission/item IDs do not change. The
redundant orphan locator then enters the ordinary GC ledger. This prevents the
partial unique index from aborting the lifecycle migration.

The migration gate MUST include this exact legacy state as a regression.

## Garbage-collection state machine

Reachability and GC state are separate. `blob_gc_ledger` records cross-provider
cleanup work without overloading upload readiness fields.

```text
no ledger row  -> live or never considered
orphaned       -> unreachable, waiting through grace/retry cycle
deleting       -> claimed by one operation; new links are rejected
deleted        -> provider deletion or confirmed absence finalized
```

The ledger records locator, blob-record ID where available, operation ID,
orphaned time, claim time, terminal time, attempt count, last error, and update
time.

### Marking an orphan candidate

A blob may enter `orphaned` only when all of these hold in the guarded database
mutation:

1. no retention edge exists;
2. registration grace has elapsed;
3. no deletion operation owns the locator;
4. metadata is in a state understood by cleanup.

Creating a new edge clears an unclaimed orphan state or makes the orphan claim
fail.

### Claiming physical deletion

Scheduled cleanup may move `orphaned` to `deleting` only after orphan grace has
elapsed and the shared reachability definition still returns no edges. The
claim writes a unique operation ID.

All deduplication and edge-creation paths reject a blob in `deleting` or
`deleted`. They may reuse another ready blob, upload new bytes, or return a
retryable conflict; they may not attach a new occurrence to a claimed locator.

### Provider deletion and finalization

Provider I/O occurs outside a D1 transaction:

1. claim the locator with an operation ID;
2. delete or confirm absence at the provider;
3. finalize `deleted` only if the operation ID still matches;
4. record retryable provider failure without losing source history.

The operation is idempotent. Retrying after provider success but before the
final database update converges to `deleted`.

### Terminal locator rule

A `deleted` ledger row is not cleared when bytes are manually recreated at the
same key. Recovery registers verified bytes under a new locator and creates a
normal guarded edge. This prevents historical metadata from silently referring
to different bytes.

An `orphaned` row may be released only through the shared edge/reachability path.
A `deleting` claim may be completed or reclaimed using its operation ID; it is
not manually converted back to live state.

Cancel may close retryability and mark newly unreachable blobs as orphan
candidates, but only scheduled cleanup performs ordinary provider deletion.

## Shared use by Cancel, cleanup, export, and permanent deletion

### Cancel

Cancel first performs its authoritative submission transition. It then asks the
shared reachability layer which linked blobs became unreachable. It never
orphan-marks a blob while another active, unfinished, retryable, ready,
soft-deleted, archived, or future Project edge exists.

### Scheduled cleanup

Scheduled cleanup closes retryability through an explicit state transition,
marks candidates through the shared view, claims an aged bounded batch, performs
provider deletion, and records the result. It does not maintain a separate list
of protected statuses.

### Export

Export uses the same edge surface to explain why a blob is retained and maps all
occurrences to one physical export entry. Availability checks do not change
reachability or GC state.

### Permanent deletion

Removing an edge through a future permanent-delete plan may create an orphan
candidate, but the request does not delete physical bytes. It delegates the
locator to the same GC flow.

## Complete-export contract

A complete export includes every database row, including:

- active, archived, and soft-deleted sources;
- failed and cancelled submissions;
- blob metadata in ready, orphaned, deleting, deleted, failed, or missing
  condition;
- retention and GC metadata needed to understand the snapshot.

The byte plan is deduplicated by physical locator. The manifest records all
source/occurrence edges that led to one packaged object.

Only metadata that claims a ready object is scheduled for retrieval. A
successful stream is the final confirmation of availability; planning cannot
promise that an object will still exist during download.

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

Only `packaged` entries receive bytes in the ZIP. Other outcomes create warnings
and do not abort unrelated entries.

The final archive contains:

- all table/view JSON snapshots;
- every successfully retrieved physical blob, once;
- `export-manifest.json` with final outcomes and occurrence mappings;
- `export-warnings.json`, even when empty.

Warnings include stable codes, locator/blob-record identity, affected source and
occurrence IDs, and a human-readable message. They MUST NOT contain provider
credentials, Access tokens, temporary URLs, or secrets.

The manifest is finalized after byte attempts; it must not claim packaging
before download, size, and optional hash checks succeed.

## Missing and unavailable bytes

A reachable blob may be physically missing. That condition:

- does not remove its source or occurrence row;
- does not make the source eligible for permanent deletion;
- does not convert soft deletion into permanent deletion;
- does not abort unrelated export entries;
- does produce an integrity/export warning.

Confirmed absence, authentication failure, timeout, metadata-not-ready, size
mismatch, and hash mismatch are distinct outcomes.

## Permanent-delete contract

Ordinary Delete remains soft delete.

Accidental physical deletion of stable source/occurrence tables is disabled. A
privileged permanent-delete endpoint remains disabled until `reference_targets`,
Project reverse relations, source-specific blocker queries, authorization, and
tombstone creation exist.

When permanent deletion is later enabled, eligibility requires:

1. the source is already soft-deleted;
2. the retention period has elapsed;
3. the caller has privileged authorization;
4. every reverse reference and structural dependant has been checked;
5. the final blocker check and source mutation are concurrency-safe.

Any blocker returns HTTP `409` and exposes stable fields such as:

```text
source_type
source_id
relation
blocker_type
blocker_id
blocker_state
```

Permanent deletion MUST NOT rely on foreign-key cascade. Parent deletion is not
a shorthand for deleting descendants. Every intended removal is planned and
guarded explicitly, and a blocked operation leaves the entire graph unchanged.

Current blocker queries are conservative planning data, not authorization to
delete. Physical-delete triggers remain authoritative until a later planner can
drop or bypass them through a privileged, audited, tombstone-producing path.

Force deletion is outside this implementation. If ever introduced, it requires
a distinct operation, stronger authorization, a tombstone created before
content removal, and dedicated tests. A tombstone retains stable identity,
target type, last-known path, and deletion metadata; it does not retain bodies
or bytes that were intentionally permanently removed.

Blob GC is not source permanent deletion. GC removes unreachable provider bytes
while preserving database and audit history.

## Recovery supersession of duplicate stable occurrences

Canonical blob recovery MUST NOT physically merge or delete stable occurrence
rows. When a legacy occurrence and an independently existing occurrence resolve
to the same provider-verified SHA-256 and byte size:

- the existing canonical occurrence is the surviving live occurrence;
- the legacy occurrence keeps its ID, context, ordering, author/display
  metadata, and creation timestamp;
- the legacy row is soft-deleted if necessary and records the successor
  occurrence, recovery operation, actor, and supersession time;
- a superseded occurrence is immutable and cannot be restored as a second live
  duplicate;
- physical-delete guards remain unconditional;
- only the superseded occurrence's byte-retention edge transfers to the healthy
  successor; ordinary soft-deleted occurrences continue to retain bytes;
- export and reference history keep both occurrence rows, while GC may collect
  only the superseded physical locator after every other retention edge is
  absent.

Supersession is a narrowly validated repair operation, not a general deduplication
or permanent-delete capability.

## Provider verification and integrity quarantine

Deduplication verifies the selected physical locator before reuse. R2 uses
provider `HEAD`; managed storage uses the adapter's metadata-only `stat`
operation. A transient provider, authentication, transport, configuration, or
primary-authority failure returns retryable `503` and does not change
quarantine or GC state.

Confirmed absence and byte-size mismatch create a locator-scoped
`blob_integrity_quarantine` record. Quarantine preserves source, occurrence,
blob-record, and export history while excluding the locator from ordinary
delivery and future deduplication. It also releases the content hash so
provider-verified identical bytes may be registered at a new unique locator.
Existing historical edges remain visible for audit and export, but new
relationships cannot bind the quarantined locator.

## Explicit first-implementation boundaries

These are documented deferrals, not implied features.

### Direct-key physical GC

Direct provenance keys participate in reachability and export. The first GC
scanner physically collects normalized `assets` and `managed_storage_objects`;
it does not independently sweep every direct-key class.

### Browser-side ZIP scale

The first full export downloads sequentially but builds the ZIP in browser
memory. Missing blobs are non-fatal, but a sufficiently large valid archive can
still exceed browser memory or Blob limits. A streaming/server-side or desktop
export path must preserve the same manifest/warning contract when introduced.

### Retry backoff and alerting

Provider failures are recorded and retried idempotently. The first version does
not provide exponential backoff, `next_attempt_at`, alert delivery, or an
administrative GC dashboard. The daily bounded cron limits pressure; repeated
errors require operator review.

Operational procedures and read-only inspection queries are defined in
[blob lifecycle activation and operations](./BLOB_LIFECYCLE_OPERATIONS.md).

## Required regression tests

### Reachability truth table

Cover every current edge and the full submission matrix, including active,
archived, soft-deleted, unfinished, retryable failed, retry-closed, system-
cancelled, and user-cancelled states. Include distinct Sample-record primary and
thumbnail assets and malformed historical event metadata.

### Shared-object tests

At minimum:

- two unfinished submissions share one managed object;
- two unfinished submissions share one R2 asset;
- cancelling either one does not break the other;
- one soft-deleted ready source and one active source share bytes;
- one physical blob is shared across occurrence types;
- an orphan candidate becomes reachable before deletion claim;
- a legacy referenced orphaned managed object coexists with a ready
  content-identical winner and the migration chain succeeds.

### Race tests

At minimum:

- Cancel versus upload completion;
- Cancel versus Finalize;
- retry versus retry closure;
- orphan marking versus creation of a new edge;
- deletion claim versus deduplicated edge creation;
- concurrent live-SHA registration and winner recovery;
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
- ZIP generation succeeds despite one or several missing blobs;
- size and SHA-256 mismatches are not packaged.

### Permanent-delete protection tests

At minimum:

- every protected stable table rejects accidental physical deletion;
- every declared blocker target has a total, fail-closed query;
- known reverse references produce deterministic blockers;
- malformed audit metadata does not crash blocker planning;
- no blocked operation cascades into descendants;
- concurrent reference creation prevents deletion;
- future Project/reference edges can join the blocker surface without a second
  implementation.

## v3 migration and deployment gate

The blob lifecycle suite is a hard gate for:

- merging the implementation slice into `v2/backend-foundation`;
- applying any v3 remote migration;
- deploying the v3 Worker.

The repository exposes:

```text
npm run verify:blob-lifecycle
npm run verify:v3-deployment
```

CI publishes a dedicated `pre-pr/blob-lifecycle` status. Normal remote-migration
and deployment commands run the lifecycle suite, complete tests, and deployment
build before touching remote resources. A general build is not a substitute.

After merge, the exact integration-head commit must pass the same gate before
remote activation. No v3 migration or deployment is allowed while any
reachability, shared-object, migration, race, missing-object, export, or
permanent-delete protection test fails.

## Non-goals and roadmap ownership

This blob-lifecycle implementation did not itself add Project tables, the
reference registry, deterministic search, deep links, a privileged destructive
endpoint, or source editing through Project. Those exclusions describe the
historical scope of the lifecycle slice; they do not define the current product
phase order.

Reference identity, navigation, deterministic search, and the reusable Project
discovery surface were subsequently completed through PR #130. The active
Map-first Project sequence and Reading behavior are governed exclusively by
[PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md) and
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).
This normative storage contract applies unchanged regardless of product order.

## Recovery publication and ownership boundary

`blob_retention_edges` answers only whether a physical locator must be retained. It is not an authorization or publication surface. FabuBlox recovery uses the dedicated `fabublox_recovery_public_asset_edges` and `fabublox_recovery_import_asset_edges` projections installed by `0026_fabublox_recovery_ownership.sql`.

For an asset whose owning import becomes terminal:

- an independently public consumer permits provider-verified re-homing as a standalone `ready` asset;
- an unresolved pending import inherits ownership and the asset remains `pending` and non-public;
- an unresolved failed import may inherit terminal ownership so its later recovery remains responsible for cleanup;
- no viable consumer releases the asset to `failed` and operation-ID GC;
- a missing or size-mismatched provider object is quarantined and never promoted solely because a retention edge exists.

R2 verification occurs before the durable recovery claim. A transient provider failure therefore leaves `recovery_operation_id` unset and the whole operation retryable. A legacy `failed` asset whose SHA was cleared is read from R2, re-hashed, and assigned the provider byte size before any transition to `pending` or `ready`.

## Complete import dependency publication

An import may publish only when every asset in its staged dependency graph is
publishable. The graph includes direct import-owned assets, workbook and manifest
provenance, template source files, initial-state images, expected-state images,
and metrology references. Asset ownership is not sufficient: a standalone or
other-import asset required by the template must itself be ready, unquarantined,
outside terminal GC, and either standalone or owned by a ready import.

Recovery and finalization consume the same `fabublox_import_asset_dependencies`
surface. A pending import may retain or inherit a locator without publishing it;
a known-missing shared state image therefore blocks finalization even when a
Sample, Run, or other durable source still retains the historical occurrence.

## Uncertain registration outcomes

An uploaded provider object and its stable database identity form one registration attempt. If the INSERT response is uncertain, the writer must first read the exact `(id, provider, object_key, sha256)` record from primary D1. An exact committed record is the writer's own successful result and its provider object must not be deleted. Only after that reconciliation returns no record may the writer select a different content-addressed winner and delete the redundant upload.

This rule applies uniformly to ordinary R2 assets, Project uploads, metrology references, Comment images, and managed Comment attachments. A content-hash lookup alone cannot distinguish the writer's own committed row from a competing winner.

## Provider-write registration boundary

Provider bytes must never exist without a database identity that ordinary GC can enumerate. Every new R2 or managed registration therefore follows this order:

1. create a non-public metadata candidate with a unique provider locator;
2. write the provider object only after the candidate is confirmed on primary D1;
3. promote exactly one same-content candidate to `ready`;
4. leave losing or uncertain candidates as tracked non-public rows for GC;
5. never delete a locator merely because another database ID won when both attempts could share that locator.

Comment uploads use a unique locator per registration attempt, including same-item retries. This prevents different-SHA same-size requests from overwriting one another before database coordination. A primary-authority failure returns retryable `503` and preserves the tracked candidate. Legacy FabuBlox recovery may rebind durable occurrences to a verified canonical same-SHA/same-size winner only after a persistent recovery claim; the superseded locator then follows normal GC.
