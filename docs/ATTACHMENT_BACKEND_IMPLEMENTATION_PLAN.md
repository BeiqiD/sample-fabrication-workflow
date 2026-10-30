# Shared attachment backend implementation plan

Status: active implementation plan; Slices A/B/C are complete in PRs
#152/#153/#154, the bounded Slice D registry/resolver/export foundation is
complete in PR #155, and trusted server-side generation remains pending

Last reviewed: 2026-08-25 after PR #155 merged and Phase 5 planning opened in
Draft PR #156

This plan sequences the consolidation of Project, Comment, and Run attachment
infrastructure after Phase 4C completed in PR #151. The durable
ownership and lifecycle boundary is defined in
[shared attachment backend contract](./ATTACHMENT_BACKEND_CONTRACT.md).
Physical-byte integrity, reachability, export, and GC continue to follow
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md).

This document is intentionally introduced before implementation so Phase 5
frontend refinement can depend on stable attachment semantics instead of
polishing several incompatible upload and removal paths.

## Scheduling boundary

PRs #152, #153, #154, and #155 are complete and the v1 interaction feature set
remains frozen. PR #155 implements only the domain-neutral derivative registry,
resolver, retention, and export foundation. It does not treat existing
client-generated Comment previews as trusted shared derivatives, and it does not
introduce a server-side image generator or change owner lifecycle.

The intended order is:

1. complete and independently review the bounded Phase 5 execution plan in Draft
   PR #156;
2. begin Phase 5 frontend refinement without reopening v1 interaction scope,
   with attachment/media surfaces handled as the dedicated Phase 5C slice;
3. add a trusted server-side derivative producer and later transport convergence
   only as separately justified follow-up slices.

The implementation is not one mega-PR. Storage ingestion, domain lifecycle,
derivatives, schema refinement, and frontend exposure have different failure
modes and review requirements.

## Current repository state

The repository already shares important low-level blob infrastructure:

- content hashing and content-addressed reuse;
- provider-verified R2 and managed-storage registration;
- primary-authoritative reconciliation after uncertain registration;
- integrity quarantine;
- one global retention-edge surface and GC ledger;
- complete export of blob metadata and occurrence relationships.

The remaining duplication is mainly in ingestion and domain integration.

### Project upload path

Project-owned attachments currently use a dedicated `/project-assets` route.
The route:

- buffers the complete request in the Worker;
- limits uploads to 10 MB;
- calculates SHA-256;
- registers or adopts an R2 asset;
- returns an asset identity before a separate authoritative Project item/content
  binding operation.

This path does not reuse the richer Comment upload-session UX and cannot support
large durable originals without a redesign.

Project persistence and the current Project UI now expose the same generic
item-removal lifecycle for Reference, Markdown, and attachment occurrences.
Removing an attachment hides the Project occurrence through Trash semantics;
physical bytes remain governed independently by shared retention/reachability
and blob GC.

### Run and direct-asset path

Run-step execution images and related direct assets use the general asset upload
and `run_step_assets` occurrence model. The domain already records auditable
attachment deletion and can clear active Timeline media linkage while preserving
historical text.

Run attachment occurrence rows remain durable audit records, including
deleted/superseded tombstones, while blob retention is lifecycle-aware. A
deleted occurrence does not by itself require its bytes to remain forever:
physical deletion is decided by shared reachability/GC after all live retention
edges are considered.

### Comment submission path

Canonical Comments already have the most complete upload state machine:

- submission and item identities allocated before upload;
- pending, uploading, ready, failed, cancelled, deleted, and restore states;
- upload progress and cancellation;
- R2 for bounded images and managed storage for larger generic attachments;
- retry windows and cleanup;
- TIFF original/preview dependency handling;
- item-level deletion separate from canonical Comment deletion.

This path is a useful implementation source, but Comment publication and target
semantics MUST NOT become the universal attachment domain model.

### Metadata and deduplication coupling

Physical records retain first-registration filename/MIME provenance, but
Project, Run, and Comment attachment occurrences own contextual presentation.
The Project upload path now deduplicates verified identical bytes independently
of occurrence filename/MIME, so one immutable blob may legitimately appear as:

```text
Run occurrence:     AFM_before_cleaning.tif
Project occurrence: Surface morphology before treatment.tif
Comment item:       Raw AFM scan
```

Slice C separates byte identity from occurrence presentation without
weakening integrity checks. Because `run_step_assets` is exported with
`SELECT *`, adding its occurrence filename/MIME/size columns changes the
complete persistent export row shape; the complete export contract is therefore
schema v6 rather than v5.

### Derivative coupling

