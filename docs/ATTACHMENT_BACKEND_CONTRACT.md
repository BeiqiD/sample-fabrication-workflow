# Shared attachment backend and domain-lifecycle contract

Status: active architecture contract; Slices A/B are complete in PRs #152/#153 and occurrence-metadata Slice C is active in Draft PR #154

Last reviewed: 2026-08-19 after PR #153 merged shared ingestion and Draft PR #154 began occurrence-metadata Slice C

This document defines the intended boundary between shared file ingestion,
physical blob storage, attachment occurrences, domain ownership, derivatives,
retention, and garbage collection. It applies to Project attachments, canonical
Comment items, direct Run-step attachments, execution images, and future
blob-bearing application records.

The existing physical-byte safety rules remain defined in
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md). Current Project
ownership and interaction are defined in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md) and
[Project Canvas interaction contract](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).
Concrete post-Phase-4C sequencing is recorded in
[shared attachment backend implementation plan](./ATTACHMENT_BACKEND_IMPLEMENTATION_PLAN.md).

Slice A in PR #152 established bounded attachment lifecycle behavior, and Slice B
in PR #153 consolidated verified ingestion/registration behind shared internal
services. Slice C in Draft PR #154 separates contextual occurrence presentation
from physical blob registration provenance without changing retention semantics.
Later derivative and transport slices remain proposed. Every implementation that
changes retention behavior MUST update the blob lifecycle contract and its
executable tests in the same reviewed change.

## Goal

The application SHOULD use one attachment/blob ingestion and derivative backend
without pretending that every attachment has the same owner or lifecycle.

The intended model is:

```text
physical blob and provider state
            ↑
attachment occurrence or binding
            ↑
domain owner and domain lifecycle
```

The shared backend owns bytes, integrity, deduplication, provider selection,
derivatives, and global reachability. Project, Comment, Run, and other domain
services continue to own the meaning of an attachment occurrence and the effect
of removing it.

## Normative language

`MUST`, `MUST NOT`, `SHOULD`, and `MAY` are used in their ordinary architecture
sense. Table, module, and route names may evolve, but an implementation may not
weaken these ownership and lifecycle boundaries without a new design review.

## Terms

A **blob** is one immutable byte sequence addressed through provider-neutral
metadata. A blob may currently be represented by `assets` or
`managed_storage_objects`; this contract does not require an immediate table
collapse. Existing `original_name` and `mime_type` fields on those provider
records are registration provenance/compatibility metadata, not authoritative
user-facing presentation for every occurrence that reuses the bytes.

A **blob locator** identifies physical bytes by store kind, provider, and object
key. A physical locator is internal infrastructure and MUST NOT become a client-
supplied attachment identity.

An **ingestion session** is a bounded upload state machine that validates
metadata, receives bytes, verifies size and hash, registers or adopts a verified
winner, and returns a provider-neutral blob handle.

An **attachment occurrence** is a stable domain relationship that presents one
blob in one context. The occurrence owns contextual metadata such as display
name, title, caption, role, ordering, and lifecycle.

An **owner** is the domain aggregate whose semantics control the occurrence.
Examples are a Project item, a canonical Comment submission, or a Run step.

A **derivative** is a rebuildable preview or representation generated from an
original blob, such as an image thumbnail, TIFF preview, or future PDF first-
page preview. A derivative is not the authoritative original.

A **retention edge** is one effective reason the shared blob lifecycle must keep
the bytes recoverable.

## Core invariants

1. Blob identity and attachment-occurrence identity MUST remain separate.
2. Domain owners own meaning and deletion semantics; the shared ingestion layer
   MUST NOT delete or hide an owner.
3. Removing one attachment occurrence MUST NOT implicitly remove another
   occurrence that reuses the same blob.
4. Removing a Comment attachment MUST NOT delete, hide, truncate, or rewrite the
   Comment body or its Timeline/audit text.
5. Removing a direct Run-step attachment MUST NOT delete the Run, the Run step,
   the execution record, or historical Timeline text.
6. A Project attachment is standalone Project-owned content. Removing it means
   removing that Project item occurrence, not merely hiding one child field.
7. Parent Trash and explicit child-attachment removal are different operations
   and MAY have different byte-retention periods.
8. Ordinary domain requests MUST NOT delete provider bytes directly. They change
   occurrence state and retention edges; global blob GC performs physical
   deletion only after authoritative reachability checks.
9. A blob remains protected while any effective retention edge exists,
   regardless of how many other occurrences were deleted.
10. The same bytes MAY appear with different filenames, captions, titles, MIME
    presentation, or domain roles. Those contextual values MUST NOT force a
    second physical copy.
