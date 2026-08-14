# Blob lifecycle activation and operations

Status: operational companion to the normative v3 blob lifecycle contract

Last reviewed: 2026-08-14 after provider-verified storage integrity and
Project Markdown lifecycle wiring

This document records the implementation boundaries, activation sequence,
monitoring queries, incident rules, and explicit deferrals for the first blob
lifecycle implementation. The normative invariants remain in
[Blob lifecycle, export integrity, and permanent-delete contract](./BLOB_LIFECYCLE_CONTRACT.md).
If this runbook and the contract disagree, the contract wins. Product phase
order is outside this runbook and is defined only in
[PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md).

## Implemented runtime boundary

The first implementation uses the existing deployment only:

```text
one Cloudflare Worker
+ D1
+ private R2
+ optional ManagedStorage / SWITCHdrive
```

It does not require Queues, Workflows, Durable Objects, Containers, or a second
Worker. Domain operations remain ordinary TypeScript and guarded SQL so the
same semantics can later run from a queue consumer, Workflow, or self-hosted
background process without changing reachability.

The checked-in cron runs at:

```text
17 3 * * *
```

That is 03:17 UTC every day. The scheduled handler performs explicit retry
closure, orphan discovery, bounded deletion claims, provider deletion, and
operation-ID finalization.

## Authoritative surfaces

The implementation has four different kinds of truth. They must not be
collapsed into one status flag.

### Source and occurrence relationships

`blob_retention_edges` is the authority for whether physical bytes must be
retained. It covers current R2, managed-storage, unfinished/retryable submission,
soft-deleted durable, provenance, event image, and Sample-record thumbnail
relationships.

### Upload readiness

`assets.status` and the readiness part of `managed_storage_objects.status`
describe whether metadata registration/upload completed. They do not by
themselves authorize garbage collection.

### GC work state

`blob_gc_ledger` is the cross-provider authority for cleanup work:

```text
no row     live or not yet considered
orphaned   unreachable and inside the grace/retry cycle
deleting   claimed by one operation; new edges must be rejected
deleted    provider deletion or confirmed absence was finalized
```

`managed_storage_objects.status` remains a compatibility projection during this
slice. The ledger is authoritative when the two are interpreted for GC.

### Integrity quarantine

`blob_integrity_quarantine` records a definite provider-level absence or byte-size
mismatch found while considering a content-addressed reuse candidate. It is not a
GC state and does not erase historical metadata or existing relationships.

A provider/authentication/transport failure must never create a quarantine row.
The operation fails with a retryable service response and leaves metadata,
retention edges, and ledger state unchanged.

## Terminal locator rule

A `deleted` ledger entry is terminal for that physical locator. Operators and
application code must not clear it merely because bytes were manually recreated
at the same provider key.

Recovery from a terminal locator uses a new registered locator and a normal
occurrence/edge write. This prevents old audit history from silently referring
to different bytes under a recycled key.

An `orphaned` row may be released only through the guarded reachability/edge
creation path. A `deleting` row may be completed or idempotently reclaimed by
its operation ID; it must not be manually converted back to live state.

## Legacy managed-object migration repair

Before the shared ledger existed, Cancel/cleanup could mark managed object A as
`orphaned` while an unfinished submission still referenced it. The old partial
content-uniqueness index then allowed a later upload to create ready object B
with the same provider, SHA-256, and byte size.

If migration 0016 promoted A directly back to `ready`, the partial unique index
would reject the migration. The pre-0016 repair migration therefore rewires
`comment_submission_items.storage_object_id` from an orphaned object to an
already-ready content-identical winner before the shared reachability migration
runs. Stable submission and item IDs do not change. The redundant orphan locator
then remains eligible for the ordinary ledger/grace process.

The dedicated lifecycle gate contains a regression with both rows present and
must prove that the complete migration chain succeeds.

## Activation sequence

Merging code is not authorization to touch a remote v3 database. Activation is
permitted only from the exact merged `v2/backend-foundation` commit.

### Before merge

