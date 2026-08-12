# Product goal and roadmap

Status: canonical product direction and active implementation roadmap

Last reviewed: 2026-08-12 after the reference/search foundation through PR #129,
the reusable Project discovery surface implemented in PR #130, the Map-first
Project review, the Phase 3A1 schema/export foundation implemented in PR #131,
the Phase 3A2 authoritative persistence service completed in PR #132, and the
Phase 3B1 desktop Map kernel squash-merged in PR #133; Phase 3B2 reference
placement is the current Draft PR #134

This document is the single high-level roadmap for Sample Fabrication Workflow.
Detailed identity, lifecycle, search, Project, Canvas, export, and deployment
contracts remain in their focused documents, but their phase labels and
priorities must not contradict this roadmap.

The Map-first interaction and persistence contract is defined in
[Project Canvas interaction contract](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).

## North star

Sample Fabrication Workflow should become a **sample-centered source of truth
with a Project-centered research workspace** for small research groups.

The finished product has two deliberately different layers:

1. **Experimental source record** — Samples, Recipes, Runs, Steps, Comments,
   attachments, metrology records, structures, and timelines record what was
   planned and what actually happened.
2. **Project workspace** — a Project combines read-only references to those
   records with Project-owned Markdown and generic attachments so a researcher
   can spatially organize, explain, connect, and linearly review a body of work
   without copying or rewriting the source record.

The source layer answers:

> What happened to this physical sample, and what is the durable evidence?

The Project layer answers:

> What belongs to this research question, how do the pieces relate spatially,
> and how should another researcher read them in sequence?

Neither layer replaces the other.

## Intended final interaction

Map is the primary Project creation and organization interface. Reading is a
linear projection of the same Project-local item occurrences; it is not an
independent document or second content model.

```text
Project
├─ Map
│  ├─ reference sidebar / search
│  ├─ drag references to exact positions
│  ├─ double-click empty space to create Markdown
│  ├─ add generic attachments
│  ├─ resize and move nodes
│  └─ connect nodes with basic directed/undirected edges
├─ Reading
│  ├─ render the same occurrences in one linear order
│  ├─ edit existing Project-owned Markdown
│  ├─ edit allowed attachment metadata
│  └─ follow immutable insertion order and create no new items
└─ Inspector
   └─ detail, source hierarchy, exact navigation, and local actions
```

A user should remain in one Project, find any eligible referenceable object in
the sidebar, drag or place it onto the Map, and receive a new Project-local
occurrence only after one authoritative server operation succeeds.

The temporary `/search` page from Phase 2C2 is an integration harness and
reference browser. It is not a commitment to keep Search as a permanent primary
navigation destination. The first Project workspace replaces that destination;
`/search` may then redirect into Project discovery, remain development-only, or
be removed.

## Product boundaries

The product is not intended to become:

- a general LIMS, MES, inventory suite, or enterprise workflow platform;
- a task, approval, progress, or Project-status manager;
- a second editor for source Samples, Runs, Steps, Comments, or Recipes;
- a data-analysis notebook or simulation database;
- a fixed Project folder tree;
- a Canvas whose serialized frontend state is the database model;
- a page-layout or desktop-publishing application;
- a real-time collaborative whiteboard in the initial release;
- an autonomous LLM-operated experimental system.

Project-owned content is initially limited to Markdown and generic attachment
occurrences. All existing experimental records and source attachments remain
read-only references.

## Durable architectural invariants

All future phases preserve these rules:

1. **Source data remains authoritative.** Project stores occurrences,
   Project-owned content, placements, and local relationships; it does not copy
   external source records into editable snapshots.
2. **Identity layers remain separate.** Source/content identity,
   `reference_targets`, Project-item occurrence identity, and Map placement
   identity are not collapsed into one row or one React Flow node.
3. **Map and Reading share content.** Every committed active Project item
   occurrence has a Map placement and automatically appears in Reading by
   immutable creation sequence. SQLite constrains placement cardinality to zero
   or one; the authoritative item-creation transaction provides the stronger
   exactly-one product guarantee. Editing content once updates both projections.
4. **Repeated references are allowed.** One reference target may have several
   independent occurrences in the same Project; no Project-level uniqueness
   constraint is added.
