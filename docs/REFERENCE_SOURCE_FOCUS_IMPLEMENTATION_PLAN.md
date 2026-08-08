# Reference source-focus implementation plan

Status: implemented in Draft PR #128; merge closes Phase 2B

Last reviewed: 2026-08-08 after PR #128 lifecycle and media review

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
intermediate API, schema, serializer, or route shapes.

For this Phase 2B2 slice:

- schema, serializer, frontend read-model, and authenticated read interfaces may
  be corrected directly when stable occurrence identity is missing;
- no compatibility shim is required for an intermediate field or URL that has
  never carried production data;
- no migration-inheritance guarantee is required for disposable local or
  preview D1 databases;
- a developer database may be reset and rebuilt from the complete migration
  chain after an interface or schema correction; and
- this freedom must not weaken the final identity, lifecycle, export, access,
  or permanent-delete contracts intended for production.

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

The mature source interfaces already expose almost all focus identities:

- Run Steps expose `run_steps.id`;
- logical Comments expose `comment_submissions.id` through `submissionId`;
- Comment occurrences expose `run_step_comments.id`;
- Comment images and attachments expose `comment_submission_items.id`; and
- metrology references expose `metrology_template_references.id`.

Execution-image occurrences are different. The execution grid currently has the
physical asset key needed for its ordinary gallery, while the public reference
target is the occurrence row `run_step_assets.id`. Phase 2B2 must not expose the
R2 key in a reference URL or resolver response merely to bridge that gap.

The selected boundary is therefore one authenticated stable-occurrence media
interface rather than a broad processing read-model expansion.

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
6. exact execution-image focus and authenticated preview by
   `run_step_assets.id + run_steps.id`;
7. exact metrology-reference location inside its owning metrology Recipe
   revision;
8. Sample-page focus for Sample Comments and their attachment items;
9. refresh, Back, and Forward behavior driven entirely by the current URL;
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
- exposing R2 or managed-storage locators to source-focus consumers;
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

## Stable execution-image media interface

The reference target is the occurrence row:

```text
run_step_assets.id
```

The existing grid continues to use its ordinary `executionImageKeys` array for
normal rendering. A focused execution image is opened through:

```text
GET /api/references/media/execution_image/:encodedOccurrenceId
  ?step=<run-step-id>
```

The route:

1. inherits the core authentication and error middleware;
2. decodes the same versioned opaque ID used by canonical reference URLs;
3. requires an explicit stable Step context;
4. matches `run_step_assets.id + run_steps.id` exactly;
5. accepts only `run_step_assets.role = 'execution'`;
6. rejects deleted occurrences and deleted Sample/Run/Step ancestors;
7. resolves the private R2 locator server-side;
8. streams the bytes with private, no-store response headers; and
9. never returns the R2 key in the URL, JSON model, or page state.

The endpoint is read-only and context-preserving. It is not a generic public
asset lookup and it cannot reinterpret a state-observation occurrence as an
`execution_image` target.

This interface keeps stable occurrence identity at the reference boundary while
avoiding an unrelated rewrite of every normal execution gallery.

## Processing-grid focus behavior

The Processing workspace parses `run`, `step`, and `focus` from the current URL
and passes the already-loaded typed data to a source-focus component. It does
not fetch a duplicate Processing detail model.

A pure locator scans the same columns used to build the existing grid and
returns one exact cell when:

- the selected Run matches the URL;
- the context Step exists in that Run;
- the requested target exists under that Step where the current read model
  exposes the occurrence; and
- the target belongs to the Sample column selected by the source URL.

Target matching is:

| Target type | Stable identity used by focus |
|---|---|
| `run_step` | `RunStep.id` |
| `comment` | `RunStepComment.submissionId` |
| `comment_occurrence` | `RunStepComment.id` |
| `comment_attachment` | `CommentImage.id` or `CommentAttachment.id` |
| `execution_image` | focus ID plus exact Step validation in the media interface |

When found, the grid:

