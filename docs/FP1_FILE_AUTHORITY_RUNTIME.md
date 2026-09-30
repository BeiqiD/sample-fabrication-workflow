# FP1 File runtime integration

Status: merged and deployed in #236, integration commit `3a3877f7`, based on
deployed #235. File authority was explicitly activated on 2026-09-30 after
operator authorization. The deployed maintenance page confirmed Active,
execution Enabled and 4 resolved / 4 current references. D1/R2 bindings were
preserved. R2 original-file defaults are the next separate implementation slice.

## Runtime work

Active reads resolve a typed File and its usable publication through the exact
recorded profile. Legacy and overlap retain their existing read behavior. Old
asset URLs remain compatibility identifiers; they do not choose the provider
location once File authority is active.

R2 uploads, metrology references, Comment items and import files use their
existing accepted request and execution ownership. Each writer stages a durable
File/location candidate before provider I/O, writes once and verifies the full
destination. File publication, candidate result, compatibility records and the
original receipt completion commit with the applicable typed business bindings.
An uncertain acknowledgement is reconciled from the original receipt; replay
does not issue another PUT. Import metadata remains private until its original
finalization transaction commits all File results and business bindings.

Reuse requires matching purpose, scope, profile, hash and size, plus a complete
read of the selected reusable bytes. Old global-SHA asset uniqueness is retained
in legacy/overlap. Migration `0012` allows only exact accepted-candidate aliases
to represent separate active Files with equal bytes. Assets and managed objects
continue to serve the existing API without becoming File identity authorities.

Client-uploaded Comment previews verify their own bytes. Their related original
is a client declaration, not proof of a server-generated derivation. The active
Comment binding exception is limited to its exact accepted candidate; it does
not create verified derivation records or admit a trusted derivative cache.
These preview uploads do not use general File deduplication.

Active maintenance uses File location identities and persisted profiles. It
retains the existing registration/orphan/deletion-lease intervals and deletion
attempt fencing. Legacy deletion cannot acquire a new claim after activation.
Retained references, holds and quarantine continue to protect their locations.
After registration grace, terminal receipts can release unpublished candidates;
unretained ready Files retire before the existing orphan grace starts. Expired
but still pending requests and missing receipts remain retained.

Business deletion changes visibility while preserving immutable File bindings
and compatibility aliases. Restoring an attachment checks that exact File's
usable publication in the restoration transaction. Project copies, Template
clones and Sample state copies retain their typed identities; active availability
comes from the File instead of the old physical locator. Tombstoned event images
and previews remain hidden in API responses.
Explicit event/evidence removal releases its retention edges; durable Comment,
Project and metrology trash keeps its existing retention policy. Shadow and
accepted-receipt holds remain part of the shared retention surface.

Active import recovery terminalizes the original accepted operation and
quarantines its private template metadata. It performs no provider I/O, global
hash replacement or alias transfer. A finalization that already committed keeps
its original result; unpublished candidates remain until ordinary File GC grace.

## Activation and installation admission

The operator-only authority endpoint captures a fresh shadow checkpoint and
switches authority in one database transaction. Its native guards require the
complete current occurrence set to have usable resolved Files, unchanged source
generations, no unfinished writers/recovery or candidates, paused shadow
conversions and no deleting legacy claims. Unexpired legacy upload receipts
must already have an exact usable conversion before switching. Within one D1
batch, the checkpoint authorizes typed binding staging while authority remains
overlap; the final guarded mode change enables local File execution. A failed binding or stale cutoff rolls back the
checkpoint and the complete switch. Replaying the same request reads its result.

Installation execution permission is separate from archived authority. New
candidate publication and File GC capture and recheck the local incarnation;
an older executor cannot commit through a later admission. Authenticated reads
and export remain available when execution is paused. Recovered installations
require explicit operator admission after stopping the previous installation;
restoring an archive never authorizes writes or cleanup by itself.

The operator maintenance page is available at `/maintenance/file-authority`,
linked from Storage Settings. It displays the current authority, execution state
and activation blockers. Commands use the displayed cutoff and the server's
atomic admission; refreshing or reopening the page never sends a command.
An uncertain response is followed by a status read. Recovery admission requires
confirmation that the previous installation has stopped writes and maintenance.

## Archive and deployment boundary

V18 (`fp1-file-runtime`) pins the `0012` schema and preserves accepted candidates,
publications, typed bindings and client-preview provenance. Earlier V15–V17
profiles and fingerprints remain frozen; V7–V17 can upgrade during isolated
recovery. Deployment-only cleanup `0011` is still excluded from historical
restore. Recovery performs no provider I/O and leaves shadow execution paused;
preserving an archived active mode does not by itself authorize a recovered
installation to start accepting writes. Both installation execution guards are
rebuilt disabled and excluded from canonical archive tables.

Deploying this migration leaves the current mode unchanged. Activation remains
a separate operator operation after required CI and deployment acceptance;
the earlier zero-pending observation is not its cutoff. R2 original-file role
defaults follow that switch; configurable S3 remains later work.

The deployed V18 ZIP passed its single isolated recovery acceptance on
2026-09-29: 13/13 packaged files, zero warnings, equal canonical rows/schema,
valid foreign keys and SQLite integrity. Recovery remained execution-disabled.
Neither this archive nor the earlier accepted V17 ZIP is repeatedly rechecked
for routine changes. A successor archive generation qualifies its own changed
schema and byte semantics.