5. **References have no local annotation override.** Interpretation is expressed
   through separate Markdown occurrences or optional edge labels.
6. **Search is a shared capability.** Project discovery, directories, and future
   pickers may use different eligibility profiles but should not grow unrelated
   matching/ranking engines.
7. **Search indexes are derived.** A future FTS5 or other index can be rebuilt
   from authoritative rows and does not own lifecycle or identity.
8. **Delete remains recoverable by default.** Permanent deletion stays disabled
   until Project reverse relations, privileged authorization, tombstones, and
   final concurrency checks exist.
9. **Export evolves with the model.** The first Project schema bumps the complete
   export version and includes Project rows and reachable Project-owned bytes.
10. **Platform contracts stay portable.** Cloudflare is the current deployment,
    not the domain model. New code avoids unnecessary D1, R2, Access, Queue, or
    Worker coupling outside adapters and runtime boundaries.
11. **Collaboration is reserved, not implemented.** Stable IDs, monotonic
    optimistic revisions, idempotent operations, and conflict responses preserve
    a future path without introducing CRDT/OT or live presence now.
12. **LLM capability is read-only and explicit.** A later insight feature may
    summarize or connect user-selected Project content, but it does not mutate
    source records or silently add Project items.

## Current position

### Completed foundation

The following prerequisites are complete on `v2/backend-foundation`:

- stable source and occurrence identities;
- recoverable source deletion and restoration;
- canonical Comment and attachment-occurrence semantics;
- shared blob reachability, GC ledger, export integrity, and physical-delete
  protection;
- sparse immutable reference registry;
- bounded batch resolver over nine existing target types;
- lifecycle-aware canonical Reference URLs;
- exact Step, Comment, attachment, execution-image, and metrology source focus;
- deterministic read-only reference search with portable candidate backend,
  stable ranking, lifecycle filtering, and real Worker/D1 verification;
- reusable `ReferenceSearchSurface`, stable `ReferenceTarget` selection,
  controlled request/filter state, and the temporary `/search` integration
  browser implemented in PR #130;
- normalized Project schema, bounded placement and safe-integer contracts,
  attachment/blob retention, and complete export schema version 4 implemented
  in PR #131;
- authoritative Project CRUD, normalized active and Trash snapshots,
  rollback-safe item-plus-placement creation, bounded retry idempotency,
  attachment media, and basic graph mutations implemented in PR #132;
- desktop React Flow Map kernel, normalized geometry save/undo state,
  navigation protection, and mobile occurrence projection implemented and
  squash-merged in PR #133.

These foundation and discovery-enabling phases are closed. They should receive
correctness fixes but must not continue expanding into independent product areas.
The active implementation target is independent review and completion of Draft
PR #134, the Phase 3B2 reference sidebar and authoritative Map placement slice.
Phase 3B3 starts only after #134 is completed and squash-merged.

## Active implementation roadmap

### Phase 2C2 — reusable Project discovery surface

**Status:** complete in PR #130.

**Delivered:**

- reusable browse/select search surface;
- stable target selection output;
- deterministic server-order result presentation;
- filters, retry, cancellation, empty/error/truncation states;
- temporary `/search` integration harness;
- no registration, Project write, or `Add to project` success state.

**Exit:** complete. Work moves directly to Project schema and Canvas contracts,
not additional standalone Search features.

### Phase 3A — Project core persistence

**Goal:** establish normalized Project identities, complete export, and the
single authoritative save protocol required by both Map and Reading before React
Flow or a Markdown editor is introduced.

Phase 3A is deliberately split at the schema/service boundary.

#### Phase 3A1 — schema, export, and blob-safety foundation

**Status:** implemented in PR #131.

**Scope:**

- `projects` with stable identity and recoverable deletion;
- `project_contents` for Markdown and generic attachment ownership;
- revisioned attachment caption/source URL on the content record;
- immutable intrinsic attachment locator/name/type/size metadata using existing
  blob/storage contracts;
- `project_items` as repeatable Project-local occurrences targeting content XOR
  `reference_targets`;
- immutable per-Project `created_sequence` on each item occurrence for Reading;
- zero-or-one `project_map_placements` row per item at the database layer, with
  finite bounded coordinates, dimensions, and z-index;
- `project_edges` with fixed four-side handles, endpoint marker direction, and
  optional short label;
