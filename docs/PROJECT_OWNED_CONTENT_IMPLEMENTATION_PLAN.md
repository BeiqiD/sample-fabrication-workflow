# Project-owned content implementation plan

Status: Phase 3B3 review fixes implemented in Draft PR #135; independent exact-head review pending

Last reviewed: 2026-08-13 after the PR #135 review fixes for generic attachment upload, intrinsic metadata deduplication, Markdown cancellation, and deterministic retry handling

This document defines the bounded Phase 3B3 implementation for Project-owned Markdown and generic attachments. The durable interaction contract remains in [PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md), while authoritative persistence remains in [PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md](./PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md).

## Goal

A desktop user can create the two Project-owned content classes without turning the React Flow document into authoritative state:

- Markdown authored directly in the Project workspace; and
- generic file attachments whose bytes are owned by Project content rather than copied from a source reference.

Committed content must immediately participate in the existing immutable Project creation sequence, reopen from the authoritative Project snapshot, and appear in the Reading projection automatically.

## Existing backend boundary reused by 3B3

Phase 3B3 requires no new schema or migration. The Phase 3A2 service already provides:

- `POST /projects/:projectId/items/markdown`;
- `POST /projects/:projectId/items/attachment`;
- `PATCH /projects/:projectId/contents/:contentId/markdown`;
- `PATCH /projects/:projectId/contents/:contentId/attachment`;
- `GET /projects/:projectId/contents/:contentId/file`;
- atomic Project sequence reservation plus content, item, and placement creation; and
- retry-idempotent operation identities.

Phase 3B3 adds one bounded upload ingress, `POST /project-assets`, for Project-owned generic bytes. It deliberately does **not** widen the existing `/assets` endpoint, which remains image-only for its existing callers. `/project-assets` still stores bytes in the same authoritative `assets` registry and R2 lifecycle, returns the stable `assetId`, and lets the Project attachment create transaction revalidate that blob identity before creating content, occurrence, and placement.

The local filename is transported in an ASCII-safe percent-encoded `x-project-filename-uri` header and decoded/validated by the Worker. Generic MIME types such as `application/pdf` and `application/octet-stream` are accepted up to the existing Phase 3B3 10 MB upload bound.

## Markdown creation and editing

Desktop empty-Map double-click creates exactly one renderer-local Markdown draft at the clicked Map coordinate.

Before the first explicit Save:

- no Project API write occurs;
- the draft owns stable local content/item/placement identities;
- Escape may cancel **only an empty new draft**;
- Escape never discards an existing Markdown edit or a non-empty new draft;
- explicit Cancel may discard a deterministic unsaved/error/conflict draft; and
- geometry interaction and other Project content creation are disabled while the editor is active.

The first Save freezes one complete authoritative create request. If the outcome is uncertain, retries reuse the exact same content ID, item ID, placement ID, geometry, expected Project revision, Markdown source, and operation ID. The editor becomes read-only after the request starts so the client never reuses one operation identity with changed content.

Existing Markdown uses the same rule for `PATCH`: one frozen source payload, expected content revision, and operation ID remain attached to an uncertain retry. A deterministic `4xx` or `409` result is terminal for that frozen mutation: it is not presented as an exact-retry loop. The user can discard the failed edit, resolve the cause, and begin a new mutation. A conflict never silently overwrites authoritative content.

Phase 3B3 intentionally uses a lightweight textarea editor. Rich Markdown/TeX rendering and editor selection remain Phase 3D work.

## Generic attachment creation

Desktop attachment creation is available from:

- an explicit `Add attachment` action using the visible Map center; and
- a Map context-menu command using the exact clicked Map coordinate.

Direct local-file drag onto the Map remains optional future polish rather than a Phase 3B3 requirement.

Creation order is fixed:

1. choose one local file;
2. upload/register the generic bytes through `POST /project-assets`;
3. retain the returned stable `assetId`;
4. create one Project attachment content + occurrence + creation sequence + Map placement through the authoritative Project transaction; and
5. merge only the returned authoritative records into local Project state.

An outcome-uncertain asset upload may be retried because content addressing makes replay safe; if no Project occurrence request has started, it may also be cancelled. A cancelled or response-lost upload may leave a deduplicated/unreferenced asset for the existing blob lifecycle/GC policy; the client does not directly delete a possibly shared asset.

Once the Project attachment create request starts, an uncertain result cannot be discarded locally. Retry exact-replays the same Project identities and operation ID so a response-loss case cannot create a duplicate occurrence. Deterministic upload or Project-create failures are not exact-retried: the user cancels the failed operation and starts a new one after resolving the cause.