PR #155 introduces a source-addressed shared registry and read resolver for
browser-safe derivatives. Existing TIFF/ordinary-image previews uploaded by the
Comment client remain Comment occurrence assets: their relationship to an
original is not cryptographically or procedurally proven and therefore is not
adopted into the trusted registry. A later server producer must read verified
source bytes, generate the bounded preview, register the resulting asset, and
only then make it reusable by Comment, Run, or Project.

## Target architecture

The target keeps domain tables and services authoritative while introducing
shared internal infrastructure:

```text
domain UI
   ↓
domain mutation service
   ├── Project binding
   ├── Comment item binding
   └── Run-step occurrence binding
             ↓
shared attachment ingestion service
             ↓
shared blob registration / integrity / provider layer
             ↓
R2 or managed storage
```

A separate shared derivative service reads a verified source blob and produces
rebuildable preview records. Blob lifecycle consumes all domain and derivative
retention edges.

## Proposed internal service contracts

### Ingestion request

A frozen ingestion request should contain at least:

```text
session ID
operation ID
actor
filename metadata
MIME metadata
declared byte size
expected SHA-256 when available
upload class or policy hint
```

A domain may provide a policy hint such as `small_image`, `generic_original`, or
`derived_preview`, but it may not provide a provider object key or choose an
unvalidated physical locator.

### Ingestion result

The service returns a provider-neutral result equivalent to:

```text
blob ID
SHA-256
verified byte size
technical media type when detected
store kind
registration state
deduplicated flag
```

The domain then binds that result through its own authoritative transaction and
optimistic-concurrency contract.

### Binding failure

A successful upload followed by a failed or abandoned domain binding MUST leave
an identifiable orphan candidate. It MUST NOT create a provider-only object or
force the domain to guess whether cleanup is safe.

### Derivative request

A derivative request contains source blob identity, derivative kind, and
generator version. It does not include Project, Comment, or Run business state.
The caller binds the resulting derivative occurrence according to domain rules.

## Bounded implementation sequence

### Slice A — lifecycle completeness and executable policy

Status: complete in merged PR #152.

Goal: close the known user and storage gaps before reorganizing upload code.

Scope:

- expose authoritative Project attachment removal through Map, Reading, and the
  applicable Inspector action surface;
- reuse the existing Project item-removal state machine rather than adding an
  attachment-specific deletion API;
- add mounted coverage proving a Project attachment can be removed and restored
  without affecting another occurrence of the same blob;
- revise `run_step_assets` retention so active occurrences remain durable while
  explicitly deleted, non-superseded occurrences contribute a 24-hour grace
  edge without reopening FabuBlox supersession tombstones;
- give explicitly deleted ready Comment child items the same guaranteed
  24-hour retention edge for R2 and managed-storage bytes without hiding
  Comment text;
- keep restore best-effort after edge expiry until GC claim, with orphan
  reclamation and deleting/deleted/quarantine guards;
- keep whole-Comment Trash and its active child items durable;
- keep whole-Run Trash fully recoverable and distinct from explicit attachment
  removal;
- preserve Run step and Timeline text after direct attachment deletion;
- add GC regressions for shared blobs and expired/unexpired grace edges;
- update the normative blob lifecycle contract in the same PR.

No upload protocol consolidation is required in this first code slice.

Exit: users can undo incorrect Project attachment creation, while deleted direct
Run attachments and large Run Comment child attachments no longer retain bytes
indefinitely or erase their owning experimental text.

### Slice B — extract one internal ingestion service

Status: complete in merged PR #153.

Goal: remove duplicated hashing, registration, and winner-adoption logic while
keeping domain-specific request validation in the compatibility adapters.

Scope:

- centralize SHA-256 derivation for buffered R2 bytes, safe object-name
  normalization, provider-verified byte-size checks, and registration error
  classification;
- keep domain-specific filename, MIME, size-limit, and request-shape validation
  in the compatibility adapters where their public contracts intentionally differ;
- introduce one provider-neutral ingestion result type;
- move R2 registration and managed registration orchestration behind one
  internal service boundary;
- preserve `/assets`, `/project-assets`, and Comment item-content routes as
  compatibility adapters;
- preserve existing limits and UI behavior while the extraction is reviewed;
- ensure every adapter uses the same outcome-uncertain, dedupe, quarantine, and
  orphan-candidate rules;
- add cross-adapter contract tests for identical bytes and provider failures.

No schema migration is required merely to share TypeScript services.

Exit: current routes call one ingestion implementation, and future API or
provider changes no longer require three independent storage paths.

### Slice C — separate blob facts from occurrence presentation