- no uniqueness constraint on `(project_id, reference_target_id)`;
- monotonic revisions that cannot be rewound, pre-bumped, or reused;
- complete-export schema-version bump and Project table/blob coverage;
- migration, host SQLite, D1/workerd, route, and export gates;
- no Project mutation routes.

**Exit:** the schema, export snapshot, and blob graph can be deployed safely, and
every invariant that belongs in SQLite is executable before application writes
are exposed.

#### Phase 3A2 — authoritative Project persistence service

**Status:** implemented in PR #132.

**Scope:**

- Project list, create, open, rename, recoverable delete, and restore;
- one Project snapshot/read model for Map and Reading, plus an explicit
  `includeDeleted=1` Trash snapshot that keeps recoverable child rows discoverable;
- object-owned expected revisions, bounded retry idempotency through stable IDs
  and current-row operation IDs, and explicit `409` conflict behavior;
- one authoritative reference insertion operation that re-resolves, registers,
  allocates `created_sequence`, creates the occurrence, and creates its Map
  placement in one rollback-safe transaction;
- Project-owned Markdown creation and save APIs;
- Project-owned attachment creation plus caption/source-URL update APIs;
- local occurrence removal without source mutation;
- placement and basic-edge mutation APIs;
- normalized delta/save APIs and explicit-save/autosave flush boundaries;
- transaction, concurrency, route, workerd, and exact-head deployment gates.

**Not yet:** React Flow, rich Markdown editor, PDF preview, advanced Inspector,
real-time collaboration, or permanent delete.

**Phase 3A exit:** the backend can create a Project, create owned content, insert
repeated references, persist Map placements and basic edges, derive Reading from
creation sequence, save safely, reopen the Project, and export it completely.

### Phase 3B1 — Map kernel

**Status:** complete; squash-merged in PR #133.

**Goal:** deliver the primary Project interaction surface without yet combining
all creation modes.

**Scope:**

- replace the temporary Search navigation destination with Project;
- Project list/create/open shell;
- dynamically load `@xyflow/react` only for desktop Map editing;
- pan, zoom, selection, fit view, and optional lightweight MiniMap;
- lightweight Markdown, attachment, and reference node renderers;
- move and border resize with unchanged font size;
- one active editor at most;
- local draft plus explicit Save and bounded autosave state;
- persist placement at drag stop/resize end rather than per frame;
- client-session undo/redo for move/resize/selectable local commands;
- simple Inspector selection shell;
- Reading-only default on mobile.

**Exit:** complete. Existing Project item occurrences can be viewed, moved,
resized, saved, and reopened through the desktop Map without React Flow state
becoming the database.

### Phase 3B2 — reference sidebar and Map placement

**Status:** implemented in current Draft PR #134; independent exact-head review
remains required before Ready or merge.

**Goal:** make reference discovery and spatial placement the core Project
creation flow.

**Scope:**

- mount `ReferenceSearchSurface` in the Project sidebar/operation area;
- desktop drag result to exact Map coordinate;
- keyboard-equivalent `Place at Map center` action;
- pending ghost node and explicit known-failure/uncertain-result behavior;
- authoritative server insertion after drop, never at drag start;
- exact replay/reconciliation before an uncertain insertion may be cancelled;
- Project-local removal with exact retry identity and Map geometry freeze while
  the removal outcome is unresolved;
- hover/selected/focused `Open reference` action;
- node body selects rather than navigates;
- allow repeated occurrences of the same reference target;
- make the new occurrence appear in Reading automatically through creation sequence;
- permanent `pre-pr/project-reference-placement` CI coverage.

**Exit:** a user can stay inside a Project, find any supported source object,
place it on the Map, safely reconcile response-loss cases, reopen the Project,
and remove the local occurrence without changing source data or racing stale
geometry writes.

This milestone is the first useful **Project reference-workspace alpha**.

### Phase 3B3 — Project-owned Markdown and generic attachments

**Status:** deferred until Phase 3B2 / PR #134 is complete and merged.

**Goal:** allow the Map to create the only two Project-owned content classes.

**Scope:**

