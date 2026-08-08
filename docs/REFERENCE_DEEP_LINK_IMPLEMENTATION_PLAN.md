# Reference deep-link implementation plan

Status: Phase 2B1 implementation contract

Last reviewed: 2026-08-08 against `v2/backend-foundation` after PR #126

This document defines the first implementation slice of Phase 2B. It follows the
completed source lifecycle, blob lifecycle, reference registry, base resolver,
unified Worker middleware, and real D1/workerd resolver verification work.

The product invariants remain in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md). The completed base
resolver remains documented in
[reference resolution implementation plan](./REFERENCE_RESOLUTION_IMPLEMENTATION_PLAN.md).
This slice enriches that read model with navigation; it does not introduce
Project-owned data, search, source mutation, or permanent deletion.

## Current state

The integration branch now provides:

- stable IDs for every current referenceable source and occurrence;
- recoverable deletion for Samples, Runs, Run Steps, Comments, attachment
  occurrences, execution images, metrology references, and Recipe revisions;
- a sparse, immutable `reference_targets` registry;
- bounded batch resolution for all nine v1 target types;
- lifecycle metadata for the source and every context segment;
- one authenticated core Worker middleware stack; and
- host-SQLite plus real local D1/workerd coverage of the resolver.

The missing product boundary is navigation. Consumers can resolve a target but
cannot yet obtain one stable object URL or a safe destination when the source or
an ancestor is deleted or archived.

## Pull-request boundary

This PR targets `v2/backend-foundation` and establishes lifecycle-aware,
refresh-safe reference destinations.

### Included

1. one canonical route for every current reference target:
   `/references/:type/:id`;
2. a shared, pure destination builder used by the Worker and covered independently
   from React routing;
3. a destination object added to every reference-resolution result;
4. deterministic links to the closest existing source interface when that
   source path remains active;
5. ordered per-context links for targets with more than one valid context;
6. a generic read-only reference page for active, deleted, archived,
   inconsistent, missing, and tombstoned results;
7. explicit lifecycle messaging instead of forwarding deleted references into
   ordinary source routes that may return `404`;
8. focused contract tests included in the existing reference-foundation and
   deployment gates; and
9. documentation of the remaining object-focus work.

### Excluded

- schema or migration changes;
- Project, Project content, Project items, backlinks, Text, Inspector, or Map;
- deterministic or semantic search;
- public reference registration;
- source mutation controls on the reference page;
- privileged permanent deletion or tombstone creation;
- changing ordinary source read APIs to expose deleted rows;
- automatic Step scrolling/expansion inside the process grid;
- Comment or attachment highlighting inside existing source pages;
- an attachment-specific binary preview or download route;
- a Recipe-editor redesign;
- a broad frontend layout or style normalization;
- remote D1 migration or Worker deployment.

The excluded focus and preview behavior is Phase 2B2. Phase 2B1 deliberately
creates the stable URL and lifecycle contract first so later source-page hooks
consume one tested navigation model rather than inventing target-specific query
parameters independently.

## Destination read model

Every `ReferenceResolution` receives:

```text
destination
- referenceUrl
- mode
- openSourceUrl
- contextOpenSourceUrls[]
```

### Fields

- `referenceUrl` is always the canonical stable-ID URL for the target, including
  `not_found`, `inconsistent`, and `tombstoned` results.
- `mode` is `source` only when the source itself is active and at least one
  active context can open an existing source interface. Otherwise it is
  `archived`.
- `openSourceUrl` is present only when all currently openable contexts collapse
  to one unique source destination.
- `contextOpenSourceUrls` is positional: entry `n` belongs to resolution
  context `n`. An archived or structurally unsupported context receives
  `null` rather than an unsafe link.

The destination model contains application paths only. It never contains an R2
key, managed-storage identifier, provider locator, credential, or temporary
URL.

## Canonical URL contract

The canonical form is:

```text
/references/<target-type>/<percent-encoded-stable-id>
```

The closed v1 target-type list remains authoritative:

```text
sample
run
run_step
comment
comment_occurrence
comment_attachment
execution_image
metrology_reference
recipe_revision
```

Unknown types are rejected by the client page and remain rejected by the
resolver. IDs are encoded as one path segment; a slash or other reserved
character cannot alter the route shape.

The canonical reference URL is the exact object-level destination. Existing
source pages remain contextual workspaces and are linked from it when safe.

## Source-route mapping

The first slice maps active contexts onto the existing router without changing
source-page geometry:

| Target | Existing source destination |
|---|---|
| Sample | `/samples/:sampleId` |
| Run | `/processing/:sampleId?run=:runId` |
| Run Step | matching processing workspace and Run, with stable Step/reference query hints |
| Sample Comment | owning Sample, with stable reference query hint |
| Run-step Comment | matching processing workspace and Run, with Step/reference query hints |
| Comment occurrence | matching processing workspace and Run, with Step/reference query hint |
| Comment attachment | owning Sample or matching processing workspace, with reference query hint |
| Execution image | matching processing workspace and Run, with Step/reference query hint |
| Metrology reference | exact owning Recipe revision, with reference query hint |
| Recipe revision | exact `/templates/:revisionId` route |