Status: complete in merged PR #154.

Goal: allow safe cross-domain reuse regardless of contextual filenames or
captions.

Delivered scope:

- define provider-neutral blob identity at the schema/service boundary;
- treat original/display filename, title, caption, role, and user-facing MIME as
  occurrence metadata;
- retain technical byte facts and integrity state on the blob record;
- remove the Project-specific identical-bytes/different-filename conflict;
- migrate existing metadata without changing stable occurrence IDs;
- preserve complete export and restoration of both blob and occurrence facts;
- update copy/paste and cross-domain copy/reuse tests.

The implementation may retain `assets` and `managed_storage_objects` as
provider-specific records behind an adapter. A table collapse is optional and
must be justified independently.

Exit: one verified byte sequence can serve several domain occurrences with
independent contextual metadata.

### Slice D — shared derivative service

Status: bounded registry/resolver/export foundation complete in PR #155; trusted
server-side generation and domain producer adapters remain pending.

Goal: make useful previews reusable and domain-neutral without trusting client-
supplied source/preview claims.

Delivered by the bounded PR #155 foundation:

- `attachment_derivatives` identity keyed by source SHA-256, source byte size,
  derivative kind, and generator version;
- one healthy ready winner with bounded renewable retention;
- safe R2 browser-preview asset guards, quarantine/GC filtering, and domain-
  neutral R2/managed-source resolution;
- complete-export schema v7 coverage and derivative-row restore round-trip tests;
- explicit removal and cleanup of SQL/runtime adapters that promoted
  client-uploaded Comment previews into the trusted registry.

Required follow-up before the slice exit is complete:

- a trusted server producer that reads verified source bytes and generates a
  bounded browser-safe preview;
- registration only after source read, generation, ingestion, and integrity
  checks succeed;
- Project, Comment, and Run presentation adapters that request or reuse the
  shared result without owning generator trust;
- failure/fallback behavior that leaves the original usable as a generic card.

PDF first-page preview remains optional and requires a separate security,
resource, and bundle/runtime review. Scientific-data parsing remains out of
scope.

Exit: supported previews are generated by a trusted server producer once per
source/generator contract and can be reused across domains. The registry
foundation alone does not satisfy this exit.

### Slice E — converged upload-session transport where justified

Goal: unify user-visible progress, cancellation, retry, and large-file behavior
after the internal service has stabilized.

Possible scope:

- one upload-session API shared by Project, Comment, and Run clients;
- progress and abort semantics;
- exact retry of stable session and item identities;
- small-object R2 and large-original managed-storage routing;
- bounded direct-provider or resumable upload if deployment requirements demand
  files larger than the Worker-buffered path can safely support;
- compatibility period for old routes before removal.

This slice is not required merely to share the backend. It should land only when
its UX and deployment benefit outweigh API churn.

Exit: domains share the transport where useful without sharing owner lifecycle.

### Slice F — Phase 5 attachment-surface refinement

Goal: refine the now-stable semantics as one visual system.

This work is scheduled as Phase 5C in
[frontend refinement implementation plan](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md).

Scope belongs to Phase 5 and may include:

- consistent file cards, preview affordances, progress, retry, error, and empty
  states;
- clear distinction between `Remove attachment`, `Move Comment to trash`,
  `Move Project to trash`, and `Delete run attachment`;
- restore-window wording such as 24 hours or 30 days;
- consistent keyboard, focus, mobile, and confirmation behavior;
- no misleading generic action that can delete an owner when only a child item
  was selected.

Exit: the product uses one coherent attachment language while preserving
separate domain semantics.

## Route compatibility strategy

The initial code slices SHOULD preserve existing routes:

```text
/assets
/project-assets
/comment-submissions/:submissionId/items/:itemId/content
```

They become adapters rather than independent storage implementations. This
keeps Project, Run, and Comment state machines reviewable while shared internals
are extracted.

A later unified route MAY be introduced only after:

- stable ingestion-session identity is specified;
- large-file provider routing is deployment-safe;
- domain binding remains a separate authorized operation;
- old clients can be migrated without weakening exact retry and recovery.

## Data-model direction

The first extraction should avoid speculative schema churn. The minimum useful
abstraction is a TypeScript/provider-neutral blob handle backed by current
records.

A later migration is justified when it solves concrete problems:

- filename/MIME conflicts during deduplication;
- one source blob with several occurrence presentations;
- shared derivative identity;
- provider migration or tiered storage;
- uniform export and purge planning.

Any migration MUST preserve:

- stable Project item/content/placement IDs;
- stable Comment submission/item and target IDs;
- stable Run-step attachment occurrence IDs;
- Reference target identity;
- Timeline source links and deletion audit metadata;
- current blob hashes and provider registration history.

