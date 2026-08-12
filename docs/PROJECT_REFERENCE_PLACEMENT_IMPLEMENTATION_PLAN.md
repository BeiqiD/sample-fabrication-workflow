# Project reference placement implementation plan

Status: Phase 3B2 implementation complete in PR #134; independent review passed and merge-ready

Last reviewed: 2026-08-12 after Phase 3B1 desktop Map kernel was squash-merged in PR #133 and Phase 3B2 completed independent exact-head review

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
- a single pending reference ghost node while authoritative insertion is in flight or its result is being reconciled;
- exact retry for uncertain insertion failures using the same IDs, Project revision, geometry, and operation ID;
- explicit reconciliation before an uncertain insertion may be cancelled;
- explicit conflict handling rather than last-write-wins insertion;
- repeated occurrences of the same stable target through distinct Project item and placement IDs;
- Project-local occurrence removal from Inspector without deleting or editing source data;
- exact retry of an uncertain removal with the same lifecycle request and operation ID;
- authoritative reconciliation for deterministic removal conflicts/not-found responses instead of replaying a stale DELETE forever;
- mandatory geometry-save drain before a confirmed uncertain-insertion cancellation may start its Project-local DELETE;
- Map geometry freeze while a cancellation reconciliation or Project-local removal result is unresolved;
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
  openSourceUrl
}
```

The preview is display/navigation data only. `referenceUrl` is the canonical Reference destination and `openSourceUrl` is an optional display-safe direct source destination already supplied by the resolver. Neither field is a storage locator.

The payload must not contain:

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

### Known non-commit failure

A client-visible rejection may be discarded only when its result is known not to have committed the requested occurrence. The current frontend treats ordinary non-retryable 4xx validation failures and structural `409` conflicts as known server responses rather than transport uncertainty.

For a known non-commit validation failure:

- keep the ghost visible in `error` state until the user retries or cancels;
- direct Cancel may discard that local ghost because the server response proves the request was rejected;
- starting a later placement creates new Project identities and a new operation ID.

A `409` is not retried with a guessed Project revision. The ghost enters `conflict` state and offers authoritative reload or cancellation of the rejected attempt. If unrelated placement geometry is not safely `Saved`, authoritative reload remains disabled so a structural conflict cannot overwrite a local geometry draft.

### Uncertain failure and cancellation reconciliation

A transport exception, `5xx`, timeout-style `408`, or rate-limit-style `429` is an **uncertain result**. The request may already have committed before the response became unavailable.

For an uncertain result:

- keep the ghost visible in `uncertain` state;
- preserve the complete original create request;
- `Retry` replays exactly the same item ID, placement ID, expected Project revision, geometry, target, and operation ID;
- do **not** expose direct Cancel;
- cancellation first enters `reconciling` and exact-replays the original create request;
- if exact replay returns the canonical occurrence, record the confirmed item identity but do **not** start its cancellation DELETE while unrelated geometry is Unsaved or Saving;
- if exact replay returns a structural conflict, perform a read-only authoritative Project snapshot check without installing that snapshot over local geometry;
- only when the original item identity is absent may the transient ghost be discarded directly;
- if the original item identity exists, remove it only when its item type, placement identity, and resolved target match the original request;
- if identity cannot be reconciled safely, retain an explicit conflict and require authoritative reload rather than deleting an unknown occurrence.

Once cancellation has confirmed that the occurrence exists, it adopts the same prerequisite as an ordinary user-initiated removal: **all pre-existing placement geometry must first reach `Saved`**.

- if geometry is `Unsaved`, cancellation immediately flushes it;
- if a placement PATCH is already `Saving`, cancellation waits for that request and any follow-up dirty geometry to drain;
- while this drain is pending, the reference remains in `reconciling`, Map geometry interaction is frozen, and no cancellation DELETE is sent;
- only after there is no dirty placement state and no placement PATCH in flight may the Project-local DELETE begin;
- if the placement save enters `Error` or `Conflict`, the cancellation intent remains pending and the user must retry or resolve that geometry state first; the DELETE is not sent and no DELETE reconciliation snapshot may overwrite the local geometry;
- if the user resolves a geometry conflict by explicitly loading authoritative state, that explicit resolution may clear the cancellation intent and expose the confirmed occurrence from the authoritative snapshot for a later normal removal.

A cancellation DELETE or its reconciliation can itself have an uncertain or deterministic failure. Those cases follow the Project-local occurrence removal contract below. The crucial ordering invariant is:

```text
confirm occurrence
→ drain existing geometry to Saved
→ start cancellation DELETE
→ reconcile DELETE only if needed
```

This is the bounded frontend counterpart to the Phase 3A2 backend replay contract: uncertain failure never means "not committed", and cancellation never makes an authoritative structural reload eligible while unsaved geometry still exists.

## Existing dirty placement interaction

Reference insertion does not reuse the placement Save operation and must not mutate existing placement baselines.

Existing moved/resized nodes may remain dirty while a reference insertion runs because:

- Project structural insertion uses `projects.revision`;
- geometry updates use each `project_map_placements.revision`;
- the backend does not use one global Project lock for placement updates.

A successful insertion merges only the new item/placement and updated Project row into local state. It must not call the Phase 3B1 snapshot installer in a way that discards unrelated dirty geometry, undo/redo history, pending placement mutations, or navigation protection.

For uncertain-insertion cancellation, confirmation of the server-side occurrence does **not** relax this rule. The cancellation intent freezes additional geometry commands and drains the existing placement state through the ordinary Phase 3B1 save controller. A follow-up DELETE can begin only from `Saved`. Therefore any later deterministic DELETE reconciliation may safely install authoritative structure without silently discarding an unsaved placement draft.

Navigation protection covers unresolved placement-save state, a pending reference insertion/reconciliation, and an unresolved Project-local removal. A normal internal navigation cannot proceed until all three mutation domains are in a safe state. Hard refresh/close uses the same unresolved-reference/removal state in `beforeunload` protection.

## Pending ghost contract

The ghost is React Flow renderer state only and is never persisted as a special row.

It shows:

- reference kind;
- preview title/subtitle;
- placement status (`Placing`, `Reconciling`, `Outcome uncertain`, `Retry required`, or `Conflict`);
- the requested geometry.

It is non-draggable, non-resizable, non-connectable, and excluded from Reading until the authoritative mutation succeeds.

A known non-commit failure may be cancelled locally. An uncertain result may **not** be cancelled locally: the original operation must first be replayed/reconciled. If that proves an occurrence committed, the ghost remains as reconciliation state while existing geometry is drained to `Saved`; only then may the normal Project-local lifecycle operation remove the confirmed occurrence.

## Open-reference behavior

Reference node body remains a selection target.

Navigation is an explicit action:

- an `Open reference` control appears when a reference node is hovered, selected, or keyboard-focused;
- the control is `nodrag nopan` and does not initiate node movement;
- Inspector retains its existing `Open reference` action;
- Project search result links remain explicit controls and do not place an occurrence.

## Project-local occurrence removal

Phase 3B2 exposes `Remove from Project` for an active reference occurrence.

Removal begins only when ordinary placement state is safely `Saved` and captures one complete lifecycle request containing the expected item revision and one operation ID. **This Saved prerequisite applies equally to an internal cancellation removal after uncertain insertion reconciliation.** Internal cancellation first queues the confirmed occurrence, drains any existing placement PATCH/dirtiness to `Saved`, and only then creates and sends the DELETE request.

Removal failures are split by whether the DELETE outcome is uncertain or deterministic:

### Uncertain DELETE outcome

Transport failures, `5xx`, `408`, and `429` remain **uncertain** because the deletion may already have committed before the response was lost.

For these failures:

- retain the complete original lifecycle request;
- `Retry exact removal` sends the same item endpoint, expected item revision, and operation ID;
- do not create a new operation ID;
- rely on the Phase 3A2 deletion-operation replay contract if the first DELETE committed;
- keep Map interaction and navigation frozen/protected until the result is authoritative.

### Deterministic DELETE conflict or not-found

A deterministic non-timeout 4xx response such as `409` or `404` is **not** exact-retried forever. The stale request cannot be repaired by changing its revision or guessing a new operation.

The page immediately enters `reconciling` and performs an authoritative Project read. Because every DELETE—including an internal cancellation DELETE—can start only after geometry is safely `Saved`, this authoritative read is never permitted to overwrite an unsaved placement draft.

- if the occurrence is absent from the active snapshot, synchronize the page to that snapshot and treat the occurrence as already removed elsewhere;
- if the occurrence is still active but its revision/state changed, synchronize the page to that latest snapshot, clear the old removal request, unfreeze Map interaction, and require a new explicit `Remove from Project` action before any fresh DELETE is created;
- the new user-confirmed removal, if requested, uses the authoritative current item revision and a **new** operation ID;
- if the Project read itself returns `404`, clear the unresolved deletion state and show the Project as unavailable;
- if authoritative reconciliation cannot be completed because the read fails for another reason, retain a `conflict` reconciliation state and offer `Retry reconciliation`; do not replay the stale DELETE.

This split ensures a stale revision conflict cannot trap the page in an infinite exact-retry loop while still preserving exact replay for genuinely uncertain deletion outcomes.

For every successful Project-local removal:

- remove only the Project occurrence and its active Map projection;
- never delete, archive, edit, or tombstone the source object;
- preserve recoverable Project lifecycle semantics from Phase 3A2.

From the moment an actual removal starts until it is authoritatively completed or reconciled, the whole Map geometry interaction is frozen. The pre-DELETE drain used by uncertain-insertion cancellation also freezes new geometry commands. Persisted nodes cannot be dragged, keyboard-moved, resized, or mutated through undo/redo; placement Save/Reload actions and reference placement are disabled except for the save/reconciliation actions specifically required to resolve an already pending cancellation. Runtime guards reject geometry callbacks even if a renderer event races the UI disable state.

The unresolved removal or queued cancellation removal also participates in internal-navigation and `beforeunload` protection.

On successful removal, the page removes that occurrence's placement baseline, local geometry, pending placement mutation, connected local edges, and undo/redo commands. It then clears stale geometry error/conflict text and recomputes dirty state from the remaining placements. If nothing else is dirty the page returns to `Saved`; unrelated dirty geometry remains `Unsaved` and follows the normal Phase 3B1 save path.

## Mobile boundary

Mobile remains a no-creation projection in Phase 3B2.

A newly committed desktop reference occurrence appears on mobile automatically through its immutable `createdSequence`. Mobile may open the reference, but it does not search-and-place, drag, create, resize, or remove Map occurrences in this phase.

## Tests and permanent gate

The dedicated `verify:project-reference-placement` gate covers:

- versioned drag payload contains only target plus display-safe preview;
- drag start performs no Project write;
- real Map drop converts browser position through React Flow to an exact logical point;
- `Place at Map center` uses the same coordinate/geometry helper;
- pending ghost appears before the authoritative response and Reading does not include it;
- success commits exactly one occurrence and one placement and advances Project revision;
- the same target can be placed twice as two distinct occurrences;
- uncertain retry reuses the exact insertion request and operation ID;
- a response-lost-after-commit insertion cannot be directly cancelled and is exact-replayed/reconciled before any Project-local removal;
- a confirmed uncertain-insertion cancellation with dirty or in-flight geometry sends no DELETE until the placement save reaches `Saved`;
- a cancellation DELETE `409` after that drain may reconcile authoritative structure without reverting the already-saved geometry;
- `409`/unavailable target never creates last-write-wins state;
- insertion during unrelated dirty geometry does not reset that geometry or undo history;
- reference conflict reload cannot overwrite unrelated unsaved geometry;
- node-body selection remains separate from explicit reference navigation;
- local occurrence removal never calls a source deletion endpoint;
- a deferred removal freezes geometry and cannot race a later placement PATCH;
- a response-lost removal exact-retries the same lifecycle request and operation ID;
- deterministic `409`/`404` removal responses enter authoritative reconciliation instead of replaying the stale request;
- an occurrence already removed by another operation disappears after authoritative reconciliation without a second stale DELETE;
- an occurrence whose item revision changed is reloaded at the new revision and can be removed only through a new user action with a new operation ID;
- unresolved insertion/removal participates in navigation protection;
- mobile remains no-creation;
- existing Phase 3B1 save/navigation regressions stay green;
- production bundle inspection still proves React Flow is desktop-lazy.

The permanent Verify workflow records this as:

```text
pre-pr/project-reference-placement
```

The dedicated ordinary script includes the removal failure classifier, and the dedicated mounted script explicitly includes the reference search/drop/placement tests plus the navigation-safety and removal-safety suites; those tests do not rely only on the complete test wildcards for coverage.

All existing blob, Reference, Project foundation, Project persistence, Project Map, complete test, and build contexts must also remain green on the exact PR head.

## Completion record

Independent review confirmed the Phase 3B2 Ready criteria:

- search remains read-only before placement;
- no half-created occurrence can survive insertion failure;
- uncertain insertion cancellation reconciles server state before discarding local state;
- a confirmed cancellation removal cannot begin until pre-existing placement geometry is fully Saved, including any in-flight PATCH drain;
- retries preserve exact mutation identity for uncertain create and remove operations;
- deterministic removal conflicts reconcile authoritative state without guessing a revision or reusing a stale DELETE indefinitely;
- repeated references work;
- drop coordinates remain correct under pan/zoom;
- dirty Phase 3B1 geometry cannot be lost during insertion/removal or cancellation reconciliation;
- removal cannot race geometry mutation and cannot leave a stale save conflict after success;
- no source mutation is performed by Project-local removal;
- mobile creation remains excluded;
- the permanent `pre-pr/project-reference-placement` gate and all previous gates are green on the final reviewed implementation head.

With PR #134 squash-merged, Phase 3B2 is complete and Phase 3B3 — Project-owned Markdown and generic attachment creation — is the immediate next implementation PR.