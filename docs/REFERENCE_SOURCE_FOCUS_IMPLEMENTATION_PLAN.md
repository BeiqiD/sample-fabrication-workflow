# Reference source-focus implementation plan

Status: Phase 2B2 implementation contract

Last reviewed: 2026-08-08 against `v2/backend-foundation` after PR #127

This document defines the second and final implementation slice of Phase 2B.
PR #127 completed Phase 2B1 by establishing one versioned opaque canonical URL,
a lifecycle-aware destination model, and a generic read-only Reference page for
all nine current v1 target types. Phase 2B2 makes the safe source URLs emitted by
that model focus the exact object inside the existing Sample, Processing, and
Metrology-template interfaces.

The product invariants remain in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md). The canonical route
and lifecycle contract remain governed by
[reference deep-link implementation plan](./REFERENCE_DEEP_LINK_IMPLEMENTATION_PLAN.md).

## Pre-production schema and compatibility assumption

The current database contains no production data. `v2/backend-foundation` is a
pre-production integration branch and no deployed consumer depends on its
intermediate API or route shapes.

For this Phase 2B2 slice:

- schema, serializer, and frontend read-model interfaces may be corrected
  directly when stable occurrence identity is missing;
- no compatibility shim is required for an intermediate response field that has
  never carried production data;
- no migration inheritance guarantee is required for disposable local or
  preview D1 databases;
- a developer database may be reset and rebuilt from the complete migration
  chain after an interface or schema correction; and
- this freedom must not weaken the final identity, lifecycle, export, or
  permanent-delete contracts intended for production.

The repository still keeps every checked migration executable through fresh
Wrangler local D1/workerd. No remote D1 migration or Worker deployment is run
from this branch.

## Current state

After PR #127 the resolver emits:

```text
destination
- referenceUrl
- mode
- openSourceUrl
- contextOpenSourceUrls[]
```

The canonical `/references/:type/:encodedId` route is exact and refresh-safe.
Active contexts also receive deterministic source URLs containing Run, Step,
and reference hints. Existing source pages currently consume only the Run
selection. They do not yet center the exact Step, identify the exact Comment or
attachment occurrence, open the referenced image/file in context, or focus a
metrology reference.

The mature source interfaces already contain almost all required data:

- Run Steps expose stable IDs;
- logical Comments expose `comment_submissions.id` through `submissionId`;
- Comment occurrences expose `run_step_comments.id`;
- Comment images and attachments expose stable submission-item IDs;
- metrology references expose stable occurrence IDs; and
- execution images exist as stable `run_step_assets.id` rows, but the current
  processing read model exposes only their physical asset keys.

The last point is an interface gap. Phase 2B2 corrects the read model so source
focus always uses stable occurrence identity rather than an R2 key.

## Pull-request boundary

This PR targets `v2/backend-foundation` and completes Phase 2B.

### Included

1. one shared, versioned source-focus query codec;
2. destination URLs updated to use that codec rather than an unparsed string
   hint;
3. exact Run-Step location and viewport centering in the existing multi-sample
   execution grid;
4. exact logical-Comment and Comment-occurrence location;
5. exact Comment image, file attachment, and link-attachment location with a
   context-preserving preview;
6. exact execution-image location and image preview by
   `run_step_assets.id`;
7. exact metrology-reference location inside its owning metrology Recipe
   revision;
8. Sample-page focus for Sample Comments and their attachment items;
9. refresh, back, and forward behavior driven entirely by the current URL;
10. a clear read-only unavailable state when a focus target no longer exists in
    the loaded source interface;
11. focused tests added to the existing reference-foundation and deployment
    gates; and
12. authoritative roadmap updates marking Phase 2B complete and Phase 2C as the
    next boundary.

### Excluded

- Project, Project content, `project_items`, backlinks, Text, Inspector, or Map;
- deterministic or semantic search;
- source mutation from the canonical Reference page;
- a generic public reference-registration endpoint;
- permanent deletion or tombstone creation;
- a repository-wide redesign of ordinary Sample or Template path IDs;
- a new attachment editor or general media-library redesign;
- automatic navigation between several valid common-Comment contexts;
- changing the resolver query-count contract;
- remote D1 migration or Worker deployment.

