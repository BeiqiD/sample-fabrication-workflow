# Project reference placement implementation plan

Status: active Phase 3B2 implementation contract

Last reviewed: 2026-08-11 after Phase 3B1 desktop Map kernel was squash-merged in PR #133

This document defines the bounded Phase 3B2 implementation for Project-owned reference discovery and authoritative Map placement. The durable product contract remains in [PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md), while the authoritative Project mutation semantics remain in [PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md](./PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md).

## Goal

A desktop user must be able to stay inside one Project, search any supported source object through the existing deterministic Reference search surface, place a new occurrence at an exact Map coordinate or at the current viewport center, reopen the Project, and remove that local occurrence without mutating the source object.

Phase 3B2 is the first useful Project reference-workspace alpha. It does not create a second search implementation and it does not create a frontend graph document.

## Delivered boundary

Phase 3B2 adds:

- the existing `ReferenceSearchSurface` inside the Project operation/sidebar area;
- a Project placement mode for deterministic search results;
- desktop drag payloads containing only the stable `ReferenceTarget` and bounded display-safe preview data;
- exact-coordinate Map drops converted through the live React Flow viewport;
- a keyboard-accessible `Place at Map center` action using the same placement path;
- a single pending reference ghost node while authoritative insertion is in flight;
- retry for uncertain insertion failures using the exact same IDs, Project revision, geometry, and operation ID;
- explicit conflict handling rather than last-write-wins insertion;
- repeated occurrences of the same stable target through distinct Project item and placement IDs;
- Project-local occurrence removal from Inspector without deleting or editing source data;
- automatic appearance of every committed occurrence in the existing creation-sequence mobile/Reading projection.

## Deliberately deferred

Phase 3B2 does not add:

- Project-owned Markdown creation or editing changes;
- Project-owned attachment upload/creation;
- edge authoring;
- full mobile creation or Map interaction;
- rich Inspector editing;
- relation taxonomies, groups, collaboration, or permanent delete;
- a second Reference search endpoint, ranking model, or client-side scoring layer;
- remote D1 migrations or deployment.

No schema migration is required. Phase 3A2 already exposes the authoritative `POST /projects/:projectId/items/reference` and recoverable item-lifecycle routes needed by this phase.

## Search ownership

Reference search remains read-only and source-owned.

`ReferenceSearchSurface` continues to:

- submit only explicit committed searches;
- render server ranking without client-side reordering;
- return stable `ReferenceTarget` identities;
- perform no Project write during typing, search, selection, hover, or drag start.

Phase 3B2 adds a placement mode rather than copying search logic into Project. The standalone `/search` page remains an integration harness, while Project becomes the primary host for placement-oriented discovery.

## Drag payload contract

The custom desktop drag payload is versioned and bounded. It contains only:

```text
version
ReferenceTarget { type, id }
preview {
  title
  subtitle
  excerpt
  referenceUrl
}
```

The preview is display/navigation data only. It must not contain:

- registry IDs;
- R2 keys;
- managed-storage provider/object keys;
- source-table row blobs;
- Project IDs, item IDs, placement IDs, revisions, or operation IDs.

Project identity and mutation IDs are generated only when an actual placement command is accepted.

## Coordinate contract

A placement command supplies a logical Map point. Both drop and center-placement use the same deterministic node geometry helper.

The initial reference card size is:

```text
width  = 300
height = 180
```

The requested Map point is the visual center of the new card, so persisted top-left placement is:

```text
x = point.x - width / 2
y = point.y - height / 2
```

Map drops convert browser `clientX/clientY` through React Flow `screenToFlowPosition`. `Place at Map center` takes the visible Map container center in browser coordinates and passes it through the same conversion. Both paths therefore remain correct under pan and zoom.

The resulting geometry must still pass the shared Project geometry bounds before a request is sent.

## Authoritative insertion state machine

At most one new reference insertion is active at a time in the first implementation. This avoids guessing around the Project-owned creation-sequence revision while preserving repeated sequential occurrences.

A placement command proceeds as follows:

1. capture the selected stable target, display-safe preview, requested Map point, and current authoritative Project revision;
2. generate stable client IDs for item, placement, and operation;
3. create one local ghost node in `placing` state;
4. call `POST /projects/:projectId/items/reference` with the generated IDs, target, geometry, expected Project revision, and operation ID;
5. the backend re-resolves the target and atomically registers/refreshes the registry row, reserves creation sequence, creates the item occurrence, and creates placement;
6. on success, replace the ghost with the returned canonical item/placement and advance the local authoritative Project revision;
7. select the new occurrence.

No Project or registry row is written before step 4.

### Successful insertion

The server mutation response is authoritative for:

- Project revision;
- item ID and immutable creation sequence;
- item revision;
- placement ID, geometry, and placement revision;
- replay status.

The search result supplies only immediate display-safe reference preview data until the next canonical Project read. Reopening the Project resolves the source again through the registry/resolver path.

The insertion must not reset or overwrite unrelated existing placement draft state. Project revision ownership and placement revision ownership remain separate.

