# Product goal and roadmap

Status: canonical product direction and active implementation roadmap

Last reviewed: 2026-08-27 after PR #160 completed Phase 5B and the Project
workspace layout and control rebuild opened through Phase 5C0 in Draft PR #161

This document is the single high-level roadmap for Sample Fabrication Workflow.
Detailed identity, lifecycle, search, Project, Canvas, export, and deployment
contracts remain in their focused documents, but their phase labels and
priorities must not contradict this roadmap.

The Map-first interaction and persistence contract is defined in
[Project Canvas interaction contract](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).
The shared attachment ownership and lifecycle boundary is defined in
[shared attachment backend contract](./ATTACHMENT_BACKEND_CONTRACT.md).
The bounded Phase 5 sequence and verification contract are defined in
[frontend refinement implementation plan](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md).

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
- shared blob reachability, GC ledger, export integrity, physical-delete
  protection, and provider-verified deduplication with integrity quarantine;
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
  squash-merged in PR #133;
- Project reference sidebar, exact Map placement, repeated occurrence handling,
  uncertain-result reconciliation, Project-local removal, and the permanent
  `pre-pr/project-reference-placement` gate completed in PR #134.

These foundation and discovery-enabling phases are closed. They should receive
correctness fixes but must not continue expanding into independent product areas.
Phase 3B3 Project-owned Markdown and generic attachment creation is complete in
squash-merged PR #135. Phase 3B4 basic Project-local edges are complete in
squash-merged PR #136. Phase 3C Reading projection is complete in squash-merged
PR #138. The bounded Project-stability work in PRs #139/#140 and the storage-
integrity/recovery track in PR #141 are also complete. Phase 3D Markdown/TeX,
mixed-media presentation, save/conflict behavior, and human-readable export are
complete in PR #143, with the shared safe renderer extended to Comment read
surfaces in PR #144. Phase 4A1 canonical Project occurrence focus is complete in
PR #145, Phase 4A2 Inspector hierarchy, provenance, type-specific detail, and
exact source navigation are complete in PR #146, and Phase 4A3 authoritative child-
reference insertion is complete in PR #147. It adds authoritative direct-child
discovery inside the Inspector while reusing the existing Project placement
transaction and retry/reconciliation state machine. Phase 4B1 Canvas
multi-selection and grouped geometry are complete in PR #148. Phase 4B2 authoritative copy/paste is complete in PR #149. Phase 4B3 alignment assistance and explicit z-order are complete in PR #150.
Phase 4C representative-scale Map performance, contextual zoom, and final v1
include/defer decisions are complete in PR #151. Attachment lifecycle Slice A,
shared ingestion Slice B, and occurrence-metadata Slice C are complete in PRs
#152/#153/#154. The bounded shared-derivative registry/resolver/export foundation
is complete in PR #155, including the client-preview trust boundary and complete
export schema v7. Trusted server-side generation remains a separately justified
follow-up. Phase 5 execution planning is complete in PR #156. Phase 5A Project
workspace shell and state hierarchy is complete in PR #157; its exact-head review
found no concrete A2 follow-up. Phase 5B1 occurrence identity language and
Phase 5B2 edge theme/mutation-state language and Phase 5B3 Project-owned editor
outcome feedback are complete in PRs #158/#159/#160; no B4 is currently required.
The materially larger Project composition gap is now authorized as Phase 5C,
starting with Draft PR #161. Storage, lifecycle, Reference,
and rich-content foundations return to correctness maintenance rather than
continuing as independent feature tracks.

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

**Status:** complete; squash-merged in PR #134.

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

**Exit:** complete. A user can stay inside a Project, find any supported source
object, place it on the Map, safely reconcile response-loss cases, reopen the
Project, and remove the local occurrence without changing source data or racing
stale geometry writes.

This milestone is the first useful **Project reference-workspace alpha**.

### Phase 3B3 — Project-owned Markdown and generic attachments

**Status:** complete; squash-merged in PR #135.

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

**Status:** complete; squash-merged in PR #136.

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

**Status:** complete; squash-merged in PR #138, with Markdown removal lifecycle
wiring completed in the subsequent storage-integrity maintenance slice.

**Goal:** provide a mobile-friendly and linear review/editing projection over the
same occurrences without creating a second content system.

**Scope:**

- render every active occurrence in one linear order;
- no creation controls in Reading;
- edit and recoverably remove existing Project-owned Markdown;
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

**Status:** complete in PR #143; shared Project/Comment presentation reuse completed in PR #144.

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

### Phase 4 — complete the v1 functional shape

**Goal:** finish the interaction-shaping features that would otherwise force major
page or component restructuring after visual refinement begins.

Phase 4 is deliberately about **functional completeness**, not final visual polish.
Candidate features do not automatically become release blockers: only capabilities
that real use shows are necessary for the v1 interaction model must land before the
feature freeze.

#### Phase 4A — Inspector and navigation completeness