## Source-focus query contract

Safe source destinations use a single query field:

```text
focus=<target-type>:<opaque-id>
```

The opaque ID reuses the canonical `r1_` route-ID codec. The shared functions are
conceptually:

```text
encodeReferenceSourceFocus({ type, id }) -> string
decodeReferenceSourceFocus(value) -> ReferenceTarget | null
```

The target type remains outside the opaque payload so pages can reject target
classes they do not support before searching their local read model. The ID
payload remains one-to-one for the complete allowed JavaScript stable-ID
identity.

Processing destinations retain explicit context hints:

```text
/processing/<sample-id>
  ?run=<run-id>
  &step=<run-step-id>
  &focus=<target-type>:<opaque-id>
```

Sample destinations use:

```text
/samples/<sample-id>?focus=<target-type>:<opaque-id>
```

Metrology-reference destinations use:

```text
/templates/metrology/<recipe-revision-id>
  ?focus=metrology_reference:<opaque-id>
```

`run` and `step` remain ordinary query values emitted through
`URLSearchParams`, which preserves their exact string identity. `focus` carries
the object identity being presented. For a common logical Comment, each ordered
context URL has the same Comment focus but a different Sample/Run/Step context.
No source page chooses another context automatically.

Malformed, unknown-version, unknown-type, whitespace-padded, or non-canonical
focus values fail closed and produce no object focus.

## Stable execution-image read model

The existing `RunStep.executionImageKeys: string[]` field conflates a physical
asset locator with the stable occurrence users reference. It is replaced by:

```text
RunStepExecutionImage
- id          # run_step_assets.id
- assetKey    # current authenticated source-interface transport
- filename
- mimeType
- createdAt

RunStep.executionImages[]
```

The Worker obtains these fields in the existing bounded processing-detail query;
it does not add one request per image. UI galleries use `id` for focus and
`assetKey` only to fetch the bytes through the existing authenticated asset
route.

Planned diagrams remain keyed by their current asset representation because
`execution_image` references apply only to execution occurrences.

## Processing-grid focus behavior

The Processing workspace parses `run`, `step`, and `focus` from the current URL
and passes a typed focus request to `MultiSampleRunGrid`.

A pure locator scans the already-built grid and returns one exact cell when:

- the selected Run matches the URL;
- the context Step exists in that Run;
- the requested target exists under that Step; and
- the target belongs to the Sample column selected by the source URL.

Target matching is:

| Target type | Local stable identity |
|---|---|
| `run_step` | `RunStep.id` |
| `comment` | `RunStepComment.submissionId` |
| `comment_occurrence` | `RunStepComment.id` |
| `comment_attachment` | `CommentImage.id` or `CommentAttachment.id` |
| `execution_image` | `RunStepExecutionImage.id` |

When found, the grid:

1. centers the exact row within the usable viewport below the top bar and sticky
   sample-name row;
2. horizontally centers the exact Sample cell when it is outside the visible
   sample viewport;
3. marks the cell and exact child object with a persistent focus treatment while
   the URL remains focused;
4. opens the common-comment sheet on mobile when the target lives there;
5. opens the exact Comment-image or execution-image lightbox;
6. opens a small read-only attachment preview for file and link attachments; and
7. leaves all normal editing, checkbox, Jump-to-current, and scrolling behavior
   unchanged when no focus is present.

The focus operation is idempotent for the same URL. User scrolling after the
initial focus is not continuously overridden. Navigating away and then back to
the focused URL performs the focus again.

If the requested object is absent, mismatched to the Step context, deleted from
the ordinary source read, or not represented by the selected Run, the grid does
not guess. It shows a non-blocking read-only message and keeps the rest of the
workspace usable.

## Sample-page focus behavior

The Sample page locates:

- a logical Sample Comment by `CommentSubmission.id`; or
- one Comment image/file/link item by its stable submission-item ID.

