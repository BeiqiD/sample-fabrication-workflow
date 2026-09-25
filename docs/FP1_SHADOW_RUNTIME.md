# FP1 shadow conversion runtime

Implementation base: Draft PR #221, `d1698b4ec12e612cfd31b29280c8e60f4b6104d4`.
This slice adds migration `0008_fp1_shadow_runtime.sql`, explicit shadow
conversion operations and complete archive schema **15**, writer **1**, profile
`fp1-shadow-conversion`. It is a reviewable implementation, not evidence of a
remote migration, production conversion or completed FP1 authority activation.

## Business writes and occurrence identity

All 13 locator slots across the 11 existing consumer tables are captured by
SQLite triggers in the business writer's transaction. This includes old Workers,
accepted-result publication, UPSERT, replacement, deletion and later recreation.
A source row's physical rowid, exact slot key and relevant metadata dependencies
identify its current generation. Immutable occurrences and closures retain the
history; `file_shadow_heads` identifies the current generation. A changed source
or relevant parent, registry, receipt, namespace or lifecycle dependency produces
a successor. Exact dependency metadata is retained in immutable
`file_shadow_dependency_versions` records. Each occurrence stores typed dependency
keys and revision tokens, avoiding repeated full metadata expansion in D1 triggers. An unchanged business replay does not authorize another provider
write.

Capture records pending conversion durably; conversion runs explicitly after the
business transaction. The old business File foreign-key columns and frozen
`file_consumer_migration_decisions` stay empty. The mutable generation sidecars
avoid activating the fill-once guards of migration `0007` on legacy event rows.
Existing business reads and byte writes still use their established paths.
Resolved decisions belong to one occurrence, not to a reusable business ID.
Deleting and recreating an ID cannot inherit its old decision.

Migration rejects any row in the 11 business source tables whose legacy TEXT
primary-key component is NULL, including rows without a current file slot, before
installing new schema. Empty or NUL-containing historical TEXT
identifiers retain their exact meaning. This is an explicit migration
qualification boundary, not a repair that silently drops those records.

## Execution and byte ownership

Migration installs `legacy` mode and a disabled local execution gate. An explicit
epoch-fenced enable command admits `overlap`; no command in this slice admits
`active`. Profile write enablement is separate and binds an already recorded
profile/revision to the exact deployed R2 or SWITCHdrive namespace. Neither
provider URLs nor credentials are accepted from a conversion request.

An accepted operation freezes the occurrence, metadata baseline, source byte
expectation, purpose, access scope and both profile revisions. Before provider
work it records a single attempt owner and source hold. Before PUT it records a
fresh File, location, destination hold and immutable object key. Complete source
and destination reads verify size and SHA-256. Publication and the current
occurrence decision commit together in a guarded D1 batch. Cross-purpose copies
receive independent File identities and keys; legacy asset hash deduplication
does not collapse these copies.

The R2 shadow writer uses workerd's known-length `FixedLengthStream` with
backpressure. Verification is bounded to 100 MiB per object. This does not widen
the original buffered upload adapter's capability. A source error, destination
error or lost provider acknowledgement never causes an automatic second PUT or
DELETE. Retrying an operation ID reads its saved receipt. Explicit reconciliation
requalifies the unchanged current occurrence, reads both source and recorded
candidate completely, and fences the verification epoch before publication.
Unrelated writes can advance the epoch without permanently stranding a candidate;
a changed source occurrence still cannot inherit its old result.

Legacy-visible source holds and location holds survive lease expiry. They fence
old GC and new location GC in both acquisition orders, using an exact locator
and admitted storage profile. An uncertain write is never treated as absent
because a lease expired. Holds protect against application GC; they do not lock
provider versions or prevent external changes to provider objects. An explicit cancel command releases holds only when
durable evidence proves no PUT started. A possibly started write requires
reconciliation; stale-source outcomes remain retained for operator inspection.

Unknown namespace, source bytes, purpose or derivation are not guessed. An
operator may record an `admitted_unresolved` decision with a reason for the
current generation. This is a cutover blocker, not a successful conversion.
In particular, a preview locator alone does not prove derivation lineage.

## Operator protocol

These routes inherit the application's existing authentication and same-origin
mutation checks. They are administrative APIs, not a new public Settings UI.
There is no automatic shadow Cron or deployment-time provider work.

