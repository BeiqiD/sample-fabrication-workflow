# Project basic edges implementation plan

Status: Phase 3B4 implemented in Draft PR #136; final exact-head verification pending

Last reviewed: 2026-08-13 after the authoritative edge controller, React Flow surface, Inspector editing, session undo/redo, mounted regressions, and permanent `pre-pr/project-edges` gate were implemented

This document defines the bounded Phase 3B4 implementation for Project-local Map edges. The canonical product order remains in [PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md), the durable Map interaction rules remain in [PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md), and the authoritative edge persistence service is already defined by [PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md](./PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md).

## Goal

A desktop Project Map can express lightweight research relationships between existing Project item occurrences without introducing a second graph model or turning React Flow state into authoritative storage.

Phase 3B4 completes the Map-first Project workspace alpha by exposing the normalized `project_edges` model already implemented in Phase 3A2.

## Existing backend boundary reused by 3B4

Phase 3B4 requires **no schema migration and no new backend data model**. Phase 3A already provides:

- `ProjectEdgeRecord` in every active Project snapshot;
- `POST /projects/:projectId/edges`;
- `PATCH /projects/:projectId/edges/:edgeId`;
- `DELETE /projects/:projectId/edges/:edgeId`;
- `POST /projects/:projectId/edges/:edgeId/restore`;
- stable client-generated edge and operation IDs;
- expected-revision checks on both endpoint items at creation;
- object-owned edge revisions for update/delete/restore;
- bounded retry idempotency;
- fixed top/right/bottom/left handle enums;
- endpoint markers `none | arrow`;
- optional Unicode-safe label up to the existing 200-code-point ceiling;
- no self-loop; and
- recoverable edge lifecycle, including automatic edge removal when an endpoint occurrence is removed.

The frontend consumes these authoritative contracts rather than adding a serialized React Flow graph column or migration.

## Edge shape and direction

The renderer uses ordinary Bezier edges only. Every committed edge fixes:

- source item occurrence;
- target item occurrence;
- source handle;
- target handle;
- start marker;
- end marker; and
- optional short label.

Direction remains a presentation of endpoint markers:

```text
none / none    undirected
none / arrow   forward
arrow / none   reverse
arrow / arrow  bidirectional
```

Changing source/target occurrence or either handle is deliberately **not** an update. The user deletes and recreates the edge.

No first-version self-loop, obstacle avoidance, draggable control point, relation ontology, automatic handle reassignment, or edge-informed Reading order is introduced.

## Connection interaction

Every active non-editing Project node exposes four connection handles: top, right, bottom, and left. React Flow loose connection mode allows the same side handle to act as either connection endpoint while the normalized edge still records an explicit source and target according to the drag gesture.

On a valid connection gesture the client:

1. resolves source/target item occurrences from the authoritative snapshot;
2. rejects self-loop or invalid/missing handles locally;
3. rejects an exact duplicate source/target/handle/direction edge locally;
4. freezes one complete `CreateProjectEdgeInput`, including endpoint item revisions, stable edge ID, and operation ID;
5. shows a renderer-local pending edge while the request is unresolved; and
6. merges only the returned authoritative `ProjectEdgeRecord` after success.

A new connection defaults to **undirected** (`none / none`) so drawing a relationship does not invent semantic direction. Direction can then be changed explicitly in the Inspector.

The duplicate guard intentionally ignores label text: two edges with the same normalized endpoints, handles, and direction are the same first-version relationship shape. A meaningful parallel edge must differ by handle assignment or direction.

## Save and retry boundary

Edge creation and deletion are authoritative **semantic-boundary saves**. They do not join the placement debounce queue, because they already have their own normalized persistence rows and operation identities. This keeps the stable placement autosave state machine independent.

Edge marker/label editing is different: selecting an edge and explicitly choosing `Edit edge` opens one local Inspector draft. The draft does not mutate the authoritative snapshot until `Save edge` is pressed.

Every dispatched edge mutation freezes the complete request. Outcome handling follows the same project-wide distinction used by the preceding phases:

