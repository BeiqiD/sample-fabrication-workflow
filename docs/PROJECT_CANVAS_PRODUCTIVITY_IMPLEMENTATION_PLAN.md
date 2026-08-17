# Project Canvas productivity implementation plan

Status: Phase 4B active; Phase 4B1 is complete in PR #148 and Phase 4B2 is under active implementation in Draft PR #149

Last reviewed: 2026-08-17 after the first Phase 4B2 implementation and concurrency review of PR #149

## Goal

Phase 4B makes routine spatial editing efficient without replacing the normalized Project model with a frontend-owned Canvas document. Productivity state remains either transient interaction state or compact commands over existing Project item, placement, and edge identities.

The authoritative Phase 4B2 identity, attachment-authorization, ordered-journal, and retry contract is recorded in [Project Canvas authoritative copy/paste contract](./PROJECT_CANVAS_COPY_PASTE_CONTRACT.md).

## Architectural invariants

1. Multi-selection is client-session UI state. It is not persisted, exported, assigned a revision, or encoded into `project_items`.
2. One selected occurrence may be the primary occurrence for Inspector and resize presentation, but primary selection is not a new persistent identity.
3. Every selected item remains an independent Project occurrence with its existing placement row. Group movement never creates a group row or shared geometry document.
4. One grouped drag or keyboard movement is one client-session history command containing several placement commands. Explicit Save and autosave still use the existing per-placement revision and exact-retry protocol.
5. A grouped operation must not introduce a bulk backend endpoint merely to mirror a transient UI gesture.
6. Pending reference/attachment ghosts and an unsaved Markdown draft are not ordinary multi-select or copy candidates.
7. Editing, resizing, inspecting authoritative details, and recoverable removal remain single-item operations unless a later slice defines a separate safe contract.
8. Keyboard shortcuts never capture ordinary typing, contenteditable regions, IME composition, or native form-control behavior.
9. Mobile remains Reading-first and does not gain bulk Canvas editing through this phase.
10. `ProjectPage` remains authoritative for accepted item selection. React Flow may propose a transient selection, but a rejected proposal must be projected back to the current authoritative occurrence IDs in the same event turn rather than remaining visually selected.
11. Outside editable controls, the desktop Map consumes `Ctrl/Command+S` even when Save is currently a no-op because the Project is saved, saving, conflicted, or blocked by another operation. A disabled Project command must not fall through to the browser's Save Page action.
12. Copy/paste clipboard and paste-journal state remain client-session state. They are not persisted or exported, and they never become an alternate Canvas document.
13. Project-owned attachment copy accepts a source Project content identity rather than a physical locator. Source occurrence activity and blob availability are rechecked inside the same authoritative write batch that creates the destination binding.
14. A multi-object paste is an ordered set of independently authoritative item and edge writes. The client must not describe it as atomic unless a real aggregate transaction is introduced.

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

Status: active in Draft PR #149; the identity/retry/backend foundation is implemented, while the complete `ProjectPage` interaction and recovery surface remains in progress.

The following design decisions are now frozen rather than open questions:

- Reference copy creates a fresh Project occurrence and placement while preserving the canonical `ReferenceTarget`;
- Project-owned Markdown and attachment copy allocate fresh content, item, placement, and operation identities;
- attachment copy is same-Project in this slice and resolves the physical asset or managed-storage binding only on the Worker;
- only edges whose two endpoints are selected are copied; boundary edges are excluded;
- relative geometry is preserved with a deterministic bounded paste offset and common z-order translation;
- every destination identity, payload, expected Project revision, and edge endpoint mapping is frozen before the first write;
- item writes run sequentially and edges run only after all item writes acknowledge success;
- a response-loss retry reuses the exact frozen request, while a deterministic conflict pauses the journal for explicit reconciliation rather than silently rebasing partial results.

Implemented in the current Draft PR:

- typed clipboard projection for Reference, Markdown, attachment, geometry, and internal edges;
- fresh identity allocation and deterministic paste-journal construction;
- ordered pause/resume execution with exact request replay;
- a dedicated attachment-copy API that accepts only the source Project content identity;
- source occurrence and blob authorization inside the destination creation batch, including rollback when source removal interleaves after the initial read;
- asset and managed-storage coverage, including ready/orphaned acceptance, GC/quarantine rejection, and exact replay after the destination already exists;
- permanent Canvas-productivity and Project-persistence test coverage for the new contract.

Remaining before Phase 4B2 can be marked complete or the PR can become Ready:

- connect `Ctrl/Command+C` and `Ctrl/Command+V` to the desktop `ProjectPage` outside editable and IME regions;
- project acknowledged item and edge results into the local authoritative snapshot and select the new occurrences;
- expose clear progress, paused-partial-paste, exact-retry, conflict, and authoritative-reload behavior;
- add mounted tests for complete paste, lost-response retry, deterministic partial failure, selection projection, and navigation blocking;
- complete final documentation and exact-head review after the interaction path lands.

Exit: a user can copy one or several committed Map occurrences, paste correct new Project occurrences and internal edges, safely resume an uncertain partial paste with the same identities, and clearly reconcile conflicts without a bulk persistence model or locator exposure.

## Phase 4B3 — alignment assistance and explicit z-order

Planned after Phase 4B2 copy/paste interaction and recovery semantics are complete:

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
- clipboard classification, fresh identity allocation, internal-edge filtering, and bounded relative geometry;
- ordered paste-journal pause/resume and lost-response exact replay;
- transactional attachment-source authorization under an interleaved source removal;
- ready/orphaned managed-storage copy, GC/quarantine rejection, and exact replay;
- production build, Worker smoke, and Map bundle boundary.