11. Filename and MIME metadata attached to one occurrence MUST NOT silently
    rewrite another occurrence or the global identity of a deduplicated blob.
12. Upload retry must reuse the same frozen ingestion identity, declared size,
    expected hash when present, and operation identity.
13. A failed domain binding after successful ingestion creates an orphan
    candidate, not an untracked provider object.
14. Derivatives MUST be linked to their source blob and generator version, and
    MUST be safe to rebuild or discard.
15. Unsupported file formats remain ordinary files. Shared ingestion MUST NOT
    become a general scientific-data parser.
16. Complete export MUST preserve domain occurrences, contextual metadata,
    lifecycle state, blob metadata, and derivative relationships without
    exposing private provider credentials or physical locators as product IDs.
17. Restore MUST reconstruct the domain occurrence while its retention policy
    still promises recoverability. A UI MUST NOT offer restore after bytes have
    legitimately left the recoverable window unless the occurrence can be
    restored as metadata-only with explicit wording.
18. All new blob-bearing domains MUST extend the shared reachability, export,
    integrity, and lifecycle test matrix before deployment.

## Shared backend boundary

The shared backend SHOULD expose internal operations equivalent to:

```text
createIngestionSession
uploadOrRegisterBlob
completeIngestionSession
readBlobMetadata
createOrReadDerivative
listAttachmentBlobLocators
releaseOccurrenceRetention
markOrphanCandidate
claimBlobDeletion
```

Names and transport may differ. The important rule is that storage and
integrity logic are shared while domain mutation remains outside this layer.

The shared backend owns:

- validated byte size and cryptographic hash;
- provider-neutral blob identity;
- R2 or managed-storage selection;
- provider write and registration reconciliation;
- content-addressed winner adoption;
- integrity quarantine and ordinary media reads;
- derivative generation and reuse;
- global retention-edge evaluation and GC state.

It does not own:

- Project item placement, Reading order, or Project revisions;
- Comment text, submission targets, or Comment publication state;
- Run-step status, execution history, or Sample structure;
- Timeline wording and audit policy;
- domain-specific Trash, restore, or permanent-purge eligibility.

## Domain ownership matrix

| Domain surface | Occurrence meaning | Owner-removal behavior | Attachment-removal behavior |
|---|---|---|---|
| Project attachment | Standalone Project-owned content and Map/Reading item | Project Trash keeps the complete aggregate recoverable | Soft-delete the Project item/content occurrence |
| Comment attachment or image | Child item of a canonical Comment | Comment Trash hides the Comment aggregate but preserves it during retention | Remove only the child item; Comment body and Timeline text remain |
| Direct Run-step attachment | Evidence or execution/observation occurrence on one Run step | Run Trash hides the Run graph while preserving it for restore | Detach the occurrence, preserve step/history, and append or project audit metadata |
| Timeline attachment projection | Audit/read projection of a source occurrence | Follows the source domain | Clear active media linkage when required, but retain immutable textual audit history |
| Verification or state evidence | Evidence occurrence owned by verification/state semantics | Follows its owner contract | Requires a dedicated domain rule; never inferred from a generic file-card action |

## Project attachment rules

A Project attachment is an ordinary standalone Project content class beside
Project Markdown and Reference occurrences.

- The active occurrence owns filename presentation, caption, source URL,
  placement, z-order, Reading presence, and revision state.
- Removing the attachment MUST use the authoritative Project-item lifecycle.
- Project removal MUST NOT modify a source record merely because the same blob
  is referenced elsewhere.
- Project copy/paste MAY create a fresh Project item/content/binding while
  reusing the same verified blob.
- Moving the whole Project to Trash MUST preserve its attachment bytes for the
  same recovery window as the Project aggregate.
- The initial v1 retention target is 30 days for a trashed Project or standalone
  Project attachment.
- Permanent Project purge removes Project-owned logical records and releases
  their retention edges. Physical bytes are deleted only by global GC when no
  other source protects them.

## Comment attachment rules

A Comment attachment is not the Comment itself.

The canonical model is:

```text
Comment submission
├── body
├── attachment/image item A
└── attachment/image item B
```

Deleting item A produces:

```text
Comment submission
├── body
└── attachment/image item B
```

The operation MUST NOT:

- delete or soft-delete the canonical Comment solely because one item was
  removed;
- remove Comment text from Sample notes, Run-step notes, Project References, or
  Timeline projections;
- rewrite existing Comment text to imply the attachment never existed;
- remove item B or another Comment occurrence that shares the same blob.

The domain MAY retain small audit metadata after the original bytes become
unreachable, including original filename, declared byte size, MIME metadata,
hash, occurrence ID, deletion actor, and deletion time.