## Retention and cleanup implementation

### Project

- active occurrence: durable edge;
- standalone item or whole Project in Trash: 30-day recovery edge;
- restore reactivates the same item/content/placement identities;
- purge releases Project-owned edges, then ordinary global GC decides whether
  bytes can be deleted.

### Comment

- item removal updates only the item occurrence;
- canonical Comment body and Timeline text remain active unless the whole
  Comment is separately trashed;
- Comment Trash target: 30 days;
- explicitly deleted ready child items use the implemented 24-hour restore edge;
- TIFF original/preview dependencies must remain executable during delete and
  restore.

### Run

- explicit direct-attachment removal records audit metadata and clears active
  media projection where needed;
- the deleted occurrence contributes a 24-hour retention edge;
- whole-Run Trash keeps the complete Run graph and files recoverable;
- no independent Run-step delete mechanism is introduced;
- after grace expiry, global reachability decides whether physical bytes are
  orphaned.

### Shared blobs

A regression MUST cover one physical blob retained simultaneously by Project,
Comment, Run, and derivative edges. Removing any subset must not collect the
blob while one effective edge remains.

## Required verification matrix

### Ingestion

- declared size and actual size match/mismatch;
- expected hash match/mismatch;
- R2 and managed-storage registration;
- verified winner reuse;
- provider outage and primary-authority outage;
- staging and promotion uncertainty;
- identical bytes across Project, Comment, and Run adapters;
- failed domain binding leaves an ordinary orphan candidate;
- no client-supplied physical locator is accepted.

### Domain lifecycle

- Project attachment remove/restore;
- Project Trash/restore with attachment bytes intact for 30 days;
- Comment item deletion leaves body, targets, occurrences, and Timeline text;
- whole Comment Trash remains distinct from item deletion;
- direct Run attachment deletion leaves Run and step state intact;
- Run Timeline active media link is cleared while audit metadata remains;
- 24-hour Run grace is retained before expiry and released after expiry;
- whole-Run Trash preserves every attachment;
- shared blob remains reachable from another domain.

### Derivatives

- client-uploaded Comment previews never populate the trusted shared registry;
- one TIFF source produces one reusable preview per generator version after a
  trusted server producer is introduced;
- deletion of one occurrence does not remove a derivative still used elsewhere;
- missing/failed preview falls back to a generic original file card;
- derivative can be regenerated after collection;
- parser resource bounds and malformed-input handling.

### Export and recovery

- complete export schema v7 includes source blobs, derivative registry rows,
  occurrences, deletion metadata, retention edges, and GC state;
- exported derivative rows can be restored after their referenced assets while
  preserving source identity, generator identity, status, lease, and winner;
- missing provider bytes produce warnings rather than database-row loss;
- restore behavior matches the remaining domain recovery window;
- migrations work in host SQLite and D1/workerd;
- no physical-delete guard is weakened without the privileged purge design.

## Activation and rollout

The documentation PR performs no deployment or remote data operation.

Each later implementation slice must record:

- exact base and exact head;
- changed schema and route surface;
- fresh migration and existing-database migration results;
- provider behavior under R2 and configured managed storage;
- complete export compatibility;
- exact-head focused and repository-wide CI;
- whether a remote migration or Worker deployment is required.

Provider routing, grace constants, and scheduled cleanup must be activated only
after the corresponding migration and exact Worker head are deployed together.

## Explicit defer list

The first implementation sequence does not include:

- a general file-browser page;
- arbitrary cross-domain move/reparent operations;
- scientific parsing of HDF5, MAT, ZIP, CAD, Lumerical, or instrument formats;
- PDF preview without a dedicated security review;
- public blob URLs or client-controlled provider keys;
- real-time collaborative uploads;
- automatic provider migration;
- Docker/self-hosted implementation;
- permanent purge of Sample or Run experimental history;
- a universal owner-delete endpoint.

## Documentation exit criteria

This planning slice is complete when:

1. the shared/backend versus domain/owner boundary is explicit;
2. Project standalone, Comment child-item, and Run evidence semantics are
   distinguished;
3. Comment attachment deletion is guaranteed not to erase Comment or Timeline
   text;
4. the Project 30-day and Run explicit-attachment 24-hour targets are recorded;
5. physical deletion remains global reachability-driven;
6. the bounded PR #155 foundation is recorded as complete while trusted
   generation remains a separate follow-up;
7. Phase 5 attachment refinement is scheduled through the dedicated Phase 5C
   slice rather than folded into a backend rewrite.