1. centers the exact row and Sample cell with the existing browser scroll model;
2. marks the cell and exact locally represented child object with a persistent
   focus treatment while the URL remains focused;
3. opens the common-comment sheet on mobile when the target lives there;
4. opens the exact Comment-image or execution-image preview;
5. opens a small read-only preview for file and link attachments; and
6. leaves all normal editing, checkbox, Jump-to-current, and scrolling behavior
   unchanged when no focus is present.

The focus operation is idempotent for one rendered URL state. User scrolling
after the initial focus is not continuously overridden. Navigating away and then
Back to the focused URL applies the focus again.

If the requested object is absent, mismatched to the Step context, deleted from
the ordinary source read, rejected by the stable media interface, or not
represented by the selected Run, the page does not guess. It shows a
non-blocking read-only message and keeps the workspace usable.

Changing the selected Run manually clears the old `step` and `focus` parameters
so a target cannot be silently applied to another Run.

## Sample-page focus behavior

The Sample page locates:

- a logical Sample Comment by `CommentSubmission.id`; or
- one Comment image/file/link item by its stable submission-item ID.

A focused note is shown even when it falls outside the normal recent-three
preview. The page expands Notes & observations, scrolls the exact note into
view, highlights the source card, and opens the exact attachment preview.

The page does not reinterpret process Comments as Sample-owned Comments;
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

Focused Comment images use their stable submission-item ID to select the exact
item, then use the already-authorized source model's asset URL to display bytes.
Focused execution images use the stable occurrence media interface above.

File and link attachments use a small read-only preview dialog that shows:

- title or filename;
- kind and current status;
- description when present;
- size and MIME type for files; and
- an explicit Download or Open-link action.

The preview preserves the source page underneath it and contains no mutation
control. Closing a preview changes only local modal state and does not rewrite
the focus URL.

## Browser-history behavior

Focus state is URL-owned, not copied into a global store. Each source page
re-parses its current search parameters whenever React Router changes them.

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
- focused objects receive a visible outline plus a textual `Referenced` marker;
- the focus treatment uses existing palette and semantic tokens rather than a
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
- stable execution-image media lookup by occurrence and Step;
- rejection of state observations, wrong Steps, malformed IDs, missing IDs, and
  deleted occurrences or ancestors;
- image and attachment preview selection by stable ID rather than filename or
  physical locator;
- Sample-note expansion and exact attachment selection;
- metrology-reference route and item selection;
- query preservation through template route correction;
- direct refresh plus MemoryRouter Back/Forward focus transitions;
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
10. the authenticated execution-image media route validates stable occurrence
    plus Step context and leaks no physical locator;
11. focused, full-suite, TypeScript, Worker, and client builds pass;
12. authoritative documents mark Phase 2B complete and Phase 2C as next; and
13. the Draft PR targets only `v2/backend-foundation`.

## Next phase

After this PR, Phase 2C implements deterministic search and reference insertion
on top of the closed identity, lifecycle, resolution, canonical URL, and source-
focus contracts. Project-owned data remains deferred until search/read-model
behavior is reviewed.


## Review corrections before Ready

PR #128 remains Draft until review confirms these merge-blocking corrections:

- Processing focus uses memoized grid columns and a stable focus/data signature,
  so unrelated parent renders do not recenter the page or reopen a closed
  preview.
- Template data loading is keyed only by `templateId`; route correction reads
  the latest query through a ref, so focus history neither refetches page data
  nor overwrites unsaved metrology notes.
- Ordinary asset reads and stable execution-image reads share one authenticated
  media policy: safe raster allowlist for inline content, `nosniff`, same-origin
  resource policy, sandboxed attachment fallback, and rejection of
  `deleting`/`deleted` GC locators.
- Mounted React tests exercise preview closure across unrelated rerenders and
  Template Back/Forward behavior with unsaved form state.

After these corrections and document synchronization pass the complete gate,
Phase 2C deterministic search is the next implementation boundary.
