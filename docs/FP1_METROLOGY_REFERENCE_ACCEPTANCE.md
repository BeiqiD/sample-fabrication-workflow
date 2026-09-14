# FP1i: durable metrology reference acceptance and publication

Implementation base: `c4b2ff6` (merged PR #217). The implementation PR records
the reviewed commit, final checks, deployment and browser acceptance.

FP1h records accepted byte uploads. A metrology reference upload also publishes
a stable business occurrence, so it needs its own accepted operation. A lost
response must not publish another reference or restore one deleted after the
original operation completed.

## Request and publication identity

`POST /metrology-templates/:id/references` retains the raw-file upload and its
1-byte to 25-MiB bound. It requires `X-Upload-Request-Id` (UUID v4), accepts
Unicode through `X-Filename-Uri`, and hashes the actual bounded body. Missing
request identity requires an old application tab to reload before uploading.

The independent `metrology_reference_upload_requests` ledger binds actor and
request UUID to the Template ID, exact filename/MIME/hash/size, `research_source`
purpose, system scope, frozen R2 namespace/profile revisions, one execution owner
and fixed candidate identities. Reusing a UUID with different input or another
Template conflicts. Purpose capture describes new uploads kept as supplied;
historical metrology references remain unresolved in the File conversion plan.
Legacy global-SHA reuse continues and does not become Template-local File scope.

Before provider work, acceptance freezes a publication plan. It identifies a new
reference, an existing active reference, or the exact deleted occurrence to
restore. The latter retains the existing upload-to-restore behavior: only the
first owner may restore that recorded occurrence, conditional on its unchanged
asset, presentation, ordering, author and deletion snapshot. Superseded
occurrences are not upload restoration targets.

After complete byte verification, one D1 batch publishes the occurrence and its
immutable successful receipt. The batch checks current Template publication and
active lifecycle, exact occurrence state, ready asset/hash/size/key, and absence
of conflicting GC or quarantine. A failed condition rolls back publication,
including a zero-row receipt update. Concurrent first uploads of the same bytes
may converge on the same active occurrence; a deleted winner is not silently
revived by a different pending creation plan.

Database acknowledgement loss is reconciled through the same primary request
record. Only the newly accepted owner may perform provider work. Pending or
uncertain requests do not acquire another execution owner or automatically PUT
again. Known failure remains terminal for that UUID.

## Replay and browser recovery

`GET /metrology-templates/:id/reference-upload-requests/:requestId` is actor- and
Template-bound and returns `no-store` state. POST responses carry the same
request state, with the existing reference DTO when ready. The result freezes
the original reference identity and presentation; shared-asset MIME and size are
taken from the verified winning asset rather than silently changing its metadata.

The fixed replay window is 24 hours from acceptance. Ready replay validates the
captured namespace, complete bytes and current Template/occurrence/blob lifecycle.
Deletion, supersession, expiry or unavailable bytes cannot authorize another
publication. A saved successful receipt is historical evidence, not a retention
root or permission to restore an occurrence. Requests add no asset or occurrence
foreign key and do not extend registration grace or GC retention.

The browser stores one bounded session checkpoint per Template before POST,
containing the request UUID and input metadata/hash, without file bytes. A page
reload can check the original operation; reselected bytes must match before a
same-ID retry. Status is checked before retrying an uncertain POST. A confirmed
404 permits that original POST only if success was never acknowledged.

An acknowledged upload remains checkpointed until the refreshed Template is
displayed successfully. A failed page refresh therefore cannot turn a completed
publication into a fresh upload. Explicit discard permits a new local decision;
it does not cancel a server operation already accepted. Source navigation guards
prevent an old operation from refreshing or clearing another Template's state.

## Schema and recovery

Forward migration `0005_metrology_reference_acceptance.sql` adds the business
receipt ledger. It preserves the deployed baseline, existing upload/import
receipts, File dormant guards, storage bindings and retention rules. The SQL
retains D1-compatible CASE spacing and is qualified by individual Wrangler-split
prepared statements, including the appended migration tracking statement.

Current full export negotiates schema **12**, writer **1**, profile
`fp1-metrology-reference-acceptance`. V7–V11 readers remain frozen to their
historical schemas. Restore validates receipt identity, canonical input, frozen
publication plan/profile and historical result without requiring that the
original reference still be active or its bytes still be retained. Restored
pending operations do not execute automatically.

The read-only File migration planner accepts V10, V11 and V12 complete snapshots.
V12 includes the new history in its fingerprint and namespace evidence; reports
remain `executable: false` and `bytesVerified: false`.

## Qualification and remaining work

Required evidence covers changed input/Template/actor, concurrent equal-byte
requests, lost acceptance/provider/publication/HTTP acknowledgement, lifecycle
changes during upload, CAS restoration, GC/quarantine, expiry, bounded Unicode
uploads, page reload and source navigation. Populated host SQLite and real
workerd/D1/R2 fixtures verify forward migration and isolated V12 recovery.

Production acceptance covers a new reference upload, page reload, byte access
and reference deletion/restoration behavior. ZIP-specific and browser ZIP testing
remain deferred at the owner's request; mandatory archive regressions remain.

Comment still needs its complete original/preview, provider, cancellation and
multi-target publication protocol. Only after all writers are qualified can the
combined File transition change consumer foreign keys, purpose-aware reuse,
verified independent placement, authorized resolution, retention/deletion fencing
and recovery together. R2 defaults and authenticated storage Settings follow that
transition. This slice does not release dormant guards, reset a database, rebind
storage, change credentials or release Cron controls.
