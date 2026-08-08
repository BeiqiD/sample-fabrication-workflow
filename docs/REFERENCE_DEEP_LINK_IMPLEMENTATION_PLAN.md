# Reference deep-link implementation plan

Status: completed Phase 2B1 record; PR #128 completes Phase 2B2 and closes Phase 2B on merge

Last reviewed: 2026-08-08 after PR #128 source-focus review

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

Before PR #127, the integration branch provided:

- stable IDs for every current referenceable source and occurrence;
- recoverable deletion for Samples, Runs, Run Steps, Comments, attachment
  occurrences, execution images, metrology references, and Recipe revisions;
- a sparse, immutable `reference_targets` registry;
- bounded batch resolution for all nine v1 target types;
- lifecycle metadata for the source and every context segment;
- one authenticated core Worker middleware stack; and
- host-SQLite plus real local D1/workerd coverage of the resolver.

The remaining Phase 2B boundary was navigation. Consumers could resolve a
target but could not obtain one stable object URL or a safe destination when the
source or an ancestor was deleted or archived.

PR #127 completed Phase 2B1 by adding a versioned opaque canonical route,
lifecycle-aware destination fields, and a generic read-only Reference page. PR
#128 completes Phase 2B2 by consuming those destinations in the existing source
interfaces, including exact object focus, read-only previews, stable execution
occurrence media, and browser-history restoration.

## Pull-request boundary

This PR targets `v2/backend-foundation` and establishes lifecycle-aware,
refresh-safe reference destinations.

### Included

1. one canonical route for every current reference target:
   `/references/:type/:encodedId`;
2. a shared, versioned, reversible route codec that preserves the exact stable
   ID independently of browser and React Router decoding;
3. a shared, pure destination builder used by the Worker and covered
   independently from React routing;
4. a destination object added to every reference-resolution result;
5. deterministic links to the closest existing source interface when that
   existing route can preserve source identity safely;
6. ordered per-context links for targets with more than one valid context;
7. a generic read-only reference page for active, deleted, archived,
   inconsistent, missing, and tombstoned results;
8. explicit lifecycle or identity-safe read-only messaging instead of
   forwarding references into ordinary source routes that may return `404` or
   decode to a different ID;
9. focused contract tests included in the existing reference-foundation and
   deployment gates; and
10. documentation of the remaining object-focus work.

### Excluded

- schema or migration changes;
- restricting the existing stable-ID grammar merely to simplify routing;
- a repository-wide migration of all ordinary Sample and Template URLs to the
  opaque codec;
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
  active context can open an existing source interface without changing
  identity. Otherwise it is `archived`, which is the existing two-value
  read-model vocabulary for the canonical read-only fallback; it does not by
  itself assert that the source row has `archived_at` set.
- `openSourceUrl` is present only when all currently openable contexts collapse
  to one unique source destination.
- `contextOpenSourceUrls` is positional: entry `n` belongs to resolution
  context `n`. A deleted, archived, structurally unsupported, or path-unsafe
  context receives `null` rather than an unsafe link.

The destination model contains application paths only. It never contains an R2
key, managed-storage identifier, provider locator, credential, or temporary
URL.

## Canonical URL and route-codec contract

The canonical route pattern is:

```text
/references/<target-type>/<encoded-id>
```

The current encoded-ID form is:

```text
r1_<unpadded-base64url-of-UTF-16BE-code-units>
```

`r1_` is a version prefix. The payload encodes the exact JavaScript string as
ordered UTF-16 code units, two bytes per code unit, before applying canonical
unpadded base64url. This deliberately avoids `encodeURIComponent` and preserves
the full stable-ID identity currently allowed by the resolver contract,
including reserved characters, Unicode, literal percent sequences, and dot
segments.

The shared functions are equivalent to:

```text
encodeReferenceRouteId(id) -> encodedId
decodeReferenceRouteId(encodedId) -> id | null
```

The decoder rejects:

- an unknown version prefix;
- non-base64url characters;
- an impossible base64url length;
- an odd decoded byte count; and
- any non-canonical representation that does not re-encode to the same segment.

Consequently:

- `.` and `..` never become browser dot segments;
- `/`, `%2F`, and literal slash-containing IDs remain distinct;
- `?` and `#` never become query or fragment delimiters;
- spaces and Unicode remain exact;
- two different stable IDs cannot share one canonical URL; and
- browser normalization plus React Router parameter matching round-trip to the
  original ID before resolver invocation.

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
resolver. The canonical Reference route decodes the opaque segment first and
then applies the same runtime target validation as the resolver.

## Existing source-route safety

The canonical reference URL is the exact object-level destination. Existing
source pages remain contextual workspaces and are linked from it only when their
current route grammar can preserve identity.

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

The ordinary Sample, Processing, and Template routes predate this codec and use
raw React Router path parameters. PR #127 therefore emits those path segments
only for the conservative identity-safe grammar:

```text
[A-Za-z0-9_-]+
```

This includes current UUID-style production IDs. A Sample or Recipe ID outside
that grammar receives no ordinary-source link; the exact canonical Reference
page remains available. This is fail-closed behavior, not a silent character-set
restriction on resolver, registry, import, restore, or database identity.

