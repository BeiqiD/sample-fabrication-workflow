# FP1 shadow conversion runtime

Implementation base: PR #221, `d1698b4ec12e612cfd31b29280c8e60f4b6104d4`.
This slice adds migration `0008_fp1_shadow_runtime.sql`, explicit shadow
conversion operations and complete archive schema **15**, writer **1**, profile
`fp1-shadow-conversion`. PR #222 is merged and deployed; the latest deployment
and actual archive acceptance are recorded below. Conversion and FP1 authority
activation remain separate from deployment and recovery acceptance.

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
The matching Worker obtains exact affected-row evidence from SQL `RETURNING`
or an adjacent `SELECT changes()` in the same batch. D1 `meta.changes` also
includes trigger writes and cannot establish a business operation's row count.
Capture of old Worker SQL does not make its response or retry classification
compatible: older Workers that compare that metadata to an exact count can
misreport a committed operation as a replay or conflict.
Resolved decisions belong to one occurrence, not to a reusable business ID.
Deleting and recreating an ID cannot inherit its old decision.
Replacement capture also covers `UPDATE OR REPLACE` that takes a different
row's logical key and reuses that victim's physical rowid in the same statement.

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
The reverse GC fence uses the same namespace evidence as retention, including
upload and import receipts when no legacy mapping exists.

Unknown namespace, source bytes, purpose or derivation are not guessed. An
operator may record an `admitted_unresolved` decision with a reason for the
current generation. This is a cutover blocker, not a successful conversion.
In particular, a preview locator alone does not prove derivation lineage.

## Operator protocol

These routes inherit the application's existing authentication and same-origin
mutation checks. They are administrative APIs; the bounded maintenance page below
is an operator client of this existing boundary, not the future Settings UI.
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
V15 head and occurrence rows, and the shadow baseline, also encode physical
rowids as exact decimal text (or null for a tombstone), preserving the full
SQLite integer range without passing through JavaScript numbers.
Restore inserts these exact rowids and verifies current head/source projections.
This prevents a logically identical table restore from inventing an occurrence
replacement. Historical archives apply the new suffix after restoring their own
admitted schema and then capture their restored source generations.

Archives must preserve the source and destination holds for every attempt that
crossed the provider-write boundary. Unfinished attempts require unreleased
holds without destination expiry, even when their original source has since
been deleted. The database forbids releasing these holds before a safe terminal
state. Removing the hold
rows and rebuilding the retention projections does not make such an archive
valid. Published history may retain released holds; a staged attempt that never
started writing does not require a destination hold.

File-location bytes are enumerated by `(storage profile, revision, object key)`;
they cannot alias equal legacy keys or keys in another profile. Available entries
use the authenticated `/api/exports/file-locations/:locationId` route with exact
profile and revision qualifiers. Pending, quarantined or otherwise unavailable
candidates retain metadata and a warning rather than being presented as complete
bytes. ZIP packaging verifies size and hash for each downloaded entry.

Deployment remains migration-first: apply `0008`, then deploy the matching V15
Worker. The [trigger-compatible bridge rollout](./FP1_TRIGGER_COMPATIBLE_ROLLOUT.md)
allows this sequence without an operator-imposed business-write pause only after
the exact reviewed bridge commit and Worker version have been verified as
actually serving all application traffic on `0007`, with older Worker writers
and their in-flight work drained. A merged bridge or successful build alone does
not satisfy this prerequisite. Keep authority in `legacy` mode and the local
execution gate disabled throughout the rollout, and prevent an older queued
build or rollback from reintroducing an incompatible Worker.

With that prerequisite verified, the bridge can continue legacy business writes
after `0008`. Its complete-export snapshots that observe the new schema return
HTTP 409 until the V15 Worker is deployed; complete export resumes after V15
export and stale-version rejection have been verified. A snapshot completed
before migration remains valid. If migration succeeds but V15 deployment fails,
finish deploying the reviewed V15 Worker while keeping conversion disabled.
Verify first creation, replay, deletion/restoration, V15 export and stale-version
rejection on the completed deployment.

Without a verified active bridge, use the coordinated maintenance window: pause
business writes before applying `0008` and keep them paused until the matching
Worker with trigger-independent affected-row checks is running and those checks
have passed. Retain the write pause if Worker deployment fails. Do not downgrade
the schema, treat a V14 archive as a complete post-0008 backup, or relabel a V15
archive. These are deployment prerequisites, not evidence that the bridge has
been deployed. Neither this PR nor restore authorizes remote deployment or cleanup.