**Status:** complete through PR #147; Phase 4A1, Phase 4A2, and Phase 4A3 are complete.

**Scope:**

- deeper Inspector with clear source hierarchy and Project-local context;
- Project/item canonical destinations and exact focus/navigation;
- child-reference insertion through the existing authoritative reference path;
- fuller Inspector/modal media preview where it materially improves research use;
- PDF first-page thumbnail if it proves useful for routine inspection;
- webpage screenshot capture only after a security review; no live iframe contract.

**Exit:** inspection and navigation no longer require a later structural redesign of
the Project workspace.

#### Phase 4B — Canvas productivity

**Status:** complete in PRs #148–#150. Phase 4B1 delivered multi-selection and grouped geometry, Phase 4B2 delivered authoritative copy/paste, and Phase 4B3 delivered transient alignment assistance plus explicit z-order without changing the normalized persistence model.

The detailed slice boundaries and persistence constraints are recorded in
[Project Canvas productivity implementation plan](./PROJECT_CANVAS_PRODUCTIVITY_IMPLEMENTATION_PLAN.md), with the frozen Phase 4B2 authorization and retry model in
[Project Canvas authoritative copy/paste contract](./PROJECT_CANVAS_COPY_PASTE_CONTRACT.md).

**Scope:**

- multi-select;
- copy/paste;
- keyboard shortcuts;
- helper/alignment lines;
- explicit z-order controls;
- groups/frames only if real Project use demonstrates a need;
- preserve the normalized occurrence/placement/edge model and existing save
  contracts rather than introducing a frontend-owned Canvas document.

**Exit:** common spatial editing workflows are efficient enough for sustained daily
use without adding general-purpose whiteboard complexity.

#### Phase 4C — performance and final functional gaps

**Status:** complete in PR #151.

**Delivered:**

- contextual `overview`, `compact`, and `full` node/edge presentation with zoom
  hysteresis and no persistence effect;
- memoized node rendering and selection projection that preserves untouched node
  object identity;
- target/envelope-only visible-element rendering for 200–300 node / 300–500 edge
  Projects and the 500-node / 800-edge envelope;
- mounted representative-scale contracts plus a permanent
  `pre-pr/project-map-performance` gate;
- explicit v1 decisions to defer groups/frames, richer non-image previewers, custom
  Reading order, JSON Canvas integration, semantic search, and automatic layout.

The detailed performance and decision boundary is recorded in
[Project Map performance and v1 functional-shape plan](./PROJECT_MAP_PERFORMANCE_IMPLEMENTATION_PLAN.md).

**Exit:** implemented. The same Project occurrences support the intended v1 spatial,
inspection, navigation, and linear-reading workflow at representative scale.

This milestone is the **Project v1 functional shape**.

### V1 feature freeze

**Status:** complete after merged PR #152. Slices B/C and the bounded Slice D
foundation are internal post-freeze backend work and do not reopen the
interaction feature set.

After Phase 4, freeze the interaction-shaping v1 feature set before systematic
frontend refinement begins.

"Feature complete" here means that the capabilities which determine the main page
structure and interaction model are present and stable: Samples/Processing/Recipes,
Project Map, Reading, Inspector, Markdown/media, References, edges, and the selected
v1 Canvas productivity operations. It does **not** mean every future optional
capability has been implemented.

After the freeze:

- avoid adding features that require major page/component restructuring during the
  refinement pass;
- continue correctness, accessibility, performance, and release-blocking fixes;
- defer optional integrations and speculative capabilities instead of reopening the
  v1 interaction model.

### Phase 5 — frontend refinement

**Status:** active implementation; Phase 5A and Phase 5B are complete in PRs
#157–#160, and Phase 5C is active through Phase 5C0 in Draft PR #161.

The bounded slice order and review contract are recorded in
[frontend refinement implementation plan](./FRONTEND_REFINEMENT_IMPLEMENTATION_PLAN.md).

**Goal:** refine the complete product as one visual and interaction system after its
functional shape is stable.

Phase 5 is intentionally separate from Phase 3D. Phase 3D still owns **functional
UX** required for correctness and usability, such as editor loading, Markdown/TeX
rendering, save/conflict behavior, and media presentation. Phase 5 owns the
systematic whole-product refinement that would be wasteful while major features are
still changing.

**Scope:**

- typography and information hierarchy;
- spacing, density, surfaces, borders, shadows, and panel composition;
- final button, icon, status, and semantic-color consistency;
- hover, selected, focused, disabled, loading, empty, error, and conflict states;
- final Map-node, edge, Inspector, sidebar, dialog, and Reading visual language;
- desktop/mobile responsive consistency across realistic content sizes;
- restrained transitions and interaction feedback where they improve comprehension;
- keyboard/focus/accessibility polish;
- wording, labels, and microcopy consistency across the whole product;
- cross-page visual review so old and new UI conventions cannot coexist unnoticed.