- success: merge the returned authoritative edge record;
- deterministic client/validation failure: keep an explicit local error that may be dismissed/restarted;
- `409`: enter conflict state and require authoritative reload before further edge editing;
- transport, timeout, `408`, `429`, or `5xx`: outcome is uncertain and exposes **exact retry only** using the original edge ID, expected revision(s), payload, and operation ID.

An uncertain edge mutation cannot be locally discarded because the server may already have committed it.

## Selection and Inspector

Node body selection and edge selection are mutually exclusive in the Project Inspector.

For a selected edge the Inspector shows:

- source and target occurrence titles;
- fixed source/target handles;
- current direction;
- optional label;
- `Edit edge`;
- `Delete edge`.

Editing allows only direction and label. Endpoint occurrences and handles remain read-only.

Edge deletion is recoverable on the backend. The active Map removes the edge only after the authoritative delete result is known.

## Session undo/redo

The existing client-session history is extended from geometry-only commands to a bounded union of geometry and edge commands.

Geometry commands retain their existing local behavior. A committed edge command records only the semantic data required to produce an inverse operation:

- create → undo with edge delete; redo with edge restore;
- delete → undo with edge restore; redo with edge delete;
- marker/label update → undo/redo with ordinary edge updates to the previous/next metadata shape.

Every inverse edge operation uses the **current authoritative edge revision** and a new operation ID. History moves between undo/redo stacks only after the inverse authoritative operation succeeds. If the inverse result is uncertain, the exact frozen inverse request is retried before history may advance.

When an item occurrence is removed and its connected edges are removed by the backend, session history commands referencing those edges/endpoints are discarded so undo cannot resurrect a relation to an unavailable occurrence.

## Shared navigation boundary

Unresolved edge creation/update/delete/restore and a dirty edge Inspector draft participate in the same SPA and `beforeunload` protection as placement/content mutations.

While an edge mutation outcome is unresolved:

- another edge mutation cannot start;
- edge handles are disabled;
- undo/redo cannot start another history mutation;
- Project-owned editors and structural reference operations cannot start; and
- leaving the Project remains blocked until success, deterministic cancellation/reload, or exact reconciliation.

A plain selected edge is not unsaved state and does not block navigation.

## Mobile and Reading boundary

Phase 3B4 remains desktop Map-only. Mobile/Reading continues to show the same item occurrence sequence and does not display, create, or edit Map edges in this slice.

Edges do not change `created_sequence` and never change Reading order.

## Verification boundary

Phase 3B4 adds a permanent `pre-pr/project-edges` verification status. The dedicated gate now covers:

- direction ↔ endpoint-marker mapping;
- exact duplicate detection and self-loop rejection;
- Project client create/update/delete/restore routes;
- four real React Flow handles and authoritative Bezier rendering;
- authoritative connection creation with endpoint revisions;
- uncertain exact retry without duplicate edges;
- Inspector marker/label update and fixed endpoint/handle behavior;
- authoritative deletion;
- edge delete/restore/delete undo/redo with current authoritative revisions;
- navigation protection while an edge draft/mutation is unresolved;
- conflict reload behavior;
- existing item-removal history cleanup for connected edge commands;
- the real Worker/D1 Project smoke through `verify:project-worker`;
- full Project persistence/Map/reference-placement/owned-content regression gates; and
- production TypeScript/build and Project Map bundle verification.

The fail-closed deployment verification chain includes `verify:project-edges` after the Phase 3B3 owned-content gate.

## Deliberately deferred

Phase 3B4 does not add:

- endpoint reconnection;
- control-point editing;
- orthogonal or obstacle-aware routing;
- edge colors/styles/width customization;
- relation types or ontology;
- self-loops;
- manual edge ordering;
- Reading-order inference from edges;
- mobile edge editing;
- collaboration/presence; or
- any remote D1 migration or deployment.

## Exit criteria

Phase 3B4 is complete when a desktop user can connect any two active Project item occurrences through fixed side handles, reopen the authoritative Bezier edge, explicitly edit its direction/label, delete it, undo/redo committed edge operations within the session, and survive response loss/conflict without duplicate or silently divergent relationships.
