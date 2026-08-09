# Project Canvas interaction contract

Status: product and architecture contract before Phase 3 schema implementation

Last reviewed: 2026-08-09 after the Map-first Project interaction review

This document defines the intended Project workspace before migrations, React
Flow integration, or an editor dependency are selected. It supersedes any older
statement that Text is the primary Project workspace or that Map and Text are
independent content systems.

The canonical product order is recorded in [PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md).
The stable reference, lifecycle, search, and storage boundaries remain in their
existing focused documents.

## Core product model

Project is one set of Project-local item occurrences with two projections:

```text
Project item occurrences
├─ Map projection      spatial placement and Project-local relationships
└─ Reading projection  one linear presentation of the same occurrences
```

Map is the primary creation and organization interface. Reading is a linear
projection for review and limited editing. In the first version it follows the
immutable Project-item insertion sequence. The projections never own separate
copies of the content.

A Project item occurrence targets exactly one of:

1. Project-owned content; or
2. an external `reference_target`.

Cards and nodes are renderers, not persistent identities. The same occurrence
renders as a Map node, a Reading block, and an Inspector selection while keeping
one `project_item.id`.

## Project-owned and referenced content

### Project-owned content

The first Project model supports:

- Markdown text; and
- generic attachment occurrences.

Generic attachments include images, PDFs, and other files. Images receive a
richer renderer; PDFs initially use a file card and may later gain an optional
preview; other files show filename, type, size, and an open/download action.
All Project-owned attachments reuse the existing occurrence-to-blob, hashing,
storage, retention, GC, and export contracts.

A future webpage capture is a Project-owned screenshot attachment with source
URL metadata. Live webpage embedding is not part of the product contract.

### External references

Every Sample, Run, Step, Comment, existing attachment occurrence, execution
image, metrology reference, Recipe revision, future Project, or content owned by
another Project is inserted as a read-only reference.

A reference occurrence never stores editable local title, caption, description,
or annotation overrides. Its editable Project-local state is limited to
placement and later visual presentation metadata. Context or interpretation is
expressed through a separate Markdown item or an edge label.

The node exposes `Open reference` only through an explicit hover/selection/focus
action. Clicking the node body selects it; it does not navigate.

## Repeated references

The same `reference_target` may appear:

- in several Projects; and
- several times in one Project.

Each appearance is a distinct Project-local occurrence with its own:

- `project_item.id`;
- Map placement and size;
- deterministic Reading position derived from creation sequence;
- incoming and outgoing edges; and
- creation timestamp/order.

No `UNIQUE(project_id, reference_target_id)` constraint is permitted.

Future backlink UI, if added, should normally report Project presence through
`COUNT(DISTINCT project_id)` rather than treating repeated occurrences as
separate Projects. A dedicated backlink table or backlink UI is not required for
Project alpha or MVP; the natural reverse relation from `project_items` is
enough to preserve future capability.

## Desktop and mobile roles

### Desktop

Desktop is the full Project editing environment:

- pan and zoom Map;
- search and drag references from the sidebar;
- place, move, and resize nodes;
- create Markdown by double-clicking empty Map space;
- upload generic Project attachments;
- create and edit basic edges;
- use client-session undo/redo;
- save explicitly and through bounded autosave.

### Mobile

Mobile defaults to Reading. It does not provide full Canvas editing.

The initial mobile contract permits:

- reading the complete Project;
- opening external references;
- editing existing Project-owned Markdown;
- editing existing attachment captions/metadata where allowed;
- reviewing the fixed insertion-order sequence; and
- viewing item detail.

The initial mobile contract excludes item creation, file upload, Map placement,
resize, edge creation/editing, and bulk Canvas actions.

## Map creation interactions

### Reference insertion

The left sidebar or Project operation area contains the reusable reference
search surface. On desktop, a result can be dragged to an exact Map coordinate.
The drag payload contains only the stable `ReferenceTarget` and display-safe
preview data.

No Project or registry row is written when dragging starts. A successful drop
starts one authoritative server operation that:

1. validates Project write access;
2. re-resolves the selected target;
3. idempotently registers or refreshes `reference_targets`;
4. creates one new Project item occurrence;
5. creates its Map placement;
6. assigns its immutable per-Project creation sequence; and
7. returns the canonical inserted item and Project revision.

A pending ghost node may appear immediately. Failure removes or marks the ghost
and offers retry; it never leaves a half-created Project item.

Keyboard users need an equivalent `Place at Map center` action. Full mobile
placement is deferred rather than emulated through fragile touch dragging.

### Markdown creation

Double-clicking empty Map space creates a local draft Markdown node at the
pointer position and immediately focuses its editor.

- the draft is not persisted until it contains valid content or the user
  explicitly saves;
