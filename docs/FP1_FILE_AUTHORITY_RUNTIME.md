# FP1 File runtime integration

Status: draft #236, based on deployed #235. This implementation does not activate
File authority or change D1/R2 bindings. The production catch-up observation was
4 current, 4 resolved and zero pending, admitted-unresolved or unfinished attempts.

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

## Archive and deployment boundary

V18 (`fp1-file-runtime`) pins the `0012` schema and preserves accepted candidates,
publications, typed bindings and client-preview provenance. Earlier V15–V17
profiles and fingerprints remain frozen; V7–V17 can upgrade during isolated
recovery. Deployment-only cleanup `0011` is still excluded from historical
restore. Recovery performs no provider I/O and leaves shadow execution paused;
preserving an archived active mode does not by itself authorize a recovered
installation to start accepting writes.

The draft is not an activation release. Its tests simulate active mode only in
isolated databases while retaining the real publication and business guards.
The installed control guard still rejects overlap-to-active changes. Activation
must include a fresh cutoff, usable typed bindings, completed legacy writers and
drained legacy deleting claims; a prior zero-pending observation is insufficient.
Remaining recovery and compatibility paths must be covered before this guard
is opened. In particular, existing business deletion routes that clear asset
locators need an active-mode tombstone/restore path preserving immutable File
bindings, and import recovery must preserve the new candidate ownership.
R2 role defaults follow that switch; configurable S3 remains later work.

The already accepted live V17 ZIP is not repeatedly rechecked during this draft.
V18 has focused schema/metadata and byte round-trip tests. Its actual deployment
will require the one relevant acceptance for the new archive generation.