## Qualification boundary

The accompanying suites cover host SQLite and native workerd/D1/R2, all 13 legacy
slots, replacement and ABA, exact-profile GC races, owned copying, lost-response
reconciliation, strict HTTP boundaries and populated archive/restore. Executed
results and the exact commit are recorded in the PR after the final gate.
The [FP1k acceptance appendix](./FP1_FILE_AUTHORITY_TRANSITION.md) retains its
historical observations. The newer acceptance below closes its R2 upload and
non-empty recovery gaps; live SWITCHdrive authentication and disposable Project
cleanup remain open.

## Deployment and archive acceptance — 2026-09-27

The trigger-compatible bridge #223 deployed before #222 applied `0008` and
deployed V15. Follow-ups #224–#226 preserve the migration and archive contract;
#225 adds actual packaged-asset feedback and a reusable ZIP download link, and
#226 reduces qualification overhead after a confirmed Cloudflare build timeout.
Integration commit `5a86ab27d2d049057c1f6cb241a661f36f64de57` passed all 14
status contexts and both merge Actions checks. Cloudflare Build
`9f35ce6d-89a5-4bd1-ba3a-afd751fcab55` succeeded at
`2026-09-27T20:31:20Z`, Worker version
`bdfe4916-8fca-4cf8-9850-f6abd772be54`. D1 and R2 bindings were preserved.

