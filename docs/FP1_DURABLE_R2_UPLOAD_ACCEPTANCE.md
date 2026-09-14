# FP1h: durable acceptance for ordinary and Project uploads

Implementation base: `9225237` (merged PR #214). Final review, check results,
deployed commit and browser acceptance belong in the implementation PR.

FP1g made historical file consumers explicit. FP1h adds durable upload acceptance
to the ordinary image and Project attachment writers, a prerequisite for their
later File publication transition. A repeated request now refers to one accepted
upload instead of creating another provider execution after a lost response.

## Request identity and byte ownership

`POST /assets` and `POST /project-assets` require `X-Upload-Request-Id`, a stable
UUID v4. Missing identity is a reload-required protocol failure before storage
I/O. Both bodies remain bounded to 10 MiB. The Worker hashes the actual submitted
bytes and binds their hash/size, filename, MIME, ingress, system scope and purpose
in canonical input. Ordinary images use `embedded_content`; unchanged Project
uploads use `research_source`. Clients do not choose an arbitrary purpose.
Ordinary uploads use URI-encoded `X-Filename-Uri` so Unicode names remain intact;
that header takes precedence over the legacy ASCII `X-Filename` fallback.

The new `r2_upload_requests` ledger records the authenticated actor, client
request ID, immutable input digest and JSON, a random execution owner, fixed
candidate asset/key, captured R2 profile/revisions and eventual result. Acceptance
is reconciled on the primary database before either byte reuse or a provider
write. Only the new owner can execute. Same-ID/different-input requests conflict;
duplicates observe the existing operation and never acquire its execution owner.

Accepted identity, placement and terminal result are immutable, including SQLite
replacement writes with recursive triggers disabled. Publication requires a ready
asset with matching expected hash/size/key and no conflicting GC or quarantine.
An uncertain database acknowledgement is reconciled by reading the same operation.
An uncertain provider outcome never authorizes another PUT under the same request.

The recorded namespace is the existing FP1f physical R2 bootstrap identity.
Retries inspect accepted history before current configuration. A changed namespace
cannot redirect the old request to another bucket. Current global-SHA legacy reuse
remains: capturing purpose does not introduce purpose-specific physical placement
or change the existing uniqueness guards.

## Replay and retention

`GET /r2-upload-requests/:requestId` is actor-bound and `no-store`. It distinguishes
pending, ready, failed, expired and unavailable outcomes. A ready POST preserves
the existing `{id, key, deduplicated}` result shape; a pending duplicate returns
the request state without repeating storage work.

The replay window is fixed at 24 hours from acceptance. Requests do not renew it.
Expired requests cannot execute or replay a usable key. A collected or quarantined
result becomes unavailable even within the window. The immutable successful
receipt remains historical evidence; it is not proof of present byte availability.
Failed or uncertain operations are not automatically restarted under a new ID.

This ledger adds no asset foreign key or retention root. Unattached candidates
continue through existing registration, quarantine and GC rules; a saved receipt
cannot keep them indefinitely or resurrect them. Consuming business writes still
perform their existing live asset, ownership and lifecycle checks.

## Browser retry boundary

The browser retains prepared upload bytes and the request UUID for one operation.
Ordinary-image retries preserve the compressed file instead of recompressing it
into a different request. Project upload recovery keeps the upload decision
separate from its existing exact card-placement retry.

A bounded session checkpoint stores request identity and file metadata/hash before
POST, without file bytes. After an uncertain response, status is checked first.
A confirmed 404 permits sending the same request ID; it never silently allocates
a replacement. Reselecting bytes after reload must match the checkpoint. Pending
or terminal states are visible to the user instead of triggering an automatic
upload loop. This qualifies upload recovery; it does not promise that every
downstream Template/Project business mutation resumes after a page reload.
An explicit discard action abandons the local upload decision and permits a new
selection. It does not cancel an already running server operation; its unattached
candidate remains subject to normal lifecycle rules. Navigation alone does not
discard the checkpoint.

## Schema, export and recovery

Forward migration `0004_r2_upload_acceptance.sql` adds the request ledger without
rewriting existing business rows, baseline SQL, File dormant guards or retention.
The current complete export negotiates schema **11**, writer **1**, profile
`fp1-r2-upload-acceptance`. Ledger identity, canonical input, captured profile and
historical results are validated and preserved during isolated restore. Recovery
does not automatically execute pending historical requests.

Qualified V7–V10 readers remain specific to their historical schemas. V10
snapshots stay frozen; the FP1g planning CLI accepts complete V10 and V11 inputs.
V11 includes captured upload evidence in its fingerprint and namespace inventory,
without changing `executable: false` or `bytesVerified: false`. An old export tab
must reload rather than silently omit new authority history.

Rollback requires the matching data/export protocol; deploying an older binary
alone cannot preserve this contract once accepted requests exist. No reset,
storage rebinding, credential change or Cron release belongs to this slice.

Migration SQL must retain the established D1-compatible spacing around CASE
endings: `END )` within CHECK expressions and `END ;` for inline trigger CASE
expressions, with a separate terminal `END;` for each trigger. The first FP1h
deployment passed every local check but remote D1 rejected migration 0004 with
`incomplete input`. Its original formatting also made the installed Wrangler
splitter combine all five definitions into one statement. The whitespace-only
correction preserves normalized SQL and the existing archive schema. A regression
now verifies five definitions, six statements with Wrangler's tracking INSERT,
all four guards and the ledger through individual SQLite prepared statements.
Local parsing does not substitute for the remote deployment result.

## Qualification and remaining authority work

Qualification covers actor isolation, altered inputs, concurrent first requests,
lost database and HTTP acknowledgements, namespace changes, expiry, GC/quarantine,
exact frontend retries and non-empty migration/export/restore. Native fixtures
exercise real workerd/D1/R2 with controlled faults. PR evidence distinguishes these
from production browser acceptance. Mandatory archive regressions remain; ZIP
specialist and browser ZIP testing remain deferred at the owner's request.

[FP1i](./FP1_METROLOGY_REFERENCE_ACCEPTANCE.md) subsequently adds metrology's
complete accepted reference publication. Comment still requires its own complete
acceptance and publication treatment. The combined File transition must also change typed
consumer foreign keys, unresolved-purpose admission, purpose/scope/profile reuse,
verified independent placement, authorized reads, retention/deletion fencing and
recovery together. FP1a stays dormant until that transition is qualified. R2 defaults
for new originals and authenticated storage Settings follow full conversion.
