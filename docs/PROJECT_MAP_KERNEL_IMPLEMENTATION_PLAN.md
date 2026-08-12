# Project Map kernel implementation record

Status: Phase 3B1 complete; squash-merged in PR #133. Phase 3B2 is active in Draft PR #134.

Last reviewed: 2026-08-12 after Phase 3A2 was squash-merged in PR #132, Phase 3B1 completed independent review and exact-head verification, PR #133 was squash-merged, and Phase 3B2 reference placement entered Draft review in PR #134

This document records the bounded Phase 3B1 implementation. The durable product
contract remains in
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md),
and the historical review gate remains in
[PROJECT_MAP_KERNEL_REVIEW_CHECKLIST.md](./PROJECT_MAP_KERNEL_REVIEW_CHECKLIST.md).

## Delivered boundary

The implementation adds:

- Project navigation plus list, create, and open routes;
- one normalized Project snapshot projection used by Map, Inspector, and the
  temporary mobile occurrence view;
- a desktop-only lazy boundary around `@xyflow/react`;
- pan, zoom, fit view, selection, lightweight node renderers, pointer movement,
  keyboard nudging, and border resize;
- explicit Save and a bounded 1.6-second autosave after completed semantic
  geometry changes;
- placement writes only after semantic geometry commands, explicit Save, or an
  autosave flush, never during live pointer frames;
- keyboard position changes promoted from React Flow renderer changes into the
  same geometry command/save/undo state machine used by pointer interactions;
- object-owned placement revisions and one operation ID per attempted semantic
  mutation, reused only when replaying the exact payload after an uncertain
  failure;
- client-session undo/redo commands for pointer moves, keyboard nudges, and
  resize changes;
- visible Saved, Saving, Unsaved, Error, and Conflict states;
- router-level dirty-navigation protection: Unsaved/Saving internal navigation
  safely drains all dirty geometry before proceeding and exposes no discard
  action, while Error/Conflict requires explicit user action rather than silent
  loss;
- page-lifecycle save generations that invalidate stale asynchronous completions
  so an unmounted or explicitly discarded Project session cannot schedule later
  autosaves or additional placement writes;
- `beforeunload` protection for hard refresh/close while placement state is not
  safely Saved;
- `409` handling that retains local unsaved geometry and requires an explicit
  authoritative reload or explicit discard before leaving;
- a lightweight read-only mobile occurrence projection ordered by immutable
  `createdSequence` plus item-ID tie-breaker.

The temporary standalone `/search` route remains as an integration harness, but
it is no longer a primary navigation destination. Phase 3B2 embeds the reusable
search surface in Project and owns reference insertion.

## State ownership

React Flow owns transient renderer interaction state only. The page controller
keeps:

```text
authoritative placement rows with revisions
+ current local geometry by placement ID
+ bounded undo and redo command stacks
+ save/conflict state
+ blocked navigation intent while placement state is dirty
```

A save computes placement deltas against the latest authoritative rows and
sends one compact `PATCH /projects/:projectId/placements/:placementId` mutation
per dirty placement. An uncertain failure retains that exact payload and
operation ID so Retry can use the backend's bounded replay contract. A
successful response replaces that placement's baseline and revision. Geometry
changed again during an in-flight request remains dirty. During ordinary editing
it is flushed through the next bounded save boundary; while navigation is
blocked waiting for persistence, it is drained immediately with a fresh
operation ID before navigation may proceed.

Pointer drag/resize frames stay renderer-local until drag stop/resize end.
React Flow keyboard position changes do not have a pointer stop event, so their
non-dragging position changes are promoted directly into semantic geometry
commands. Pointer interactions are marked while active so their frame events do
not create duplicate commands.

Internal SPA navigation uses the router blocker while any Project placement
state is Unsaved, Saving, Error, or Conflict. Unsaved/Saving has no discard
escape hatch: a normal dirty state first flushes, drains geometry created while
a request is in flight, and proceeds only after reaching Saved. Error/Conflict
keeps the attempted navigation blocked until the user stays, retries/resolves,
or explicitly leaves without saving. Each mounted Project page owns a save
generation; unmount or explicit discard invalidates that generation so a stale
request completion cannot update the old controller, schedule another autosave,
or issue a follow-up write. Hard refresh/close cannot safely await an
asynchronous PATCH, so `beforeunload` provides the corresponding browser
protection instead.

The Map projection preserves the identity split:

- `project_item.id` is the React Flow node and selection identity;
- `project_map_placements.id` is the mutation target;
- Project-owned content or a `reference_target` remains the rendered source.

No React Flow JSON document is persisted.

## Desktop and mobile loading

`ProjectPage` decides the presentation before rendering the lazy Map module.
Only the desktop branch imports `ProjectMapSurface`; that module alone imports
React Flow and its stylesheet. The production build must therefore emit a
separate `ProjectMapSurface` JavaScript chunk, and the initial application entry
must contain no React Flow runtime or stylesheet selectors.

The app entry uses a React Router data router only to provide durable navigation
blocking semantics to the existing route tree; the existing `App` route layout
remains the route owner and is not duplicated.

Mobile renders a deterministic, read-only occurrence list. It is deliberately
not the complete Phase 3C Reading projection and provides no creation, upload,
placement, resize, edge, or bulk Canvas controls.

## Deliberately deferred

Phase 3B1 did not add:

- a Project reference-search sidebar, drag/drop insertion, or pending nodes;
- Project-owned Markdown or attachment creation;
- Markdown editing or a rich editor dependency;
- Project-local edge authoring;
- the complete Reading projection;
- PDF preview, groups, collaboration, permanent delete, or deployment.

The first deferred item is now owned by Phase 3B2 Draft PR #134; the remaining
items stay in their later roadmap phases.

## Verification

The dedicated `verify:project-map` gate covers:

- normalized Map/Reading projection and occurrence identity;
- geometry delta and semantic undo/redo behavior;
- API conflict preservation and compact placement payloads;
- desktop lazy-import and semantic-boundary source contracts;
- a mounted real React Flow surface that verifies arrow-key movement produces a
  formal geometry command rather than renderer-only movement;
- mounted mobile ordering without Map initialization;
- mounted explicit-save, bounded autosave, retry replay, and `409` reload
  behavior;
- mounted internal-navigation safe flush, including a deferred in-flight save
  followed by more geometry that must drain before navigation;
- mounted stale-session invalidation proving an in-flight result cannot create
  follow-up writes after ProjectPage unmount;
- mounted refresh/close protection, save-error retry, and conflict/discard
  behavior;
- a production build plus bundle inspection proving React Flow remains in the
  separate desktop Map chunk.

CI records this as `pre-pr/project-map`. Existing blob, Reference, Project
foundation, Project persistence, complete test, and production-build gates must
also remain green on the exact PR head.

## Completion record and next boundary

PR #133 completed independent review, passed its permanent gates on the final
exact head, and was squash-merged into `v2/backend-foundation`. No remote D1
migration, Worker deployment, or production-data operation was part of the
Phase 3B1 merge.

Phase 3B2 — the reference sidebar and authoritative Map placement flow — is the
current implementation in Draft PR #134. Phase 3B3 becomes the immediate next
implementation PR only after #134 completes independent review and is merged.