### Content-addressed identity and intrinsic metadata

The existing asset registry has one canonical intrinsic metadata tuple for each SHA-addressed object. Phase 3B3 preserves that database invariant rather than creating a second occurrence-local identity for the same bytes.

- same SHA + same original filename + same MIME type + same byte size: reuse the existing asset identity;
- same SHA but different filename or MIME metadata: return an explicit `409` instead of silently inheriting the first upload's metadata or weakening the database guard;
- race-winner deduplication applies the same metadata check before reuse.

This keeps content addressing deterministic without a schema migration and prevents a later upload from being displayed with surprising metadata from an earlier upload.

## Attachment metadata and rendering

Project-owned attachment intrinsic byte metadata is immutable through Phase 3B3:

- original filename;
- MIME type;
- byte size; and
- physical/storage locator.

The user may edit only:

- Project-local caption; and
- optional source URL.

Those metadata updates use one frozen revision/operation request for uncertain retries. Deterministic validation/conflict failures are terminal for the frozen request and expose discard/cancel rather than another exact retry. Replacing attachment bytes is deferred.

Rendering follows MIME identity rather than filename guessing:

- images render inside Map/Reading with `object-fit: contain`;
- PDFs and all other generic files remain file cards/open-file actions in this phase.

Existing source attachments are never copied by this creation flow. They remain read-only Reference targets discovered through `ReferenceSearchSurface`.

## Shared save and navigation boundary

At most one Project-owned editor or structural attachment operation is active at a time. While one is active:

- Map geometry mutation is frozen;
- reference placement/removal cannot start;
- selection cannot silently switch away from the active editor; and
- SPA navigation plus hard refresh/close stay protected until the operation is saved, deterministically discarded, or authoritatively reconciled.

Only an **outcome-uncertain** owned-content mutation exposes exact retry. Deterministic `4xx` and `409` results retain the error/conflict state for user visibility but do not resubmit the frozen operation from retry controls.

Existing Phase 3B1 placement saves remain separate from content revision saves. Successful content insertion merges its authoritative placement baseline without resetting unrelated dirty geometry, undo/redo history, or pending placement operations.

## Map context-menu coordinate boundary

The Project Map canvas establishes its own positioning context (`position: relative`). The attachment context menu therefore uses the same canvas-relative client coordinates from which the exact React Flow Map point is derived, rather than accidentally positioning relative to an outer ancestor.

## Mobile boundary

Phase 3B3 keeps mobile creation and upload excluded. Mobile continues to render the authoritative creation-sequence projection, including newly committed Markdown and attachments. Full mobile editing belongs to the later Reading phase rather than being emulated through the desktop Canvas interaction model.

## Verification boundary

Phase 3B3 adds a permanent `pre-pr/project-owned-content` verification status. The dedicated gate covers:

- helper geometry/MIME/failure classification;
- Project client content/upload routes;
- generic PDF/non-image upload and Unicode filename transport;
- exact SHA + metadata deduplication plus deterministic metadata-mismatch rejection;
- static source-boundary checks;
- mounted local-draft zero-write behavior;
- Escape preservation for edited/non-empty Markdown;
- exact retry only after uncertain owned-content outcomes;
- generic asset upload followed by authoritative Project attachment creation;
- context-menu positioning ownership;
- existing mobile no-creation behavior;
- existing real React Flow semantic geometry behavior;
- production TypeScript/build and Project Map bundle splitting.

The normal `pre-pr/tests` and `pre-pr/build` gates remain required as well. PR #135 final exact-head merge-context verification is recorded in the PR description so this implementation plan does not embed a head SHA that becomes stale on documentation-only synchronization commits.

## Deliberately deferred

Phase 3B3 does not add:

- edge authoring or editing;
- rich Markdown/TeX or WYSIWYG editors;
- floating images or page-layout tools;
- direct source-attachment copying;
- attachment byte replacement;
- mobile item creation/upload;
- full Reading editing UX;
- live webpage embeds; or
- remote D1 migration or Cloudflare deployment.

## Exit criteria

Phase 3B3 is complete when a desktop user can create/save/reopen Project Markdown, upload/place/reopen a generic Project attachment, edit only its allowed Project-local metadata, and see both content classes in creation-sequence Reading without duplicate occurrences after response loss, without deterministic errors being trapped in retry loops, and without React Flow becoming the database.
