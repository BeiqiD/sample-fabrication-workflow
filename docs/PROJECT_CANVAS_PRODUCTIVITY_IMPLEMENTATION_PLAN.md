# Project Canvas productivity implementation plan

Status: Phase 4B active; Phase 4B1 is complete in PR #148 and Phase 4B2 copy/paste is next

Last reviewed: 2026-08-17 after Phase 4B1 completion in PR #148

## Goal

Phase 4B makes routine spatial editing efficient without replacing the normalized Project model with a frontend-owned Canvas document. Productivity state remains either transient interaction state or compact commands over existing Project item, placement, and edge identities.

## Architectural invariants

1. Multi-selection is client-session UI state. It is not persisted, exported, assigned a revision, or encoded into `project_items`.
2. One selected occurrence may be the primary occurrence for Inspector and resize presentation, but primary selection is not a new persistent identity.
3. Every selected item remains an independent Project occurrence with its existing placement row. Group movement never creates a group row or shared geometry document.
4. One grouped drag or keyboard movement is one client-session history command containing several placement commands. Explicit Save and autosave still use the existing per-placement revision and exact-retry protocol.
5. A grouped operation must not introduce a bulk backend endpoint merely to mirror a transient UI gesture.
6. Pending reference/attachment ghosts and an unsaved Markdown draft are not ordinary multi-select candidates.
7. Editing, resizing, inspecting authoritative details, and recoverable removal remain single-item operations unless a later slice defines a separate safe contract.
8. Keyboard shortcuts never capture ordinary typing, contenteditable regions, IME composition, or native form-control behavior.
9. Mobile remains Reading-first and does not gain bulk Canvas editing through this phase.
10. `ProjectPage` remains authoritative for accepted item selection. React Flow may propose a transient selection, but a rejected proposal must be projected back to the current authoritative occurrence IDs in the same event turn rather than remaining visually selected.
11. Outside editable controls, the desktop Map consumes `Ctrl/Command+S` even when Save is currently a no-op because the Project is saved, saving, conflicted, or blocked by another operation. A disabled Project command must not fall through to the browser's Save Page action.

## Phase 4B1 — multi-selection and grouped geometry

Status: complete in PR #148.

Delivered:

- controlled multi-selection in `ProjectPage`, with occurrence IDs remaining the selection identity;
- Shift drag-box selection and Shift/Ctrl/Command additive selection through React Flow's supported selection contract;
- immediate rollback to the parent-authoritative selection when an editor lock or unsafe edge operation rejects React Flow's proposed selection;
- one primary selected occurrence for Inspector/resize presentation while all selected nodes retain selected styling;
- grouped drag and arrow-key movement emitted as one normalized local geometry-history command;
- atomic Undo/Redo of the whole grouped geometry command;
- ordinary per-placement Save/autosave after grouped movement, preserving existing placement revisions and operation IDs;
- `Ctrl/Command+A`, `Escape`, `Ctrl/Command+Z`, `Ctrl/Command+Shift+Z`, `Ctrl/Command+Y`, and `Ctrl/Command+S` Canvas shortcuts outside editable controls;
- a bounded multi-selection Inspector summary instead of exposing unsafe single-item edit/remove actions;
- a permanent `pre-pr/project-canvas-productivity` verification gate.

Exit: users can select several committed Map occurrences, move them together, undo or redo the movement as one semantic action, and save through the existing authoritative placement path without a new persistence model.

## Phase 4B2 — authoritative copy/paste

Status: next bounded slice.

Required design questions before implementation:

- distinguish copying Project-owned Markdown/attachments from creating another occurrence of an existing Reference target;
- allocate fresh item, content, attachment, placement, edge, and operation identities where ownership requires duplication;
- decide whether internal edges with both endpoints selected are copied while boundary edges remain excluded;
- preserve relative geometry and deterministic paste offset without storing clipboard state in Project persistence;
- define exact retry/reconciliation for a multi-object paste without pretending several independent authoritative writes are one atomic transaction unless a real server transaction is added.

Copy/paste must not clone source records, reuse unique Project-owned content identity incorrectly, or bypass attachment/blob ownership.

## Phase 4B3 — alignment assistance and explicit z-order

Planned after copy/paste semantics are stable:

- local alignment/helper lines during drag without per-frame network writes;
- explicit bring forward/back/front/back controls over existing bounded integer `zIndex` values;
- grouped alignment commands represented as ordinary grouped placement history;
- no hidden automatic layout or persistent guide objects.

## Include/defer decision

Groups/frames remain deferred until real Project use demonstrates that multi-selection, copy/paste, alignment assistance, and z-order controls are insufficient. A future frame must not become an alternate item hierarchy or a serialized Canvas document.

## Verification boundary

The permanent Canvas productivity gate covers:

- selection normalization and keyboard shortcut classification;
- editable-target exclusion;
- rejected-selection rollback, including an unsaved Markdown draft that remains selected but is not itself selectable;
- grouped geometry normalization and atomic history application;
- real React Flow additive selection and multi-node arrow movement;
- mounted ProjectPage multi-selection Inspector behavior;
- grouped Undo/Redo;
- explicit keyboard save decomposing into the existing per-placement PATCH protocol;
- saved, saving, conflicted, and operation-blocked Save chords being consumed as safe no-ops rather than invoking browser Save Page;
- production build and Map bundle boundary.