- double-click empty Map space to create and focus a local Markdown draft;
- cancel unsaved empty drafts and persist valid content;
- explicit `Add attachment` and context-menu insertion at a coordinate;
- generic file metadata and image-rich rendering;
- editable Project-owned caption and optional source URL without changing the
  immutable stored-file locator or intrinsic name/type/size metadata;
- existing source attachments continue to enter through Reference search;
- same occurrence automatically appears in Reading by creation sequence;
- no complex page layout, floating images, or embedded Reference editor nodes.

**Exit:** a Project can spatially combine read-only experimental references,
editable Markdown, images, PDFs as file cards, and other generic files.

### Phase 3B4 — basic Project-local edges

**Goal:** support Obsidian-Canvas-like relationship drawing without advanced
routing complexity.

**Scope:**

- Bezier edges only;
- top/right/bottom/left handles;
- fixed endpoints and handles after connection;
- undirected, forward, reverse, and bidirectional endpoint markers;
- optional short free-text label;
- delete/recreate to change endpoints;
- no self-loop, obstacle avoidance, control-point editing, or relation ontology;
- client-session undo/redo and save/conflict behavior for edge changes.

**Exit:** the Map expresses complex Project-local relationships using a bounded,
normalized edge model.

This milestone is the **Map-first Project workspace alpha**.

### Phase 3C — Reading projection

**Goal:** provide a mobile-friendly and linear review/editing projection over the
same occurrences without creating a second content system.

**Scope:**

- render every active occurrence in one linear order;
- no creation controls in Reading;
- edit existing Project-owned Markdown;
- edit attachment caption and optional source URL, but never retarget attachment
  bytes or intrinsic file metadata;
- references remain read-only;
- fixed deterministic insertion-order presentation;
- Map coordinates and edges remain intact;
- mobile defaults to Reading with limited editing only.

Reading initially uses immutable insertion sequence only. Phase 3A adds no
Reading-placement table, manual reorder, edge-order field, topological sort, or
cycle UX. A later dedicated design may add custom or edge-informed ordering if
real Project use demonstrates the need.

**Exit:** the complete Project can be read and lightly edited linearly without
losing or duplicating Map content.

### Phase 3D — Markdown/TeX, media, and save UX hardening

**Goal:** make owned content comfortable for real research narrative.

**Scope:**

- canonical Markdown storage with CommonMark/GFM-style behavior;
- TeX math rendering;
- lazy editor loading for only the active node/block;
- complete Reading rendering independent of Map node size;
- image preview and caption UX;
- generic file cards;
- conflict resolution and save-status UX;
- coarse Project checkpoints/version snapshots only if needed;
- human-readable export with relative attachment paths.

**Exit:** the Project supports durable mixed-media research narrative without a
mega-editor or page-layout system.

This milestone is the **Project MVP**.

### Phase 4 — Advanced Canvas and Inspector

**Goal:** approach a mature Obsidian-Canvas-like workflow after the normalized
core is stable.

**Candidate sequence:**

1. deeper Inspector, Project/item canonical destinations, and exact focus;
2. child-reference insertion through the same authoritative path;
3. multi-select, copy/paste, keyboard shortcuts, helper lines, and z-order;
4. groups/frames if real use justifies them;
5. PDF first-page thumbnail and fuller Inspector/modal preview;
6. webpage screenshot capture after a security review; no live iframe contract;
7. large-map performance hardening and contextual zoom;
8. optional custom Reading-order design after real use demonstrates a need;
9. optional JSON Canvas import/export after internal semantics are stable.

**Exit:** the same Project occurrences support mature spatial navigation,
inspection, and presentation while Reading remains a consistent linear
projection.

This milestone is the **Project v1 product shape**.

## Save, history, and collaboration direction

The initial editor uses:

```text
local draft
+ pending normalized deltas
+ explicit Save
+ bounded autosave at idle and semantic operation boundaries
```

Drag/resize do not write per frame. Reference drop and creation are high-priority
save operations. Undo/redo is client-session only.

Permanent operation history is not required. A later coarse checkpoint/version
feature may retain meaningful Project snapshots, but it is distinct from session
undo and does not promise restoration to every intermediate drag or keystroke.

Real-time collaboration is deferred. Stable IDs, optimistic revisions,
`updated_by`, idempotent operation IDs, and explicit `409` conflicts are required
now so a future collaboration project does not need to replace the data model.