**Current Project priority:** Phase 5C is a deliberate Project-scoped layout and
control rebuild, not a functional feature phase. It will replace the current
centered page-within-a-card composition with a workspace-first shell, give Map
the remaining desktop viewport, give Reading an independent document layout, and
turn References/Inspector into responsive panels. Desktop Map overlays remain
non-modal so visible Canvas drag and selection continue; only mobile Reading-first
sheets use modal behavior. The detailed boundary is recorded in the
[Project workspace layout and control contract](./PROJECT_WORKSPACE_LAYOUT_CONTRACT.md).
It explicitly includes substantial Project button work: mode, toolbar, panel,
content, destructive, and overflow controls will receive owned roles, grouping, priority, responsive
collapse rules, and complete accessibility states. Existing mutation, navigation,
Map geometry, Reading order, backend, and performance contracts remain frozen.

The previously planned attachment/media, source-record/directory, and
cross-product integration work moves to Phase 5D, Phase 5E, and Phase 5F
respectively; its product scope is unchanged.

**Exit:** the frozen v1 feature set reads and behaves as one coherent product rather
than a sequence of independently implemented phases.

### Phase 6 — release hardening

**Goal:** validate the refined v1 with realistic use and operational rehearsal before
treating it as a release candidate.

**Scope:**

- sustained testing with representative real research data and Projects;
- desktop/mobile and supported-browser regression passes;
- performance regression and large-Project checks;
- backup, complete export, human-readable export, and restore rehearsal;
- migration/deployment/runbook verification;
- accessibility and security review of the final interaction surface;
- release-blocking bug fixing without reopening optional feature development.

**Exit:** a release candidate is functionally stable, visually coherent, operationally
rehearsed, and suitable for longer real-world use.

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

Portability remains a continuous architectural constraint, but a Docker/self-hosted
distribution is **not a near-term implementation requirement** and is not part of
the immediate Project v1 sequence.

Current product work should continue to preserve:

- runtime-neutral domain logic where practical;
- explicit D1-specific query/runtime adapters;
- R2 and managed-storage adapters;
- Access/authentication adapters;
- scheduled/background boundaries;
- export and configuration assumptions.

This keeps a future self-hosted path open without spending current product cycles on
deployment parity. After the v1 functional shape, frontend refinement, and release
hardening are complete, a separately scheduled portability milestone may perform a
dedicated audit and build a reference Docker deployment using ordinary SQLite and
explicit local/object-storage adapters. It remains the same product, not a fork.

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
- provider-verified content-addressed reuse with fail-closed outage behavior;
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
| Project v1 functional shape | MVP plus mature Inspector/navigation, selected Canvas productivity, previews where justified, and representative-scale performance |
| V1 feature freeze | Interaction-shaping v1 scope is fixed; optional future capabilities no longer block refinement |
| Refined release candidate | Frozen v1 plus systematic frontend refinement and release hardening |
| Portable release | Later milestone: the same Project contracts pass in a documented Docker/self-hosted deployment |
| Insight experiments | Optional read-only semantic/LLM features after the deterministic product is stable |

## Immediate next PR order

1. Complete independent review and merge of **Phase 5C0 — Project layout and
   control contract** in Draft PR #161.
2. Implement **Phase 5C1 — viewport workspace frame**: compact Project top bar and
   a full-viewport desktop Map frame, with behavior frozen.
3. Implement **Phase 5C2 — panels and control hierarchy**: panel state, docked
   and desktop non-modal-overlay capabilities, preserved Canvas interaction, and
   the major Project button-family migration.
4. Implement **Phase 5C3 — Reading and responsive composition**: measure when C2
   presentations switch, add Reading/mobile composition without redefining panel
   modality, then run the bounded **Phase 5C4 Project integration review**.
5. Complete **Phase 5D — attachment and media surfaces** without changing preview
   trust or owner lifecycle.
6. Complete **Phase 5E — source-record and directory coherence**.
7. Run **Phase 5F — cross-product integration review** and update the measured
   frontend baseline.
8. Introduce a trusted server-side derivative producer only as a separately
   reviewed follow-up; keep upload-transport convergence independently justified.
9. Run **Phase 6 release hardening** and real-use/operational rehearsal.

Docker/self-hosted distribution is intentionally absent from this immediate order.
Preserve portability seams now, but schedule implementation only as a later,
independent milestone.

## Work that should not happen next

The next phase should not be:

- more standalone Search-page product polish;
- a Text-first Project editor disconnected from Map occurrences;
- a mega-editor that owns references, attachments, and Canvas nodes internally;
- FTS5 synchronization before measured scale requires it;
- permanent-delete endpoints before the later safety review;
- live webpage iframe preview;
- real-time collaboration before the single-user save/revision model is stable;
- one unbounded whole-product visual mega-PR or global selector-normalization
  pass;
- near-term Docker/self-hosted implementation or a Docker-specific fork that
  distracts from completing and refining the v1 product;
- LLM features before the deterministic Project workflow is usable.