- `Escape` cancels an unsaved empty draft;
- only one Markdown node loads the full editor at a time;
- editing temporarily disables node dragging;
- existing Markdown nodes enter edit mode through an explicit action or
  double-click;
- Map and Reading edit the same canonical Markdown source.

### Attachment creation

Generic Project-owned attachments are created through:

- an `Add attachment` operation;
- a Map context menu at an exact coordinate; and, later if useful,
- direct local-file drop onto the Map.

A context-menu insertion uses the clicked coordinate. A toolbar insertion uses
the viewport center or another documented deterministic default.

Existing source attachments are not copied through this path; they remain
references found through the sidebar.

## Node behavior

### Selection and navigation

- click node body: select and open/update Inspector;
- drag node handle/body non-interactive area: move;
- drag resize border: resize;
- double-click empty space: create Markdown;
- double-click or explicit Edit on Markdown: edit;
- click hover/selected/focused `Open reference`: navigate to source;
- drag one of four connection handles: create an edge;
- right-click: context menu.

Interactive controls and editor regions must not initiate node dragging.

### Resize semantics

Node resize changes `width` and `height`, never font size or source content.

Markdown nodes reflow text when width changes and expose more or less content
when height changes. Non-editing nodes clip or fade overflow. Reading always
renders the complete Markdown source independent of Map node dimensions.

Reference nodes use size-dependent information density:

- small: type and title;
- medium: title, source context, and lifecycle/status summary;
- large: context, bounded excerpt, and an available lightweight thumbnail.

Attachment nodes use the same dimensions for display range. Images use
`object-fit: contain`; file bytes are never transformed by node resize.

Canvas viewport zoom and node resize remain different concepts. Contextual zoom
may replace rich node content with lightweight summaries at low zoom.

## Edges

The first edge model uses:

- Bezier rendering only;
- top, right, bottom, and left handles;
- one fixed source handle and target handle after creation;
- endpoint marker values `none | arrow`;
- optional short free-text labels;
- no self-loop;
- deletion and recreation to change endpoints or handles.

Direction is represented by endpoint markers:

```text
start none   end none    undirected
start none   end arrow   forward
start arrow  end none    reverse
start arrow  end arrow   bidirectional
```

No first-version edge routing, obstacle avoidance, draggable control points,
relation ontology, or automatic handle reassignment is required. Edges may pass
beneath or near other nodes. Node movement causes ordinary React Flow Bezier
recalculation.

Exactly duplicate endpoint/handle/direction edges should be prevented in the UI,
while parallel edges with a meaningful difference may remain possible.

## Reading projection and first-version order

Reading contains every active Project item occurrence and provides no creation
operations. It allows:

- complete rendering of existing items;
- editing existing Project-owned Markdown;
- editing allowed metadata of existing Project-owned attachments; and
- opening references and Inspector.

Reference blocks remain read-only. Mobile defaults to this projection and keeps
the same limited editing boundary.

### Initial deterministic order

The first Project release orders Reading strictly by immutable Project-local
insertion sequence:

```text
created_sequence ascending
project_item.id ascending as a deterministic tie-breaker
```

`created_sequence` is assigned transactionally when the Project item occurrence
is created and is never rewritten by Map position, node movement, edge direction,
or content edits. Every active occurrence therefore appears in Reading without a
separate Reading-placement row.

The initial release has no manual Reading reorder, `position_key`,
`reading_role`, topological sort, or cycle-resolution UX. Visual arrows express
Map relationships only and never affect Reading order.

A later phase may introduce explicit custom ordering or an edge-informed linear
projection after real Project use demonstrates the need. That later decision may
add a dedicated ordering model and migration; Phase 3A should not reserve
speculative columns or tables now.

## Markdown and mixed media

Project-owned text is stored as Markdown source, not editor-proprietary JSON.
The target first-version dialect is CommonMark/GFM-style Markdown plus TeX math.
It excludes raw HTML, MDX/JSX, floating images, text wrapping around media,
columns, and page-layout controls.

Mixed media is block/occurrence based:

```text
Markdown occurrence
Reference occurrence
Image/file occurrence
Markdown occurrence
```

References and attachments are not embedded as custom editor-owned nodes inside
Markdown. Map and Reading render the same occurrence sequence using different
layouts.

The specific Markdown editor library is selected only after the Project item,
Map, save, and Reading contracts are validated. Read mode should not require the
full editor bundle; only the active Markdown node loads editing code.

## Save, autosave, and undo

React Flow state is never the database model. The server persists normalized
Project rows and compact mutations:

- create/remove item occurrence;
- create/update Project-owned content;
- create/update Map placement;
- create/update/delete edge.

Drag and resize update local state continuously but persist only at semantic
boundaries such as drag stop and resize end. Text edits use an idle debounce,
blur, explicit Save, or another documented flush boundary.

The initial persistence model is:

