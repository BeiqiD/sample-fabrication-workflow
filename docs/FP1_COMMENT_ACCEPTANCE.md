# FP1j: durable Comment acceptance and publication

Implementation base: `13c5f8f` (merged PR #218), 2026-09-14. The implementation
PR records the reviewed commit, verification, deployment and browser evidence.

Comment already has a canonical submission, ordered items and Sample/Run-step
targets. FP1j preserves those identities and strengthens the existing two-stage
upload workflow. Auxiliary acceptance history is not a second Comment model.

## Accepted input and placement

New submissions negotiate `comment-submission/1`. Before creation the browser
freezes the body, complete target identities and expected revisions, ordered
items, original/preview relationships, file metadata and SHA-256 of every actual
upload body. An image hash describes the prepared image bytes; an original-file
hash describes the unchanged File. Declared hashes remain claims until the
Worker and storage adapter verify the bytes.

The authenticated actor and original submission ID identify one accepted
operation. Reusing that ID with different immutable input is a conflict. The
historical request is looked up before checking current provider availability
or resolving a new destination. No retry consults a new default or generates
a replacement candidate behind the same operation.

Acceptance captures the current physical profile and a candidate identity/key
for each binary item. Independent images retain `embedded_content` purpose,
paired previews record `derived_preview`, and unchanged originals record
`research_source`. Current images still use R2 and originals still require
SWITCHdrive; there is no original-file fallback. SWITCHdrive identity captures
the normalized WebDAV account endpoint and storage root, without passwords or
authorization headers. Credentials may rotate within the same namespace;
changing the namespace cannot reinterpret accepted uploads or old locators.

The original manifest remains immutable when a user removes an item. Removal is
a separate, one-way cancellation decision for an unfinished item. Finalization
records the actual retained item set and all published target/event identities.
Expected target revisions govern acceptance. Comment finalization remains an
append: an unrelated revision change during upload does not invalidate the
accepted Comment, while missing or deleted targets still prevent publication.
An active TIFF preview still requires its unchanged original. Other paired
previews retain the existing ability to outlive removal of the optional original;
their recorded historical relationship does not create a new retention rule.

## Upload ownership and uncertain outcomes

Each pending binary item can acquire one execution owner. Its first owner uses
the accepted candidate and profile. Duplicate requests and lost acknowledgements
are reconciled with authoritative database reads, including acknowledgement loss
at acceptance, item publication and finalization.

A claimed upload with an unknown outcome is observed rather than re-executed.
Neither a browser retry, failure report, process restart nor abandoned-upload
maintenance grants another provider PUT. Explicit cancellation fences that
owner, and late completion cannot revive the submission or an individually
removed item. Cancellation schedules ordinary orphan consideration; it does not
delete bytes synchronously or discard a candidate whose provider write is
uncertain.

The Comment window remains **seven days**, fixed from acceptance. Status reads,
retries and failure reports cannot extend it. Upload and finalization check the
deadline directly; they do not wait for scheduled maintenance to close it. The
separate 24-hour abandoned-upload heuristic is not the accepted-operation window.

Processed images retain the 5 MiB limit. Unchanged originals retain the 100 MiB
streaming limit. Full source/destination hash and byte-size verification remains
inside the existing ingestion boundary. Client-generated previews remain scoped
to this Comment; they never establish trusted shared-derivative provenance.

## Atomic publication and lifecycle

Item publication checks the exact owner, original candidate/profile, verified
blob identity, current submission/item cancellation state, deadline, target
lifecycle and GC/quarantine constraints. A zero-row guarded receipt update cannot
leave a partially attached item.

Finalization publishes the canonical ready state, retained items, all Run-step
occurrences, audit events, target updates and immutable result together. SQL
checks the full item set and required original/preview relationships at the
publication boundary. An empty body with no retained items cannot be finalized.
It also checks every target and the exact expected
occurrence/event set. A failed guard or silently ignored statement rolls the
whole batch back. Provider I/O stays outside the transaction.

Successful replay reads the original result even after the unfinished-upload
window ends. It cannot restore a later-deleted Comment, item or target, republish a superseded occurrence, or treat missing or
quarantined bytes as healthy. Ordinary ready-Comment and attachment Delete and
Restore keep their existing explicit lifecycle operations and identities.
Receipt history adds no asset/occurrence retention root and does not extend
registration grace or GC retention.

## Browser recovery and older clients

The browser keeps bounded metadata checkpoints by submission UUID, including
the frozen target revisions and byte hashes. File bytes stay in memory; after
reload the user can reselect a file and its actual upload hash must match before
any eligible first upload. Ready items are never uploaded again. Status is
checked before retrying an uncertain create, upload, finalization or cancellation.

A successful operation remains checkpointed until the published Comment is
refreshed successfully. A failed refresh cannot become a fresh submission.
Source changes and unmounts fence old asynchronous callbacks and queued uploads;
changing the current target selection does not rewrite an accepted operation.
If cancellation cannot be confirmed, an explicit local discard can release the
browser's tracking and files. It warns that an earlier request may still finish;
it is not server cancellation or permission to replay the old request. A later
new submission is a separate user decision with a fresh UUID.

Old clients must reload before creating new accepted submissions. Existing ready
and soft-deleted Comments remain readable and retain their deletion/restoration
contract. An unfinished historical submission without acceptance history cannot
be upgraded by inventing hashes, placement or execution ownership. It can be
cancelled and explicitly submitted as a new operation through the current client.

## Schema, recovery and remaining work

Forward migration `0006` adds the acceptance history while preserving canonical
Comment tables and existing data. Wrangler-split statements and their appended
migration tracking statement are qualified individually, including on a populated
database. The baseline and historical SQL remain unchanged.

Current full export uses schema **13**, writer **1**, profile
`fp1-comment-acceptance`. V7–V12 readers remain frozen. Historical receipts are
validated without requiring their original occurrences or provider bytes to
remain available. Isolated restoration never starts pending uploads or cleanup.
The read-only File migration planner accepts complete V10–V13 snapshots and
includes the new operation/profile evidence without executing conversion.

Qualification covers immutable-input conflicts, concurrent owners, lost
acknowledgements, provider changes, cancellation/expiry races, complete multi-target
rollback, preview trust, populated upgrade and isolated recovery. Native WebDAV
fixtures qualify adapter behavior; actual SWITCHdrive read/write acceptance is
reported separately and requires working production credentials.

Production browser acceptance covers the available Comment image/link paths,
refresh, file access and lifecycle actions. ZIP-specific/browser ZIP acceptance
remains deferred at the owner's request; required archive regressions remain.

The next File authority transition must convert consumers, purpose-aware reuse,
independently verified placement, authorized resolution, retention/deletion
fencing and recovery together. R2 original defaults and authenticated storage
Settings follow that conversion. FP1j does not activate dormant File guards,
reset databases, rebind storage, change credentials or release Cron controls.