## Parallel platform and quality tracks

### Portability and Docker distribution

Portability is a continuous constraint and a later release milestone, not a
reason to delay Project indefinitely.

From Phase 3 onward, each backend PR identifies:

- runtime-neutral domain logic;
- D1-specific query/runtime adapters;
- R2 and managed-storage adapters;
- Access/authentication adapters;
- scheduled/background boundaries;
- export and configuration assumptions.

After Project content and save contracts stabilize, perform a dedicated
portability audit and build a reference Docker deployment using ordinary SQLite
and explicit local/object-storage adapters. It is the same product, not a fork.

### Search performance

Do not add FTS5 merely because source scanning is theoretically less scalable.
Add it when representative Project sidebar datasets or measured latency show a
real need.

The preferred optimization remains a rebuildable SQLite FTS5 candidate backend
that preserves existing ranking, lifecycle, resolver, and stable-target
contracts in D1 and compatible self-hosted SQLite.

### Permanent deletion and backlinks

Permanent deletion remains disabled through Project MVP. `project_items` creates
the natural reverse relation needed for future safety, but backlink counts and UI
are not required for alpha or MVP.

A later safety review may count distinct Projects, add conflict reporting,
privileged authorization, final concurrency checks, and tombstone creation.
Repeated occurrences in one Project must not be misrepresented as several
Projects.

### Quality and operations

Every schema phase preserves:

- fresh ordered migrations in host SQLite and D1/workerd;
- focused contract tests and complete test/build gates;
- complete export integrity;
- no physical locator exposure;
- no unauthorized cross-layer mutation;
- isolated remote deployment requirements;
- an initial performance target around 200–300 nodes and 300–500 edges, with
  stress testing around 500 nodes and 800 edges.

## Later capabilities

Only after Project MVP and the deterministic read model are stable should the
roadmap consider:

- optional manual or edge-informed Reading ordering after real use;
- revision pinning to real source history;
- semantic or hybrid search;
- read-only LLM insight over explicit user-selected Project scope;
- suggested connections that require user confirmation;
- advanced consistency dashboards;
- real-time multi-user collaboration;
- advanced automatic layout and edge routing.

LLM insight is not an experimental-record editor, not an autonomous agent, and
not a hidden data-analysis subsystem. Any saved output becomes ordinary
Project-owned Markdown or attachment content only through explicit user action.

## Release milestones

| Milestone | Required capabilities |
|---|---|
| Foundation complete | Source/blob lifecycle, registry, resolver, deep links, exact focus, deterministic search, reusable Project discovery surface |
| Project reference-workspace alpha | Project identity/save model, Map kernel, authoritative repeated-reference placement, reopen/remove behavior |
| Map-first Project workspace alpha | Alpha plus Markdown/attachment creation and basic directed/undirected edges |
| Project MVP | Map-first alpha plus Reading projection, Markdown/TeX, media/save hardening, complete export |
| Project v1 | MVP plus mature Inspector, advanced Canvas usability, previews, and performance hardening |
| Portable release | Same Project contracts pass in a documented Docker/self-hosted deployment |
| Insight experiments | Optional read-only semantic/LLM features after the deterministic product is stable |

## Immediate next PR order

1. Complete independent review and squash-merge the current **Phase 3B2
   reference sidebar and authoritative Map placement** in Draft PR #134.
2. Only after #134 merges, add **double-click Markdown and generic attachment
   insertion** as Phase 3B3.
3. Add **basic Bezier directional edges**.
4. Add the no-creation **Reading projection**.
5. Harden **Markdown/TeX, mixed media, save/conflict UX, and export**.
6. Add advanced **Inspector/Canvas/previews/performance**.
7. Run the dedicated Docker portability implementation after Project content
   and save semantics stabilize.

## Work that should not happen next

The next phase should not be:

- more standalone Search-page product polish;
- a Text-first Project editor disconnected from Map occurrences;
- a mega-editor that owns references, attachments, and Canvas nodes internally;
- FTS5 synchronization before measured scale requires it;
- permanent-delete endpoints before the later safety review;
- live webpage iframe preview;
- real-time collaboration before the single-user save/revision model is stable;
- a Docker-specific fork that duplicates domain logic;
- LLM features before the deterministic Project workflow is usable.
