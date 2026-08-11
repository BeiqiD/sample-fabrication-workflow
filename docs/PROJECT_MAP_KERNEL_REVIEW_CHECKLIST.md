# Project Map kernel review checklist

Status: Phase 3B1 implementation review checklist for Draft PR #133

Last reviewed: 2026-08-11 after Phase 3A2 was squash-merged in PR #132 and the
first desktop Project Map kernel was implemented in PR #133

This checklist is intentionally narrower than the full Project Canvas contract.
It defines what an independent review must prove before Phase 3B1 can move from
Draft to Ready. The canonical behavior remains in
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md),
the implemented boundary is recorded in
[PROJECT_MAP_KERNEL_IMPLEMENTATION_PLAN.md](./PROJECT_MAP_KERNEL_IMPLEMENTATION_PLAN.md),
and the roadmap order remains in [PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md).

## Phase boundary

The PR may include:

- Project navigation and list/create/open shell;
- desktop-only dynamic loading of `@xyflow/react`;
- snapshot-derived Markdown, attachment, and reference renderers;
- pan, zoom, selection, fit view, move, and border resize;
- placement drafts, explicit Save, bounded autosave, and client-session
  undo/redo;
- a lightweight selection Inspector;
- a deterministic read-only mobile occurrence projection.

The PR must not include:

- reference search or authoritative reference insertion;
- Project-owned Markdown or attachment creation;
- Project-local edge authoring;
- the complete Reading projection or rich Markdown editor;
- schema changes, migrations, deployment, or production-data operations.

## Rendering and dependency ownership

- `@xyflow/react` is absent from the initial application bundle and is loaded
  only when the desktop Map surface is entered.
- Mobile never initializes the React Flow editor.
- Node and callback identities used by React Flow remain stable across ordinary
  renders.
- React Flow state is a renderer/local interaction state, not an opaque database
  document.
- Markdown, attachment, and reference nodes derive from the normalized Project
  snapshot and keep one `project_item.id` identity.

## Placement persistence

- Live drag and resize frames update local geometry only.
- Network writes occur only at drag stop, resize end, explicit Save, or the
  documented bounded autosave flush.
- Each new placement mutation sends the placement's current expected revision
  and a fresh retry-safe operation ID; an exact retry after an uncertain failure
  reuses that same operation ID and payload.
- Successful saves replace the local baseline with the authoritative returned
  placement revision.
- A `409` conflict is never converted into silent last-write-wins; the UI keeps a
  visible conflict state and provides authoritative reload.
- Failed writes keep unsaved local geometry discoverable until reload or a
  successful retry.

## Undo, redo, and selection

- Move and resize commands record before/after geometry at semantic boundaries,
  not per pointer frame.
- Undo and redo are client-session only and do not claim permanent history.
- A subsequent save persists the restored current geometry as an ordinary new
  placement revision.
- Selection and Inspector state do not mutate source objects or Project content.
- Interactive controls and resize handles do not accidentally initiate node
  dragging.

## Mobile projection

- Mobile ordering is deterministic by `createdSequence`, with item identity as a
  stable tie-breaker when required.
- The mobile surface has no item-creation, upload, placement, resize, edge, or
  bulk Canvas controls.
- The surface is explicitly described as a read-only occurrence projection, not
  as the complete Phase 3C Reading implementation.

## Required verification

Before Ready, the exact PR head must pass:

- the dedicated `verify:project-map` contract;
- Project foundation and persistence contracts;
- Reference and blob-lifecycle regression contracts;
- the complete ordinary and mounted test suites;
- production and deploy-configuration TypeScript/Vite builds;
- `git diff --check`;
- confirmation that no temporary bootstrap/finalizer workflow remains.

The independent reviewer should also inspect the production bundle split and
confirm that drag/resize handlers contain no per-frame placement request.

## Ready gate

Phase 3B1 can move to Ready only when:

1. this bounded scope is preserved;
2. no runtime merge blocker remains;
3. the canonical documents identify PR #133 as the current Draft rather than an
   already completed phase;
4. all exact-head status contexts, including `pre-pr/project-map`, are green;
5. no remote migration, deployment, or production-data operation has occurred.

After squash merge, the canonical status moves Phase 3B1 to complete and makes
Phase 3B2 — the reference sidebar and authoritative Map placement flow — the
immediate next PR.
