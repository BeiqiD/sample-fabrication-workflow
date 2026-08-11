# Project Map kernel implementation record

Status: Phase 3B1 implemented in Draft PR #133; independent review required

Last reviewed: 2026-08-11 against `v2/backend-foundation` after Phase 3A2 was
squash-merged in PR #132

This document records the bounded Phase 3B1 implementation. The durable product
contract remains in
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md),
and the review gate remains in
[PROJECT_MAP_KERNEL_REVIEW_CHECKLIST.md](./PROJECT_MAP_KERNEL_REVIEW_CHECKLIST.md).

## Delivered boundary

The Draft implementation adds:

- Project navigation plus list, create, and open routes;
- one normalized Project snapshot projection used by Map, Inspector, and the
  temporary mobile occurrence view;
- a desktop-only lazy boundary around `@xyflow/react`;
- pan, zoom, fit view, selection, lightweight node renderers, movement, and
  border resize;
- explicit Save and a bounded 1.6-second autosave after completed interactions;
- placement writes only at drag stop, resize end, explicit Save, or autosave
  flush, never during pointer frames;
- object-owned placement revisions and one operation ID per attempted semantic
  mutation, reused only when replaying the exact payload after an uncertain
  failure;
- client-session undo/redo commands recorded once per completed move or resize;
- visible Saved, Saving, Unsaved, Error, and Conflict states;
- `409` handling that retains local unsaved geometry and requires an explicit
  authoritative reload;
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
```

A save computes placement deltas against the latest authoritative rows and
sends one compact `PATCH /projects/:projectId/placements/:placementId` mutation
per dirty placement. An uncertain failure retains that exact payload and
operation ID so Retry can use the backend's bounded replay contract. A
successful response replaces that placement's baseline and revision. Geometry
changed again during an in-flight request remains dirty and is flushed with a
fresh operation ID through a later save boundary.

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

Mobile renders a deterministic, read-only occurrence list. It is deliberately
not the complete Phase 3C Reading projection and provides no creation, upload,
placement, resize, edge, or bulk Canvas controls.

## Deliberately deferred

Phase 3B1 does not add:

- a Project reference-search sidebar, drag/drop insertion, or pending nodes;
- Project-owned Markdown or attachment creation;
- Markdown editing or a rich editor dependency;
- Project-local edge authoring;
- the complete Reading projection;
- PDF preview, groups, collaboration, permanent delete, or deployment.

## Verification

The dedicated `verify:project-map` gate covers:

- normalized Map/Reading projection and occurrence identity;
- geometry delta and semantic undo/redo behavior;
- API conflict preservation and compact placement payloads;
- desktop lazy-import and semantic-boundary source contracts;
- mounted mobile ordering without Map initialization;
- mounted explicit-save, bounded autosave, retry replay, and `409` reload
  behavior;
- a production build plus bundle inspection proving React Flow remains in the
  separate desktop Map chunk.

CI records this as `pre-pr/project-map`. Existing blob, Reference, Project
foundation, Project persistence, complete test, and production-build gates must
also remain green on the exact PR head.

## Ready and merge boundary

PR #133 remains Draft until independent review confirms the checklist, the
temporary bootstrap workflow is absent, and every exact-head context is green.
No remote D1 migration, Worker deployment, or production-data operation belongs
to this phase.

After squash merge, Phase 3B1 becomes complete and Phase 3B2 — the reference
sidebar and authoritative Map placement flow — becomes the immediate next PR.