Post-migration browser checks passed Markdown creation/edit/trash/restore/reload
and attachment upload/trash/restore/download. The operator's actual V15 ZIP,
exported at `2026-09-27T20:48:27.593Z`, passed independent archive inspection and
local S2 isolated restore: 9/9 packaged blobs, matching sizes and hashes, no
warnings, matching canonical rows/schema, zero foreign-key violations and SQLite
integrity `ok`. The 157-byte synthetic fixture matched its original upload hash.
The archive's 78 datasets / 243 rows include 11 view snapshots / 33 rows; the
67 canonical tables / 210 rows restore alongside three local/derived tables.
Every restored view matches. This closes the earlier non-empty ZIP and isolated
restore gap, not catch-up or authority activation. Full evidence is in
[PR #226](https://github.com/BeiqiD/sample-fabrication-workflow/pull/226).

Live same-operation replay and a stale archive-version request against the V15
deployment were not independently observed in the browser session. SWITCHdrive
authentication and disposable Project cleanup remain open. No remote conversion
or File authority activation was enabled. Restored runtime state is deliberately
paused and does not establish the current remote execution gate.

## Read-only V15 catch-up inspection

The V14 `inspect:file-consumers` command retains its original contract. Use the
separate V15 command on a closed SQLite backup or the isolated restored database:

```sh
npm run inspect:file-shadow -- --database CLOSED_V15.sqlite --output NEW_REPORT.json
```

This command explains the current generations in one read-only SQLite transaction.
It validates the V15 generation and source/head correspondence even for an empty
snapshot, then reuses the runtime's exact per-consumer baseline. The report
separates recorded decisions from currently usable resolutions; a formerly
resolved decision whose exact publication is unavailable remains pending with
`published_location_unusable`. Unfinished operations are counted even when their
source generation is no longer current.

The report contains typed consumer keys, generation/occurrence identity, purpose,
baseline hashes and fixed diagnostic reason codes. It omits source bytes, raw
metadata, object keys, provider namespaces, actor identities and free-text
decision reasons. Consumer IDs remain operational metadata: keep the full report
with the source snapshot and publish only aggregates in acceptance records.

Input must be a regular, closed rollback-journal SQLite file without journal,
WAL or shared-memory sidecars. The command rejects changed input, an existing
output, and output aliases of the database or its sidecars. It opens SQLite
read-only with extensions disabled and publishes a new report only after the
complete inspection succeeds. Bounds fail without publishing a partial report.
The command admits at most 1,000 present consumers and 20,000 total heads,
8 MiB of head-key metadata and an 8 MiB final report. Existing baseline limits
also apply: 20,000 physical source rows, 8 MiB of source-key metadata, 100 rows
per dependency collection and 512 KiB per baseline. Per-consumer baseline reads
repeat schema/dependency inspection; this is a bounded diagnostic for small
snapshots, not a qualified large-database catch-up runner.

`ready_to_verify` means metadata eligibility only. Every report records
`executable: false`, `providerIO: false`, `bytesVerified: false` and
`activationReady: false`. It does not authorize provider writes, resolve missing
intent/namespace evidence, change a profile, resume an operation or certify an
installation-wide activation cutoff. Before any online conversion, read a fresh
live baseline and use the existing guarded operation/hold/reconciliation protocol.
Complete current-generation catch-up and separate atomic lifecycle activation
remain the next operational and implementation gates.

Inspection of the isolated database restored from the accepted 2026-09-27 ZIP
found 11 current generations: zero resolved decisions, 4 metadata-eligible
`ready_to_verify` records and 7 ambiguous records with
`consumer_purpose_unresolved` and `namespace_evidence_missing`. There were no
unfinished attempts or pending operations. These are observations of that local
snapshot, not a live D1 baseline. Existing attachment bytes and matching hashes
do not supply the missing purpose or namespace evidence.

## Single-item R2 pilot

The Export page links to `/maintenance/file-shadow`. Opening or refreshing this
page only reads status and bounded current-consumer pages. Inspecting one consumer
reads its fresh baseline. The page renders a small review projection: exact
consumer/generation, purpose, expected size/hash and recorded R2 profile/revision;
it does not display provider keys, namespace configuration or raw source metadata.

This pilot only offers a copy into the explicitly reviewed **same recorded R2
source profile**. It does not infer a default, create a profile, edit credentials
or namespaces, or admit unresolved history. An ambiguous or non-R2 source stays
blocked. All backend baseline, namespace, byte, hold and publication checks still
apply; client eligibility never grants a provider-write capability.

The operator separately enables overlap, admits that exact existing profile for
shadow writes, reads a new baseline, and requests one conversion. Enablement
permanently advances authority mode from `legacy` to `overlap`; business reads and
writes still use their existing authority. Pausing disables new guarded execution
but does not restore `legacy` or revoke the profile's `read_write` admission. An
already authorized provider call may finish after pause. No control on this page
activates File authority, switches D1/R2 bindings or runs cleanup.

Before conversion, the client durably saves the complete immutable request and
operation ID in browser storage. Storage failure prevents submission. A browser
lock serializes journal changes across tabs. Reload, a lost response, HTTP errors
and an absent receipt retain the same request; none automatically retries a PUT
or allocates a replacement operation ID. Saved-operation inspection remains
available while paused. Every receipt action is bound to the operation displayed
by its page; a newer ticket in another tab cannot become that action's target.
Explicit reconciliation verifies the recorded candidate
under the current enabled incarnation, without a second PUT. Cancellation is only
offered for a recorded pre-write state and still requires the backend's proof
that no PUT started. Only a terminal receipt can be dismissed to start new work.
Keep the browser journal until the operation has been resolved or safely cancelled.
An absent receipt after a rejected request remains an explicit recovery limitation:
the current server protocol has no durable terminal no-claim receipt. For example,
a pre-acceptance baseline conflict may leave this browser unable to start another
pilot operation. Inspect the saved identity and server state; do not clear the
journal or invent a new ID merely because one read returned 404. A general catch-up
runner needs a separately qualified definitive-rejection recovery protocol.

Pause uses its own fresh runtime read and does not wait for the conversion journal
lock, usable storage or a pending conversion response. A failed epoch fence remains
visible and requires a fresh operator action rather than an automatic retry.

The page reuses the deployed authenticated/same-origin operator API. It does not
claim to implement FP2's administrator/secret model; future configuration and role
default mutations still require that separately reviewed server-side boundary.
There is no automatic conversion on mount, refresh, deployment or profile admission.

The initial live acceptance target is the existing 157-byte synthetic Project
attachment: inspect its current generation, execute one verified copy, read back
the saved receipt and aggregate status, then pause. Deployment and live results
must be recorded against the exact accepted commit; page implementation alone
does not establish that this pilot ran or that catch-up completed.

Further inspection of the accepted ZIP confirmed that its seven ambiguous Project
references map to five historical R2 assets without accepted upload receipts,
import provenance, legacy mappings or same-asset semantic evidence. They remain
unresolved. A future explicit evidence/adjudication ledger must be separately
reviewed and bound to the current occurrence, baseline and exact profile revision;
fabricating old receipts or choosing the only current profile is not a repair.