### Uncertain failure

For a network/transport or 5xx-style uncertain result:

- keep the ghost visible in `error` state;
- preserve the exact request payload;
- `Retry` reuses the same item ID, placement ID, expected Project revision, geometry, and operation ID;
- `Cancel` removes only the local ghost;
- no new operation ID is generated until the user starts a genuinely new placement.

This matches the bounded backend replay contract.

### Conflict or unavailable reference

A `409` is not retried with a guessed revision.

The ghost enters `conflict` state and offers:

- reload authoritative Project state; or
- cancel the uncommitted ghost and search/place again.

If the source became unavailable between search and placement, the backend rejects insertion and no Project item/placement survives the rollback-safe transaction.

## Existing dirty placement interaction

Reference insertion does not reuse the placement Save operation and must not mutate existing placement baselines.

Existing moved/resized nodes may remain dirty while a reference insertion runs because:

- Project structural insertion uses `projects.revision`;
- geometry updates use each `project_map_placements.revision`;
- the backend does not use one global Project lock for placement updates.

A successful insertion merges only the new item/placement and updated Project row into local state. It must not call the Phase 3B1 snapshot installer in a way that discards unrelated dirty geometry, undo/redo history, pending placement mutations, or navigation protection.

Navigation protection continues to consider only unresolved placement-save state. An active or failed reference ghost is local transient creation state and must also prevent accidental Project navigation until it is completed or explicitly cancelled.

## Pending ghost contract

The ghost is React Flow renderer state only and is never persisted as a special row.

It shows:

- reference kind;
- preview title/subtitle;
- placement status (`Placing`, `Retry required`, or `Conflict`);
- the requested geometry.

It is non-draggable, non-resizable, non-connectable, and excluded from Reading until the authoritative mutation succeeds.

Failure may keep the marked ghost so the user can retry or cancel. A cancelled ghost disappears with no server delete because it was never committed.

## Open-reference behavior

Reference node body remains a selection target.

Navigation is an explicit action:

- an `Open reference` control appears when a reference node is hovered, selected, or keyboard-focused;
- the control is `nodrag nopan` and does not initiate node movement;
- Inspector retains its existing `Open reference` action;
- Project search result links remain explicit controls and do not place an occurrence.

## Project-local occurrence removal

Phase 3B2 exposes `Remove from Project` for an active reference occurrence.

Removal:

- calls the existing Project item lifecycle endpoint with the item-owned expected revision and a new operation ID;
- removes only the Project occurrence and its active Map projection;
- never deletes, archives, edits, or tombstones the source object;
- preserves recoverable Project lifecycle semantics from Phase 3A2;
- surfaces `409` conflicts explicitly and retains the local occurrence until authoritative state is reloaded or a later valid removal is attempted.

If an existing placement save is in flight or dirty for the selected occurrence, removal is disabled until that placement state becomes safely Saved so a deleted occurrence cannot race a later placement PATCH from the same page session.

## Mobile boundary

Mobile remains a no-creation projection in Phase 3B2.

A newly committed desktop reference occurrence appears on mobile automatically through its immutable `createdSequence`. Mobile may open the reference, but it does not search-and-place, drag, create, resize, or remove Map occurrences in this phase.

## Tests and permanent gate

A dedicated `verify:project-reference-placement` gate must cover:

- versioned drag payload contains only target plus display-safe preview;
- drag start performs no Project write;
- real Map drop converts browser position through React Flow to an exact logical point;
- `Place at Map center` uses the same coordinate/geometry helper;
- pending ghost appears before the authoritative response and Reading does not include it;
- success commits exactly one occurrence and one placement and advances Project revision;
- the same target can be placed twice as two distinct occurrences;
- uncertain retry reuses the exact insertion request and operation ID;
- `409`/unavailable target never creates last-write-wins state;
- insertion during unrelated dirty geometry does not reset that geometry or undo history;
- node-body selection remains separate from explicit reference navigation;
- local occurrence removal never calls a source deletion endpoint;
- mobile remains no-creation;
- existing Phase 3B1 save/navigation regressions stay green;
- production bundle inspection still proves React Flow is desktop-lazy.

The permanent Verify workflow records this as:

```text
pre-pr/project-reference-placement
```

All existing blob, Reference, Project foundation, Project persistence, Project Map, complete test, and build contexts must also remain green on the exact PR head.

## Ready boundary

The Phase 3B2 PR remains Draft until independent review confirms:

- search remains read-only before placement;
- no half-created occurrence can survive insertion failure;
- retries preserve exact mutation identity;
- repeated references work;
- drop coordinates remain correct under pan/zoom;
- dirty Phase 3B1 geometry cannot be lost during insertion/removal;
- no source mutation is performed by Project-local removal;
- mobile creation remains excluded;
- exact-head CI is green.

After squash merge, Phase 3B2 is complete and Phase 3B3 — Project-owned Markdown and generic attachment creation — becomes the immediate next implementation PR.