A focused note is shown even when it falls outside the normal recent-three
preview. The page expands Notes & observations, scrolls the exact note into
view, highlights the exact child object, and opens the same image or attachment
preview used in the processing grid.

The page does not reinterpret process comments as Sample-owned comments;
process-context destinations continue to use the Processing workspace.

## Metrology-reference focus behavior

A metrology-reference destination opens the exact metrology Template route,
preserves the focus query through any process/metrology route correction, and
locates `MetrologyTemplateReference.id` in the existing reference list.

The exact item is centered and highlighted. Its existing authenticated file
link remains the explicit open action; the page does not automatically navigate
to a new browser tab.

A missing or lifecycle-hidden reference produces a local unavailable message
rather than focusing another file with the same filename or asset key.

## Preview behavior

Image previews reuse the existing lightbox, but galleries receive stable item
IDs in addition to asset keys. An initial focused item opens once per focus URL.
Closing the lightbox does not mutate the URL.

File and link attachments use a small read-only preview dialog that shows:

- title or filename;
- kind and current status;
- description when present;
- size and MIME type for files; and
- an explicit Download or Open-link action.

The preview preserves the source page underneath it and contains no mutation
control.

## Browser-history behavior

Focus state is URL-owned, not copied into a global store. Pages re-parse the
current location whenever React Router changes it.

Required behavior:

- direct refresh restores the same focused object;
- Back returns to the previous focused or unfocused state;
- Forward reapplies the later focus;
- route correction between process and metrology template pages preserves the
  query string;
- closing a preview changes only local modal state; and
- normal source navigation without `focus` remains unchanged.

## Accessibility and visual behavior

- scrolling respects `prefers-reduced-motion`;
- dialogs use the existing modal focus trap and Escape behavior;
- focused objects receive a visible non-color-only outline and an accessible
  label where practical;
- the focus treatment uses existing semantic tokens and does not introduce a
  second status-color vocabulary;
- persistent focus styles do not alter grid dimensions; and
- mobile and desktop use the same stable target semantics.

## Verification

Focused tests cover:

- focus-token encode/decode, malformed input, and collision resistance;
- deterministic source URL construction for every target class;
- exact Run-Step, logical-Comment, occurrence, attachment, and execution-image
  location in single- and multi-sample grids;
- common Comment context disambiguation through the Step hint;
- stable execution-image occurrence serialization;
- image and attachment preview selection by stable ID rather than asset key or
  filename;
- Sample-note expansion and exact attachment selection;
- metrology-reference route and item selection;
- query preservation through template route correction;
- direct refresh plus MemoryRouter back/forward focus transitions;
- unavailable-target fail-closed behavior;
- unchanged behavior when no focus query exists;
- locator non-disclosure in the canonical resolver; and
- inclusion in `test:reference-foundation`, CI, and `verify:v3-deployment`.

Repository checks remain:

```text
npm run test:reference-foundation
npm run verify:reference-foundation
npm test
npm run build
```

## Completion criteria

Phase 2B2 and Phase 2B are complete when:

1. every safe source destination carries one typed, reversible focus target;
2. exact source focus uses stable object or occurrence IDs, never an R2 key,
   provider locator, filename, or array position;
3. the Processing grid centers and identifies the exact Run Step and child
   object without changing normal grid behavior;
4. Sample Comments and their items focus correctly outside the recent preview;
5. Comment images, attachment files/links, and execution images open in a
   context-preserving read-only preview;
6. metrology references focus inside the exact Recipe revision;
7. refresh, Back, and Forward reproduce focus from the URL;
8. missing or mismatched targets fail closed without arbitrary fallback;
9. no focus integration introduces source mutation authority;
10. the processing read model exposes stable execution-image occurrence IDs;
11. focused, full-suite, TypeScript, Worker, and client builds pass;
12. authoritative documents mark Phase 2B complete and Phase 2C as next; and
13. the Draft PR targets only `v2/backend-foundation`.

## Next phase

After this PR, Phase 2C implements deterministic search and reference insertion
on top of the closed identity, lifecycle, resolution, canonical URL, and source-
focus contracts. Project-owned data remains deferred until search/read-model
behavior is reviewed.