```text
local draft
+ pending normalized deltas
+ explicit Save button
+ bounded autosave on idle and semantic operation boundaries
```

Save always flushes pending deltas. UI shows `Saved`, `Saving`, `Unsaved`, and
`Conflict/Error` state.

Undo/redo is client-session only. It operates on local commands/current state;
a subsequent save persists the restored current state as an ordinary new
revision. There is no requirement to permanently store every drag, resize,
keystroke, or undo command.

Coarse Project history/checkpoints may be added later, but they are separate
from session undo and should not promise restoration to every intermediate UI
state.

## Concurrency reservation

Real-time collaborative editing is not an initial goal. The initial system uses
optimistic concurrency:

- stable item/content/edge IDs;
- a monotonic Project revision or equivalent expected-version token;
- optional per-content revision where needed;
- `updated_at` and `updated_by` metadata;
- idempotent operation IDs for retryable mutations;
- `409` conflict instead of silent last-write-wins.

This boundary preserves a future path to multi-user editing without adding CRDT,
OT, WebSocket presence, or live cursor complexity now. A future collaboration
project may replace transport and conflict handling, but should not need to
replace Project identities or normalized storage.

## Preview boundary

PDF and webpage preview are not Project-alpha requirements.

The schema should allow attachment preview metadata and derived thumbnails.
Later PDF support may render a first-page thumbnail in a sufficiently large node
and a fuller viewer in Inspector/modal, with lazy loading and memory limits.

Live webpage iframe embedding is excluded. A later webpage capture service may
create a screenshot attachment plus title/domain/source URL metadata after a
separate security review.

## Performance budget

The first Canvas should be designed for ordinary Projects with approximately
200–300 nodes and 300–500 edges, with stress testing around 500 nodes and 800
edges. These are engineering targets, not hard data limits.

From the first Map slice:

- custom nodes and edges are memoized;
- node types, edge types, and callbacks have stable identities;
- sidebar and Inspector do not subscribe to every live node coordinate;
- only the active Markdown node loads the editor;
- low zoom renders lightweight summaries;
- large images and later PDF previews load lazily;
- drag/resize produce no per-frame network writes;
- expensive visual effects and continuous animations are avoided.

## Schema implications to freeze before Phase 3A

The first Project migration set must be compatible with:

```text
projects
project_contents                 markdown or generic attachment owner records
project_content_attachments     stable attachment occurrence -> blob records
project_items                    Project-local occurrences; content XOR reference; immutable created_sequence
project_map_placements           one active placement per occurrence
project_edges                    Project-local edges with fixed handles/markers; no Reading-order field in v1
```

Every active Project item occurrence has one Map placement and automatically
appears in Reading through `project_items.created_sequence`. The first version
does not persist a separate Reading placement.

The migration must not:

- collapse content and occurrence identity;
- impose uniqueness on one reference per Project;
- store React Flow JSON as the only representation;
- add editable local metadata to external references;
- assume any Map edge affects first-version Reading order;
- add speculative Reading-order tables or columns before a concrete later design;
- require permanent operation history or real-time collaboration.

## Implementation sequence

1. **Phase 3A — Project core schema and save contracts**: normalized identities,
   generic attachments, immutable creation sequence, Map placements, edges,
   revisions, authoritative reference insertion, removal, export, and
   D1/workerd gates.
2. **Phase 3B1 — Map kernel**: dynamic React Flow, pan/zoom, selection, move,
   resize, save state, and lightweight nodes.
3. **Phase 3B2 — Reference sidebar and placement**: search, desktop drag/drop,
   pending nodes, keyboard center placement, authoritative insertion.
4. **Phase 3B3 — Project-owned creation**: double-click Markdown, generic Add
   attachment, image/file rendering, and automatic insertion-order Reading
   inclusion.
5. **Phase 3B4 — Basic edges**: four handles, Bezier, endpoint direction, label,
   delete/recreate behavior.
6. **Phase 3C — Reading projection**: no creation, complete insertion-order
   rendering, and editing of existing owned content.
7. **Phase 3D — Editor and media hardening**: Markdown/TeX editor, attachment
   previews, save/conflict UX, and accessible Reading presentation.
8. **Phase 4 — Advanced Canvas**: Inspector depth, groups, copy/paste,
   multi-select hardening, PDF preview, screenshot capture, advanced performance,
   and optional order/layout tooling.

## Deferred questions

The following do not block Phase 3A provided the schema reservations above are
kept:

- whether later versions need manual or edge-informed Reading order;
- group/frame nodes;
- node and edge color customization;
- exact MiniMap behavior;
- full PDF viewer and thumbnail pipeline;
- webpage screenshot service;
- JSON Canvas import/export;
- collaboration technology;
- permanent Project checkpoints;
- complex edge routing and relation taxonomies.