| Route under `/api/files/shadow` | Purpose |
| --- | --- |
| `GET /status` | Mode, epoch, execution gate and current outcome counts |
| `GET /consumers?limit=20&after=...` | Bounded current-generation work discovery |
| `POST /baseline` | One exact consumer's current metadata fingerprint |
| `POST /enable`, `/disable` | Explicit local execution incarnation and pause |
| `POST /profiles/enable` | Admit one exact recorded destination profile |
| `POST /convert` | Accept a new operation and perform its single owned write |
| `POST /operation` | Read the actor's saved receipt after a lost response |
| `POST /reconcile` | Verify an uncertain recorded candidate without another PUT |
| `POST /cancel` | Abandon an operation proven never to have started PUT |
| `POST /admit-unresolved` | Record an explicit unresolved current generation |
| `POST /checkpoint`, `GET /checkpoints/:requestId` | Save and inspect a fenced graph count |

Mutation JSON is bounded to 80 KiB; operation/request/runtime IDs use UUIDv4.
Historical consumer keys and profile IDs retain their own contracts. Keys and
cursors are bounded to 64 KiB. Discovery pages hold at most 20 records and 512 KiB;
baselines are also bounded to 512 KiB. Each evidence collection admits at most
100 rows; source limits are 20,000 rows and 8 MiB of source-key metadata.
The exact reviewed schema fingerprint admits at most 1,000 objects and 2 MiB. Arbitrary source action
JSON and provider errors are not returned as diagnostic data.

Enable overlap, enable the exact destination profile, then read a fresh baseline.
Use a fresh operation ID only for genuinely new work. Pause blocks new guarded execution and publication; an already authorized
in-flight provider call can still finish and requires the existing holds and
reconciliation protocol. Re-enabling uses a new incarnation. A previously used incarnation
cannot be recycled. Recovery always starts paused, even when the archive records
an overlap installation and unfinished attempts.

A checkpoint recomputes the complete current graph in its epoch-fenced
transaction. Resolved counts require the decision's exact active, usable location.
It is evidence at one epoch, not authority activation or a promise that later
legacy writes cannot add work. Future cutover still must fence old Writers and
atomically switch reads, writes, retention, quarantine, deletion and recovery.

## V15 backup and recovery

V7–V14 contracts remain frozen. V15 preserves shadow occurrences, closures,
heads, dependency revisions, operation/attempt/decision history, exact holds,
legacy deletion claims, reconciliation evidence and checkpoints alongside existing business and acceptance history. The local
execution gate and local incarnation history are deliberately non-portable.
Isolated restore reconstructs them disabled, without replaying provider I/O.

The `provenance/source-rowids.json` artifact records signed 64-bit source rowids
in each exported table's stable row order, bound to a digest of that logical row.
Restore inserts these exact rowids and verifies current head/source projections.
This prevents a logically identical table restore from inventing an occurrence
replacement. Historical archives apply the new suffix after restoring their own
admitted schema and then capture their restored source generations.

File-location bytes are enumerated by `(storage profile, revision, object key)`;
they cannot alias equal legacy keys or keys in another profile. Available entries
use the authenticated `/api/exports/file-locations/:locationId` route with exact
profile and revision qualifiers. Pending, quarantined or otherwise unavailable
candidates retain metadata and a warning rather than being presented as complete
bytes. ZIP packaging verifies size and hash for each downloaded entry.

Deployment remains migration-first. A post-0008 database requires the V15 Worker
for a complete export; a stale V14 page must refresh. If migration succeeds but
Worker deployment fails, finish deployment of the reviewed V15 Worker and verify
V15 export plus stale-version rejection. Do not downgrade the schema or relabel a
V15 archive. Neither this PR nor restore authorizes remote deployment or cleanup.

## Qualification boundary

The accompanying suites cover host SQLite and native workerd/D1/R2, all 13 legacy
slots, replacement and ABA, exact-profile GC races, owned copying, lost-response
reconciliation, strict HTTP boundaries and populated archive/restore. Executed
results and the exact commit are recorded in the PR after the final gate.
Live SWITCHdrive authentication and the disposable Project upload/cleanup remain
as recorded in the [FP1k acceptance appendix](./FP1_FILE_AUTHORITY_TRANSITION.md).
Those operational gaps are not converted into successful production acceptance.