Run IDs, Step IDs, and reference hints are query parameters rather than path
segments. They are emitted through `URLSearchParams` and are regression-tested
to round-trip literal percent sequences, slashes, spaces, delimiters, and
Unicode exactly.

Before Phase 2B2, existing pages could ignore the Step/reference focus hints;
they already honored Run selection. The canonical `/references/...` page
therefore remained the exact and refresh-safe object destination during that
transition.

## Multi-context targets

A common Comment or its attachment can belong to several Run Steps. The system
must not choose one context arbitrarily.

For a multi-context result:

- contexts retain resolver order;
- `contextOpenSourceUrls` has the same length and ordering;
- active and identity-safe contexts receive their own links;
- deleted, archived, unsupported, or path-unsafe contexts receive `null`;
- `openSourceUrl` is `null` when more than one unique active destination exists;
- the reference page lists every context separately.

Duplicate contexts that resolve to the same source URL may collapse to one
`openSourceUrl`, but the ordered context list is not deduplicated.

## Lifecycle and read-only rules

### Active source and active, identity-safe context

The destination mode is `source`. The page shows source metadata and one source
button or a list of context buttons.

### Active source with mixed active and deleted contexts

The destination remains usable. Active identity-safe contexts receive links;
deleted contexts remain visible as read-only paths with no ordinary-source link.

### Active source with a path-unsafe existing source route

The canonical Reference page remains exact and read-only. No ordinary-source
link is emitted because the legacy source route would not be proven to preserve
the stable ID.

### Deleted or archived source

The destination mode is `archived`. The canonical reference page shows the
resolved summary, lifecycle state, and path read-only. It does not forward to an
ordinary route that can hide the source.

### Deleted or archived ancestor

A target under a deleted Run or Sample remains resolved but is presented through
the read-only canonical destination. Its full context remains visible.

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

1. matches `/references/:type/:encodedId`;
2. decodes and canonical-validates the opaque ID before constructing a target;
3. validates the route target type and normal stable-ID shape;
4. resolves exactly one target through `POST /api/references/resolve`;
5. renders the source summary and lifecycle state read-only;
6. renders ordered context segments and their individual lifecycle metadata;
7. provides `Open source` only when `openSourceUrl` is safe;
8. provides `Open context` for each safe multi-context destination;
9. explains archived, missing, inconsistent, tombstoned, and other read-only
   states; and
10. exposes no edit, restore, delete, retry, upload, or source mutation action.

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

Because the builder and route codec are pure and shared, future Project cards,
search results, Text, Inspector, and Map can consume the same URL contract
without duplicating router logic.

## Verification

Focused tests cover:

- canonical opaque URL generation;
- encode/decode round-trip and collision resistance;
- `.`, `..`, `/`, `%2F`, `?`, `#`, internal spaces, Unicode, and literal versus
  decoded-looking percent sequences;
- browser URL normalization and real `matchRoutes` parameter matching;
- rejection of malformed or non-canonical encoded segments;
- all nine v1 target types;
- Sample, Run, Step, Sample-Comment, Run-step-Comment, occurrence, attachment,
  execution-image, metrology-reference, and Recipe destinations;
- deterministic query-parameter ordering and exact query-value round-trip;
- fail-closed Sample and Recipe path handling on legacy source routes;
- multi-context order and `openSourceUrl` ambiguity;
- duplicate source URLs across contexts;
- mixed active/deleted contexts;
- source deletion, source archival, and deleted ancestors;
- `not_found`, `inconsistent`, and `tombstoned` destinations;
- locator non-disclosure;
- the `/references/:type/:encodedId` route and read-only page contract;
- opaque-ID requests through the real local Worker/D1 workerd smoke; and
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

1. every v1 target receives one versioned, opaque, one-to-one canonical
   reference URL;
2. the codec round-trips the complete allowed stable-ID identity through browser
   normalization and actual React Router matching without collisions;
3. destination construction and route encoding are shared and pure;
4. resolver query count and source adapters are unchanged;
5. active single-context targets expose one safe source URL when the existing
   source route can preserve its path identity;
6. unsafe existing source paths fail closed without narrowing the underlying
   stable-ID contract;
7. multi-context targets preserve ordered independent destinations;
8. deleted or archived sources and ancestors remain readable at the canonical
   reference route without unsafe forwarding;
9. missing, inconsistent, and tombstoned targets have explicit read-only states;
10. no destination leaks a physical storage locator;
11. the new page introduces no source mutation capability;
12. focused, full-suite, TypeScript, Worker, and client build checks pass; and
13. the Draft PR targets only `v2/backend-foundation`.

PR #127 satisfies Phase 2B1 after the canonical codec review correction. PR
#128 satisfies Phase 2B2 after correcting focus reapplication, Template loader
coupling, and the authenticated media boundary. Phase 2B is complete when #128
is merged.

## Next phase

Phase 2C implements deterministic search and reference insertion on top of the
closed resolver, canonical URL, lifecycle, source-focus, and media-safety
contracts. Project-owned data remains deferred until that search/read-model
boundary is reviewed.