Query parameters emitted in this PR are deterministic and forward-compatible.
Existing pages may ignore the focus hints until Phase 2B2; they already honor
Run selection. The canonical `/references/...` page therefore remains the exact
and refresh-safe object destination during this transition.

## Multi-context targets

A common Comment or its attachment can belong to several Run Steps. The system
must not choose one context arbitrarily.

For a multi-context result:

- contexts retain resolver order;
- `contextOpenSourceUrls` has the same length and ordering;
- active contexts receive their own links;
- deleted or archived contexts receive `null`;
- `openSourceUrl` is `null` when more than one unique active destination exists;
- the reference page lists every context separately.

Duplicate contexts that resolve to the same source URL may collapse to one
`openSourceUrl`, but the ordered context list is not deduplicated.

## Lifecycle rules

### Active source and active context

The destination mode is `source`. The page shows source metadata and one source
button or a list of context buttons.

### Active source with mixed active and deleted contexts

The destination remains usable. Active contexts receive links; deleted contexts
remain visible as read-only paths with no ordinary-source link.

### Deleted or archived source

The destination mode is `archived`. The canonical reference page shows the
resolved summary, lifecycle state, and path read-only. It does not forward to an
ordinary route that can hide the source.

### Deleted or archived ancestor

A target under a deleted Run or Sample remains resolved but is presented through
the archived destination. Its full context remains visible.

### `not_found`

The canonical route remains valid and reports that no source and no registry
tombstone are available. It offers no source link.

### `inconsistent`

The route reports the integrity condition and displays last-known contexts when
available. It offers no source link that could imply the object is valid.

### `tombstoned`

The route displays only the resolver-provided last-known contexts and tombstone
state. It does not retain or reconstruct permanently deleted source content.

## Frontend behavior

`ReferencePage` is a small, lazy-loaded route. It:

1. validates the route target type;
2. resolves exactly one target through `POST /api/references/resolve`;
3. renders the source summary and lifecycle state read-only;
4. renders ordered context segments and their individual lifecycle metadata;
5. provides `Open source` only when `openSourceUrl` is safe;
6. provides `Open context` for each safe multi-context destination;
7. explains archived, missing, inconsistent, and tombstoned states; and
8. exposes no edit, restore, delete, retry, upload, or source mutation action.

The page uses existing typography, card, button, and semantic-status tokens. Its
new stylesheet is route-scoped and must not change Process-grid, Sample,
Template, modal, or navigation geometry.

## Backend integration

The shared destination builder accepts only:

- target identity;
- resolver status;
- resolved source lifecycle metadata; and
- ordered contexts.

It performs no D1 query and no write. `resolveReferences()` attaches its output
after normal adapter and registry resolution, preserving the existing bounded
query count and read-only behavior.

Because the builder is pure and shared, future Project cards, search results,
Text, Inspector, and Map can consume the same URL contract without duplicating
router logic.

## Verification

Focused tests must cover:

- canonical URL generation and path-segment encoding;
- all nine v1 target types;
- Sample, Run, Step, Sample-Comment, Run-step-Comment, occurrence, attachment,
  execution-image, metrology-reference, and Recipe destinations;
- deterministic query-parameter ordering;
- multi-context order and `openSourceUrl` ambiguity;
- duplicate source URLs across contexts;
- mixed active/deleted contexts;
- source deletion, source archival, and deleted ancestors;
- `not_found`, `inconsistent`, and `tombstoned` destinations;
- locator non-disclosure;
- the `/references/:type/:id` route and read-only page contract; and
- inclusion in `test:reference-foundation`, CI, and the v3 deployment gate.

Repository checks remain:

```text
npm run test:reference-foundation
npm run verify:reference-foundation
npm test
npm run build
```

No remote migration or deployment command is run from this branch.

## Completion criteria

Phase 2B1 is complete when:

1. every v1 target receives one percent-encoded canonical reference URL;
2. destination construction is shared and pure;
3. resolver query count and source adapters are unchanged;
4. active single-context targets expose one safe source URL;
5. multi-context targets preserve ordered independent destinations;
6. deleted or archived sources and ancestors remain readable at the canonical
   reference route without unsafe forwarding;
7. missing, inconsistent, and tombstoned targets have explicit read-only states;
8. no destination leaks a physical storage locator;
9. the new page introduces no source mutation capability;
10. focused, full-suite, TypeScript, Worker, and client build checks pass; and
11. the Draft PR targets only `v2/backend-foundation`.

## Next Phase 2B slice

Phase 2B2 integrates the stable focus hints into mature source interfaces:

1. focus and center an exact Run Step without changing normal grid behavior;
2. expand and highlight a referenced Comment occurrence;
3. open an attachment or execution image in a context-preserving preview;
4. focus a metrology reference inside its exact Recipe revision;
5. add browser-level refresh/back/forward coverage for those focus states; and
6. then mark Phase 2B complete before deterministic search begins.

This ordering keeps the large Process-grid change isolated behind an already
reviewed URL and lifecycle contract.