A derivative dependency remains explicit. For example, an active TIFF preview
may require its original TIFF occurrence; deleting or restoring either side
must validate that dependency without treating the whole Comment as disposable.

Deleting the entire canonical Comment is a separate operation. The proposed v1
Comment Trash window is 30 days. An explicitly deleted ready child attachment or image contributes a guaranteed
24-hour retention edge in Slice A. After expiry, restore remains best-effort
until GC claims the locator; global reachability and ordinary orphan GC decide
whether the bytes can be collected. The canonical Comment body, target
occurrences, and Timeline text remain intact.

## Direct Run-step attachment rules

A direct Run-step attachment is experimental evidence attached to an execution
context. It is not the Run step itself.

When a user explicitly deletes a mistaken Run-step attachment, the domain
service MUST:

1. identify the exact stable attachment occurrence;
2. mark or detach that occurrence through an auditable mutation;
3. remove active media linkage from Timeline projections where necessary;
4. preserve the Run, Run step, execution status, Comment text, and existing
   textual Timeline history;
5. retain compact audit metadata proving that an attachment existed and was
   removed;
6. transition the occurrence's blob protection from durable retention to a
   bounded grace edge;
7. let global blob GC classify the bytes as an ordinary orphan candidate only
   after the grace expires and no other effective edge exists. Provider deletion
   then follows the shared orphan claim and deletion grace.

The v1 explicit-removal retention edge is 24 hours and is implemented by Slice A.
This protects against an immediate mistaken click without retaining hundreds of
megabytes of known-wrong data indefinitely. Expiry releases durable reachability;
the provider object may remain somewhat longer while the ordinary global orphan
grace and two-phase deletion protocol complete.

Moving the whole Run to Trash is different. A recoverable Run Trash operation
MUST preserve the complete execution graph and its files until the Run itself is
permanently purged under a separately reviewed policy. Run-step deletion is not
introduced by this contract; future-plan removal and historical
correction/voiding remain distinct workflow semantics.

## Timeline and audit rules

Timeline is an audit/read projection, not the physical owner of attachment
bytes.

- Timeline text MAY remain indefinitely after an attachment blob is collected.
- An active event media key MAY be cleared when the source occurrence is
  deleted, quarantined, or otherwise unavailable.
- The event SHOULD retain source occurrence ID, filename, byte size, deletion
  operation ID, actor, and time where available.
- A separate `attachment removed` event MAY be appended when it improves audit
  clarity.
- Timeline retention MUST NOT keep large bytes forever merely to prove that a
  deleted attachment once existed.
- A malformed historical event MUST NOT block reachability, cleanup, export, or
  migration.

## Blob identity and occurrence metadata

The long-term model separates immutable byte facts from contextual display
facts.

Blob facts include:

```text
hash
byte size
store kind
provider registration
integrity state
created/registered timestamps
```

Occurrence facts include:

```text
display filename
user title or caption
source URL
domain role
position/order
owner identity
created/deleted actor and time
```

A server-detected media type MAY be retained as technical blob metadata, while
user-facing MIME/display classification remains occurrence metadata. The system
MUST not reject safe deduplication solely because two occurrences use different
filenames or display descriptions for identical bytes.

The first consolidation slice MAY preserve `assets` and
`managed_storage_objects` for compatibility. Provider-neutral handles can be
introduced at the TypeScript/service boundary before any table unification.

## Upload and storage selection

A domain requests ingestion; it does not select a private provider key.

The shared service chooses an allowed path based on deployment capability,
file class, size, and policy:

```text
small image or derived preview -> private R2
large durable original          -> configured managed storage
```

Exact thresholds remain deployment and implementation constants, but every
path MUST provide the same minimum guarantees:

- authenticated and same-origin write boundary;
- bounded filename and MIME metadata;
- declared-size validation;
- server-observed byte-size validation;
- cryptographic hash verification or calculation;
- provider-verified deduplication;
- staged registration before public availability;
- retry-safe operation identity;
- no provider-only orphan after a known failure;
- explicit handling of an outcome-uncertain response.

Large-file support SHOULD avoid buffering the complete object in Worker memory.
Resumable or direct-provider transfer MAY be introduced later, but it must end
at the same authoritative registration and binding boundary.

## Parsing and derivatives

Parsing is optional and derivative-oriented.

The shared backend SHOULD consolidate reusable preview generation for formats
that materially improve the product, initially:

- ordinary image thumbnails/previews;
- TIFF original plus bounded browser-safe preview;
- future PDF first-page preview after a dedicated security and resource review.

It MUST NOT automatically parse arbitrary HDF5, MAT, ZIP, CAD, simulation, or
instrument files into a new scientific data model. Unsupported formats remain
safe generic file cards.

