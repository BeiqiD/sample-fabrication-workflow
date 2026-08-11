# Project Map kernel review checklist

Status: Phase 3B1 implementation review checklist for Draft PR #133

Last reviewed: 2026-08-11 after Phase 3A2 was squash-merged in PR #132 and the
desktop Project Map kernel was implemented and placement-loss review findings
were addressed in PR #133

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

- Live pointer drag and resize frames update local renderer geometry only.
- Pointer movement becomes a formal geometry command at drag stop or resize end.
- React Flow keyboard position changes also become formal geometry commands;
  they must enter Unsaved state, participate in undo/redo and autosave, and may
  never remain renderer-only movement that disappears after reload.
- Network writes occur only after a semantic geometry command, explicit Save,
  or the documented bounded autosave flush; never once per pointer frame.
- Each new placement mutation sends the placement's current expected revision
  and a fresh retry-safe operation ID; an exact retry after an uncertain failure
  reuses that same operation ID and payload.
- Successful saves replace the local baseline with the authoritative returned
  placement revision.
- A `409` conflict is never converted into silent last-write-wins; the UI keeps a
  visible conflict state and provides authoritative reload.
- Failed writes keep unsaved local geometry discoverable until reload or a
  successful retry.

## Navigation and unload safety

- A pending 1.6-second autosave must not be silently discarded by internal SPA
  navigation.
- Internal navigation while Unsaved/Saving is blocked until all current dirty
  geometry is safely flushed; geometry created while a save is in flight must be
  drained before the originally requested navigation may proceed.
- Unsaved/Saving navigation exposes no `Leave without saving` action. Explicit
  discard is available only after Save Error or Conflict makes safe flush
  impossible without further user action.
- Save Error and Conflict keep navigation blocked rather than silently dropping
  local placement state; the user must explicitly retry/resolve, stay, or choose
  to leave without saving.
- ProjectPage save work is scoped to a mounted session/generation. Unmount or an
  explicit Error/Conflict discard invalidates the old generation so stale async
  completions cannot schedule autosave or issue any later placement write.
- Browser refresh/close with Unsaved, Saving, Error, or Conflict state activates
  `beforeunload` protection.
- The production router must provide the data-router context required by the
  navigation blocker, and mounted tests must exercise the same routing mode.

## Undo, redo, and selection

- Move and resize commands record before/after geometry at semantic boundaries,
  not per pointer frame.
- Keyboard nudges are ordinary client-session geometry commands and are undoable.
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

- the dedicated `verify:project-map` contract, including a mounted real React
  Flow keyboard-movement regression;
- mounted internal-navigation protection including a deferred PATCH, an
  in-flight geometry change, and proof that navigation waits for the follow-up
  placement write;
- mounted stale-session invalidation proving no request can be scheduled after
  ProjectPage unmount;
- mounted hard-unload, save-error, and conflict protection regressions;
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