1. The PR head and generated merge result must both have successful:
   - `pre-pr/install`;
   - `pre-pr/blob-lifecycle`;
   - `pre-pr/tests`;
   - `pre-pr/build`.
2. The migration chain must be tested from 0001 through the latest file,
   including malformed historical event metadata and the legacy managed-object
   duplicate scenario.
3. No remote D1 migration or Worker deployment is run from the feature branch.

### After merge, before remote migration

1. Record the exact integration-head SHA.
2. Run `npm run verify:v3-deployment` from that exact checkout.
3. Create a fresh full-system export and retain it outside the deployment
   account.
4. Record the current D1 Time Travel bookmark or backup reference available to
   the account.
5. Confirm the generated Wrangler config points only to the isolated v3 Worker,
   D1 database, and R2 bucket.
6. List the pending D1 migrations and verify their order before applying them.
7. Use the gated `db:migrate:remote` or `deploy:remote` command. Do not call the
   internal Wrangler migration command directly.

Cloudflare D1 records migration paths and applies discovered migration files in
sequential order. Migration files with the same numeric prefix are ordered by
full relative path, so the pre-0016 legacy repair is deliberately named to sort
after the earlier 0015 migration and before 0016.

### After migration and deployment

Verify all of the following before entering real data:

1. `/api/ready` succeeds after Access authentication.
2. The scheduled trigger is present and still uses 03:17 UTC daily.
3. A disposable Comment can upload, finalize, soft-delete, restore, and export.
4. A Sample record with a primary image and a distinct thumbnail retains both
   locators.
5. A full ZIP contains all table JSON, `export-manifest.json`, and
   `export-warnings.json`.
6. No live retention edge points at a `deleting` or `deleted` locator.
7. No unexpected GC error/backlog is present.

## Operational queries

These read-only queries are suitable for an authenticated administrative
inspection or a trusted D1 console. They must not be turned into ad hoc mutation
scripts.

### Ledger backlog

```sql
SELECT state, COUNT(*) AS count,
       MIN(orphaned_at) AS oldest_orphaned_at,
       MIN(deletion_started_at) AS oldest_deletion_started_at
FROM blob_gc_ledger
GROUP BY state
ORDER BY state;
```

### Provider failures

```sql
SELECT store_kind, provider, object_key, state, attempt_count,
       last_error, updated_at
FROM blob_gc_ledger
WHERE last_error IS NOT NULL
ORDER BY updated_at DESC
LIMIT 100;
```

### Impossible live-edge/terminal-ledger overlap

The expected result is zero rows.

```sql
SELECT bg.store_kind, bg.provider, bg.object_key, bg.state,
       COUNT(*) AS edge_count
FROM blob_gc_ledger bg
JOIN blob_retention_edges bre
  ON bre.store_kind = bg.store_kind
 AND bre.provider = bg.provider
 AND bre.object_key = bg.object_key
WHERE bg.state IN ('deleting', 'deleted')
GROUP BY bg.store_kind, bg.provider, bg.object_key, bg.state;
```

### Integrity quarantine

```sql
SELECT store_kind, provider, object_key, blob_record_id, reason,
       expected_byte_size, observed_byte_size, detected_at, last_checked_at
FROM blob_integrity_quarantine
ORDER BY detected_at DESC
LIMIT 100;
```

Each row requires investigation or restoration at a new locator. Do not delete a
row merely to make the original locator reusable.

### Managed compatibility projection mismatches

The expected result is zero rows after a completed cleanup operation.

```sql
SELECT mso.id, mso.provider, mso.object_key,
       mso.status AS compatibility_status,
       bg.state AS ledger_state
FROM managed_storage_objects mso
JOIN blob_gc_ledger bg
  ON bg.store_kind = 'managed'
 AND bg.provider = mso.provider
 AND bg.object_key = mso.object_key
WHERE (bg.state = 'deleted' AND mso.status <> 'deleted')
   OR (bg.state = 'orphaned' AND mso.status NOT IN ('orphaned', 'ready'));
```

### Open retry windows

```sql
SELECT status, COUNT(*) AS count,
       MIN(retry_until) AS earliest_retry_until
FROM comment_submissions
WHERE retry_closed_at IS NULL
  AND status IN ('draft', 'uploading', 'failed')
GROUP BY status
ORDER BY status;
```

