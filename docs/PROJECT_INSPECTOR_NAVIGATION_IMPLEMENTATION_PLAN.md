# Project Inspector and navigation implementation plan

Status: Phase 4A complete through PR #147; Phase 4B Canvas productivity is next

Last reviewed: 2026-08-17 after Phase 4A3 completion in PR #147

## Goal

Phase 4A completes Project inspection and navigation without changing the normalized occurrence, placement, edge, Reference, or Project-owned content models. The Inspector remains a projection over authoritative Project and source records. It does not become a second source editor or a frontend-owned metadata document.

## Architectural invariants

1. A Project item ID identifies one Project-local occurrence; it is not interchangeable with source identity, `reference_targets` identity, content identity, or placement identity.
2. The canonical Project resource remains `/projects/:projectId`. Exact occurrence focus is query navigation state: `/projects/:projectId?focus=<projectItemId>`.
3. Query values are generated with `URLSearchParams`. Valid path-like or Unicode IDs are never normalized as route segments.
4. Focus and inspection are read-only. They do not change Project revision, placement, item order, edge state, or source records.
5. `ProjectPage` owns authoritative selection. Map and Reading only project the requested focus.
6. Missing, trashed, malformed, or inaccessible occurrence links fail visibly; they never silently select another item or fall back as though navigation succeeded.
7. Child references continue through the existing Reference search, registry, resolver, and authoritative Project placement mutation path.

## Phase 4A1 — canonical occurrence links and exact focus

Status: complete in PR #145.

Delivered:

- strict `focus` query parsing and canonical link generation;
- exact one-shot selection and Map centering after authoritative snapshot load;
- exact Reading scroll/highlight using the same occurrence ID;
- Inspector `Copy stable link` with resolved clipboard success/failure state;
- explicit malformed-link and unavailable-occurrence states;
- unit and mounted regression coverage;
- no persistence, schema, or source mutation changes.

Exit: a copied occurrence link reopens the same active Project occurrence and focuses it in both projections without creating a new navigation identity model.

## Phase 4A2 — hierarchy, provenance, and type-specific inspection

Status: complete in PR #146.

Delivered:

- Project-local occurrence context, including creation sequence and local relationship summary;
- source hierarchy and provenance assembled from authoritative Reference resolution/context data;
- clear distinction between source identity, occurrence identity, and Project-owned content;
- type-specific details for Samples, Runs, Steps, Comments, attachments, execution images, metrology records, Markdown, and Project attachments;
- exact source-opening actions that reuse existing Reference destinations;
- media preview only where it materially improves routine inspection.

This slice must not cache editable source snapshots in Project rows.

Delivered implementation:

- derive one read-only Inspector projection directly from the authoritative `ProjectSnapshot`;
- show occurrence identity, creation sequence, revision, working placement geometry, and Project-local incoming/outgoing relationships;
- show Project-owned content identity separately from source identity and Reference registry identity;
- render source hierarchy from `ReferenceResolution.contexts`, including archived/deleted context markers and exact context destinations where available;
- render explicit type labels and state fields for every supported Reference target plus Markdown and Project attachment metadata;
- open the unique exact source destination when available and otherwise fall back to the canonical Reference record;
- preview Project-owned image attachments only; keep generic files as file actions and defer PDF/webpage preview work.

This implementation does not add persistence fields, source mutation, child-reference insertion, or editable source snapshots.

Exit: the Inspector exposes authoritative Project-local context, source hierarchy, provenance, type-specific details, and exact source navigation without creating a second source model.

## Phase 4A3 — authoritative child-reference insertion

Status: complete in PR #147.

Delivered:

- child/reference candidates derived through the existing referenceability rules;
- insertion actions that return a stable `ReferenceTarget` and use the existing Project placement transaction;
- repeated occurrences remain allowed;
- lifecycle and eligibility are checked authoritatively at insertion time;
- uncertain outcomes retain exact retry/reconciliation semantics;
- no Inspector-only write path or source mutation shortcut.

Delivered implementation:

- add one read-only, body-addressed Reference child endpoint so opaque source IDs never become route segments;
- enumerate only direct source children and preserve canonical Comment identity for submitted comments;
- resolve every candidate through the existing nine-type resolver and apply the same active-context eligibility rule used by Reference search;
- offer explicit, on-demand direct-child browsing inside the selected Reference Inspector without caching child metadata in Project rows;
- feed a selected child into the existing center-placement mutation, pending ghost, exact retry, reconciliation, and repeated-occurrence paths;
- re-resolve and recheck the same eligibility rule immediately before durable Project insertion;
- keep leaf references, Project-owned content, source mutation, recursive trees, and Inspector-specific persistence outside this slice.

Exit: the Inspector can enumerate authoritative direct children and place a selected
child through the existing Project occurrence transaction without introducing a
second identity, persistence, or retry model.

## Deferred candidates

PDF first-page thumbnails and captured webpage screenshots remain optional and
require separate utility/security justification. Live webpage iframes remain outside
the product contract. Phase 4B Canvas productivity and systematic Phase 5 visual
refinement remain separate follow-on tracks.
