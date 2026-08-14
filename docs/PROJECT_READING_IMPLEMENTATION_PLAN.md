
# Project Reading implementation plan

Status: Phase 3C implemented in Draft PR #138; pending independent review

Last reviewed: 2026-08-14 after implementing the shared desktop/mobile Reading projection and responsive projection safety

## Goal

Phase 3C turns the existing mobile read-only occurrence skeleton into the formal Reading projection of the same Project-local occurrences used by Map. It adds no Reading-specific persistence table, ordering field, copied content object, or source-record editor.

## Projection and ordering boundary

Reading derives from the authoritative Project snapshot through `projectReadingNodes()`. Every active occurrence is presented in exactly:

```text
created_sequence ascending
project_item.id ascending as deterministic tie-breaker
```

Map position, node size, edge direction, edge labels, viewport state, selection, and Inspector state do not influence Reading order. Switching between Map and Reading never writes Project state.

## Desktop and mobile behavior

Desktop keeps Map as the default creation/organization surface and adds one explicit Map / Reading view switch. The switch is disabled while placement state is unsaved or any Project mutation/editor is unresolved, so an in-progress Map or content operation cannot disappear behind another projection.

Responsive breakpoint changes obey the same lock. While an operation is unresolved or placement state is not saved, the current desktop/mobile projection is frozen even if `matchMedia` changes. Once the lock clears, the page immediately reconciles to the current media query. This keeps Map-only retry, cancel, and reconciliation controls reachable instead of stranding a pending operation in mobile Reading.

Mobile defaults directly to Reading and never initializes React Flow. Mobile does not expose Map placement, reference insertion, attachment upload, edge authoring, occurrence removal, or any other creation/structural mutation.

## Reading content behavior

Reading renders the same occurrence identity and current authoritative content:

- Project-owned Markdown: complete Markdown source, editable through the existing authoritative Markdown update state machine;
- Project-owned attachment: immutable file identity plus complete caption/source URL, with caption/source URL editable through the existing metadata update state machine;
- external reference: resolved read-only summary plus explicit `Open reference` navigation;
- image attachments: existing safe raster preview policy with decode fallback to the file action;
- non-image attachments: file card/action only.

Rich CommonMark/GFM and TeX rendering remains Phase 3D. Phase 3C deliberately renders the complete Markdown source as readable pre-wrapped text rather than introducing an editor/runtime dependency before the Reading contract is validated.

## Mutation and navigation safety

Reading reuses the Phase 3B3 owned-content mutation machinery rather than creating new APIs. Existing Markdown and attachment metadata edits therefore retain:

- current authoritative expected revisions;
- stable operation IDs;
- exact retry only for outcome-uncertain failures;
- explicit deterministic error/conflict handling;
- shared SPA and `beforeunload` protection;
- one active owned-content editor/mutation at a time.

Reading has no Save button for Map placements and no geometry/edge undo controls. Existing content edit buttons persist only their owned-content mutation.

## Frontend boundary

This phase is intentionally not the planned Project frontend redesign. Layout polish, Markdown rendering, TeX, richer typography, responsive composition, advanced Inspector behavior, and generalized component refactoring remain later work. The small React Flow `zoomOnDoubleClick={false}` fix from the superseded standalone bugfix branch is folded into Phase 3C so empty-Map double click remains reserved for Markdown creation.

## Verification boundary

Phase 3C adds a permanent `pre-pr/project-reading` gate covering:

- deterministic creation-order projection;
- desktop Map → Reading switching without creation controls;
- mobile default Reading without React Flow initialization;
- complete Markdown-source presentation;
- complete attachment-caption presentation;
- existing Markdown update through Reading;
- existing attachment caption/source URL update through Reading without byte retargeting;
- references remaining read-only;
- responsive breakpoint changes preserving the current projection during pending reference placement, pending attachment upload/create, and unsaved geometry;
- the folded Map double-click regression;
- full Project persistence/Map/reference/owned-content/edge regressions;
- production build and Project Map bundle boundary.

## Deliberately deferred

Phase 3C does not add:

- Reading creation controls;
- manual reorder or Reading placement rows;
- edge-derived ordering or cycle handling;
- Markdown/TeX rendering;
- attachment-byte replacement;
- source-record editing;
- mobile Map authoring;
- advanced Inspector or Canvas polish;
- schema migration, remote migration, or deployment.

Phase 3D remains the next implementation phase after Phase 3C is independently reviewed and squash-merged.