Derivative generation MUST:

- use bounded input size, memory, expansion, and execution time;
- avoid remote network fetches from untrusted file contents;
- record source blob, derivative kind, generator version, and status;
- treat derivative bytes as rebuildable and independently collectable;
- never replace the original blob identity;
- permit reuse across Project, Comment, and Run occurrences of the same source
  blob.

## Retention policy matrix

The following target policy guides implementation. Exact constants MUST be
encoded once and covered by tests rather than copied through routes.

| Situation | Logical state | Byte-retention target |
|---|---|---|
| Active Project attachment | Active Project occurrence | Durable while active |
| Project or standalone Project attachment in Trash | Recoverable Project state | 30 days |
| Active Comment attachment | Active Comment child item | Durable while active |
| Whole Comment in Trash | Recoverable Comment aggregate | 30 days |
| Individually deleted ready Comment item | Comment remains active | 24-hour guaranteed retention edge; afterward restore is best-effort until GC claim |
| Active direct Run-step attachment | Active evidence occurrence | Durable while active |
| Individually deleted direct Run-step attachment | Audit metadata remains | 24 hours, then GC-eligible |
| Whole Run in recoverable Trash | Hidden but restorable Run graph | Retain until Run purge policy releases it |
| Derivative with active source use | Rebuildable preview | Retain while useful; may be regenerated |
| Blob with any other effective edge | Shared physical bytes | Always retain |

A parent entering Trash MUST NOT silently apply the shorter child-removal policy.
An explicit child attachment deletion MUST NOT silently inherit an indefinite
parent-history policy.

## Global GC contract

A domain mutation releases or time-bounds one occurrence edge. It does not issue
an object-store delete.

The global lifecycle then performs:

```text
recompute effective reachability
        ↓
no active or unexpired edge?
        ↓
mark orphan candidate
        ↓
grace / concurrency check
        ↓
claim exact locator and operation ID
        ↓
delete provider bytes
        ↓
finalize terminal metadata
```

Before claiming or deleting, the authoritative mutation MUST recheck
reachability. A newly created edge cancels an unclaimed orphan state. A locator
already in `deleting` or `deleted` cannot be attached to a new occurrence.

## Restore and permanent purge

Restore is domain-specific.

- Project restore restores the Project item/content/placement aggregate while
  its 30-day policy remains valid.
- Comment-item restore restores only the item and does not recreate or rewrite
  Comment text.
- Run-attachment restore is guaranteed while its 24-hour edge is active and remains
  best-effort afterward until GC claims the still-available blob.
- Run restore restores the hidden Run graph and its attachments; it is not an
  alias for restoring each attachment independently.

Permanent purge is privileged, conflict-first, and reference-aware. Purging a
Project, Comment, or Run removes owned logical records only after its domain
preconditions pass. Blob deletion remains a separate reachability decision.

## Export and portability

Complete export MUST preserve enough information to audit and restore the
application state supported by the active retention policy:

- domain owner and occurrence rows;
- deletion and restore metadata;
- blob records and provider-neutral locator metadata;
- retention edges and GC ledger state;
- derivative source relationships and generator versions;
- warnings for missing or unavailable physical bytes.

A self-hosted implementation may use local files or another object provider, but
it must preserve the same provider-neutral ingestion, occurrence ownership,
retention-edge, and GC semantics.

## Security boundary

Shared ingestion and derivative processing MUST preserve:

- authentication and same-origin write checks;
- private object storage and safe media response headers;
- filename, MIME, size, and identifier validation;
- bounded parser resources;
- no execution of uploaded scripts or macros;
- no trust in client-supplied provider keys, asset IDs, or storage locators;
- fail-closed behavior when primary metadata authority or provider verification
  is unavailable;
- integrity quarantine for definite absence or byte-size mismatch.

## Explicit non-goals

This contract does not introduce:

- a general-purpose file manager;
- one universal attachment business table that replaces every domain model;
- a WYSIWYG editor or inline attachment syntax;
- automatic scientific interpretation of arbitrary uploads;
- cross-domain deletion of owners;
- immediate physical deletion from a user request;
- real-time collaborative upload state;
- provider migration or Docker deployment in the first consolidation slice;
- public or client-controlled physical storage locators.

## Change control

Any implementation that adds a new attachment-bearing domain, changes a
retention window, permits metadata-only restore, or introduces a new derivative
class MUST update:

1. this contract;
2. the blob lifecycle contract and reachability matrix where applicable;
3. complete export coverage;
4. domain route and mounted UI tests;
5. provider-integrity and GC tests;
6. deployment and operational runbooks when remote activation changes.