## Incident response rules

### Reachable metadata but missing bytes

Treat this as an integrity incident, not as deletion authorization. A definite
missing or size-mismatched candidate discovered during deduplication is recorded
in `blob_integrity_quarantine` and is not returned as a reusable winner.

- Preserve the source, occurrence, blob metadata, quarantine row, and export
  warning.
- Check provider history, credentials, retention, and external backups.
- Do not remove a retention edge or quarantine row to make the warning disappear.
- Restore by registering verified bytes at a new locator and explicitly repairing
  affected relationships through a reviewed procedure.

### Provider unavailable

- Keep the ledger/source state unchanged except for any ordinary retryable cleanup
  error.
- Deduplication reuse returns a retryable service error and creates no integrity
  quarantine row.
- Verify credentials and provider health.
- Re-run the normal scheduled/idempotent operation after recovery.
- Do not mark the object missing solely because authentication or transport
  failed.

### Stale `deleting` claim

The scheduled worker may reclaim a stale claim with the same operation ID and
repeat the idempotent provider delete. Do not assign a new edge to the locator
or manually remove the claim.

### Large orphan backlog

The implementation intentionally uses bounded batches. One run may not drain a
large historical backlog. Repeated scheduled runs are safe; raising the batch
size requires a separate performance review against Worker duration, provider
rate limits, and D1 statement limits.

## Explicitly deferred integrity work

The following are known boundaries, not hidden implementation promises.

### Quarantine revalidation and relationship repair

The current implementation deliberately treats definite missing and size-mismatch
quarantine as terminal for the old physical locator. It does not automatically
clear quarantine when bytes later reappear at the same key, because that could
silently bind historical metadata to different bytes.

A future privileged repair workflow may verify restored content, register a new
locator, and rebind affected relationships with explicit audit records. Until
then, restoration uses a fresh locator and reviewed data repair.

### Direct-key physical garbage collection

Import workbook/manifest keys, Template source keys, and legacy event keys are
part of reachability and export. The first GC scanner physically collects
normalized `assets` and `managed_storage_objects`; it does not independently
sweep every direct-key provenance class.

A future normalization/integrity migration may convert those keys to ordinary
blob records before enabling physical collection.

### Browser-side ZIP memory

The current full export downloads blobs sequentially but builds the ZIP in the
browser with JSZip. Packaged bytes, ZIP structures, and the final Blob consume
browser memory. Missing blobs no longer abort the archive, but a sufficiently
large otherwise-valid archive can still exceed browser memory or browser Blob
limits.

Before Project attachments or dataset size make this material, introduce a
streaming/server-side or desktop export path while preserving the same manifest
and warning contract. Until then, run periodic exports and verify that the
archive opens; do not assume a button click alone proves backup success.

### Retry backoff and alerting

Provider failures are recorded and retried idempotently, but the first version
does not have exponential backoff, `next_attempt_at`, alert delivery, or an
administrative GC dashboard. The daily cron limits retry pressure. Repeated
`last_error` rows require operator attention.

### Permanent-delete authorization

Physical deletion of stable source/occurrence rows remains unconditionally
blocked. The current blocker queries are conservative planning information, not
a proof that deletion is authorized. A destructive endpoint requires
`reference_targets`, Project reverse relations, privileged authorization,
final concurrency checks, and tombstones.

## Product-roadmap ownership

Reference identity, deep links, exact focus, deterministic search, and the
reusable Project discovery surface were completed after this operational
foundation, through PR #130. Provider-verified reuse and integrity quarantine are
now part of the same permanent blob-lifecycle gate.

This runbook does not define the remaining product sequence. The active
Map-first Project roadmap and Reading behavior are governed exclusively by
[PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md) and
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).
Operational activation requirements in this document apply regardless of
product phase order.

Every future Project attachment occurrence must add an ordinary branch to
`blob_retention_edges`, guarded edge-creation tests, export occurrence mapping,
and permanent-delete blockers before deployment.
