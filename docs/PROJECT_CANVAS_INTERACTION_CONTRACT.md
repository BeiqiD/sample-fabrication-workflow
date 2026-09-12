# Project Canvas interaction contract

Status: canonical product and architecture contract; Phase 4C is complete in PR #151

Last reviewed: 2026-09-11 for the user-authorized interaction, editing, and recovery revision

This document defines the intended Project workspace. Phase 3A1, implemented in
PR #131, freezes the normalized schema; PR #132 implements the completed Phase
3A2 authoritative read/write transactions; merged PR #133 delivers the bounded
desktop React Flow Map kernel; merged PR #134 delivers Phase 3B2 reference
discovery and authoritative placement; merged PR #135 delivers bounded Phase
3B3 Project-owned Markdown and generic attachment creation; merged PR #136 delivers
Phase 3B4 basic Project-local edges without widening the normalized graph model.
This document supersedes any older statement that Text is the primary Project
workspace or that Map and Text are independent content systems.

The canonical product order is recorded in [PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md).
The Phase 3A1 database guarantees are recorded in
[PROJECT_CORE_IMPLEMENTATION_PLAN.md](./PROJECT_CORE_IMPLEMENTATION_PLAN.md), and
the completed Phase 3A2 service guarantees are in
[PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md](./PROJECT_PERSISTENCE_SERVICE_IMPLEMENTATION_PLAN.md).
The Phase 3B2 mutation-state details are in
[PROJECT_REFERENCE_PLACEMENT_IMPLEMENTATION_PLAN.md](./PROJECT_REFERENCE_PLACEMENT_IMPLEMENTATION_PLAN.md).
The Phase 3B3 content-creation boundary is in
[PROJECT_OWNED_CONTENT_IMPLEMENTATION_PLAN.md](./PROJECT_OWNED_CONTENT_IMPLEMENTATION_PLAN.md).
The Phase 3B4 edge mutation, retry, history, and verification boundary is in
[PROJECT_EDGES_IMPLEMENTATION_PLAN.md](./PROJECT_EDGES_IMPLEMENTATION_PLAN.md).
The Phase 3C projection/editing boundary is in
[PROJECT_READING_IMPLEMENTATION_PLAN.md](./PROJECT_READING_IMPLEMENTATION_PLAN.md).
The completed Phase 4B slice boundaries are in
[PROJECT_CANVAS_PRODUCTIVITY_IMPLEMENTATION_PLAN.md](./PROJECT_CANVAS_PRODUCTIVITY_IMPLEMENTATION_PLAN.md).
The Phase 4C scale, contextual-zoom, and final v1 decision boundary is in
[PROJECT_MAP_PERFORMANCE_IMPLEMENTATION_PLAN.md](./PROJECT_MAP_PERFORMANCE_IMPLEMENTATION_PLAN.md).
The stable reference, lifecycle, search, and storage boundaries remain in their
existing focused documents.

## Current authorized UX revision

On 2026-09-11 the user authorized implementation of the whole-workflow UX review,
including repairs beyond the original PR's presentation scope. The current rules
below supersede earlier selection-opens-Inspector, creation-free Reading/mobile,
fixed-edge-endpoint, and placement-only Save rules. Completed Phase 3/4 records
remain historical. Integrated results and remaining acceptance boundaries are
recorded in `PROJECT_UX_REPAIR_ACCEPTANCE.md`; the PR remains Draft.

Identity, immutable Reading order, revision checks, exact operation replay,
uncertain-outcome protection, and attachment trust remain authoritative. Edge
reconnection is the explicit schema exception in migration
`0036_project_edge_reconnection.sql`; it does not introduce a new graph model.

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

Attachment state is divided deliberately:

- the locator, original filename, MIME type, byte size, creation actor/time, and
  creation operation are intrinsic file metadata and cannot be retargeted or
  edited in place;
- caption and optional source URL/provenance are revisioned Project-owned
  descriptive metadata and may be edited from Map, Reading, or Inspector;
- recoverable lifecycle belongs to the parent Project content record rather than
  being duplicated on the intrinsic-file subtype.

Replacing attachment bytes therefore creates new Project-owned content. Editing
a caption or source URL never changes the stored file.

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
- edit attachment caption/source URL without replacing bytes;
- create and edit basic edges;
- use client-session undo/redo;
- save explicitly and through bounded autosave.

### Mobile

Mobile defaults to Reading. It does not provide full Canvas editing.

The current mobile contract permits:

- reading the complete Project and opening reference sources;
- Add > Markdown, Attachment, and Reference using the same route-owned mutations
  and deterministic default placements as desktop Reading;
- editing Project-owned Markdown and attachment caption/source URL;
- recoverable item removal and restoration through the guarded lifecycle paths;
- reviewing immutable insertion order without displaying it as gap-prone numbering;
- viewing details and using an accessible expanded editor or reference picker.

Mobile excludes an editable Canvas, touch coordinate placement, resizing, edge
creation/editing, and Canvas selection gestures. It does not gain byte replacement,
a separate content system, or a separate mutation controller.

## Map creation interactions

### Reference insertion

The left sidebar or Project operation area contains the reusable reference
search surface. On desktop, a result can be dragged to an exact Map coordinate.
The drag payload contains only the stable `ReferenceTarget` and display-safe
preview data.

No Project or registry row is written when dragging starts. A successful drop
starts one authoritative server operation that:

1. validates Project write access and the expected Project revision;
2. re-resolves the selected target;
3. idempotently registers or refreshes `reference_targets`;
4. reserves and advances the immutable per-Project creation sequence;
5. creates one new Project item occurrence;
6. creates its Map placement; and
7. returns the canonical inserted item and Project revision.

All steps occur in one rollback-safe transaction. The database permits zero or
one placement row per item, but the service never commits a newly created active
item without its placement.

A pending ghost node appears immediately after the placement command and remains
renderer-only until an authoritative response is known. Known non-commit
validation/conflict responses may be retried or discarded according to their
explicit response. A transport, timeout, rate-limit, or 5xx result is different:
it is **uncertain**, because the transaction may have committed before the
response was lost.

For an uncertain insertion, the client preserves the complete original request
and operation ID. Retry exact-replays that request. Direct local cancellation is
forbidden; cancellation first exact-replays/reconciles the original item and
placement identity. If the occurrence is confirmed, cancellation uses the
normal Project-local recoverable removal route. If it cannot be safely
reconciled, the user receives an explicit conflict rather than a guessed delete
or a hidden local ghost.

Keyboard/click Place chooses a bounded free position near the visible Map center
when the Map is mounted; Reading/mobile uses the documented deterministic default.
Exact pointer drops keep their coordinate. Existing nodes are never rearranged.
The Suggested type filter is applied before the display cap; bounded upstream
truncation or partial failure is visible and cannot imply an exhaustive empty
result. Mobile uses a picker and Place, not touch dragging on a hidden Canvas.

### Markdown creation

Double-clicking empty Map space creates a local draft Markdown node at the
pointer position and immediately focuses its editor.

- the draft is not persisted until it contains valid content or the user
  explicitly saves;
- `Escape` cancels an unsaved empty draft;
- only one Markdown node loads the full editor at a time;
- editing temporarily disables node dragging;
- existing Markdown nodes enter edit mode through Edit or title/chrome double-click;
  double-clicking rendered body text preserves ordinary word selection;
- Map, Reading, and the expanded editor share one draft and canonical Markdown
  source; changing editor presentation must not create a new operation identity;
- active-editor Save and Ctrl/Command+S save that draft; safe navigation offers
  Save and leave as well as Stay / Discard, while unresolved outcomes remain guarded;
- persistence creates the content, item occurrence, creation sequence, and Map
  placement atomically.

### Attachment creation

Generic Project-owned attachments are created through:

- an `Add attachment` operation;
- a Map context menu at an exact coordinate; and, later if useful,
- direct local-file drop onto the Map.

A context-menu insertion uses the clicked coordinate. A toolbar insertion uses
the viewport center or another documented deterministic default.

After blob upload/registration succeeds, the authoritative Project transaction
creates the attachment content, immutable intrinsic-file subtype, item
occurrence, creation sequence, and placement together. Failure cannot leave a
committed item without a placement or a Project attachment occurrence without
its content owner.

Existing source attachments are not copied through this path; they remain
references found through the sidebar.

## Node behavior

### Selection and navigation

- click node body: select and expose local quick actions; update Inspector if it
  is already open, without opening or pinning it implicitly;
- press and drag any non-interactive card area, including rendered Markdown,
  reference excerpts and attachment previews: move without a prior selection click;
- drag any committed card's always-visible bottom-right corner: resize directly,
  without a preliminary selection click; edges and other corners do not resize;
- focus the resize grip and use arrow keys: adjust the corresponding dimension
  by 5 canvas units, or 20 with Shift, without moving the card;
- double-click empty space: create Markdown;
- Markdown body/title/chrome double-click or explicit Edit: edit;
- reference/attachment body/title/chrome double-click: open Details;
- Reading and Inspector content retain native text selection/copy; Map card
  previews use selection/copy/delete shortcuts for cards and retain scrolling;
- edit attachment caption/source URL through an explicit metadata action;
- click hover/selected/focused `Open reference`: navigate to source;
- drag one of four connection handles: create an edge;
- Details: explicitly open Inspector; Pin is a separate action;
- right-click or More: the same context commands, with grouped alignment/layer
  entries and destination-accurate Open source / Open attachment labels.

Interactive controls and editor regions must not initiate node dragging.
Links, scrollbars, the resize grip and connection handles retain their own gestures.
Every committed card displays a 36-unit triangular resize corner integrated into
its border. It scales with the card, with reserved content clearance and the
source link offset away from the corner. Resizing only affects that card's
dimensions and preserves the existing selection. Editing or a geometry lock
hides the control without reclaiming its content clearance during a lock.
Resize retains the existing 180–1200 width
and 110–1000 height limits, Save, Undo and Redo behavior, and stored position/layer.
An acknowledgement for another card must not replace the position or dimensions
of a card while its pointer drag or resize is still active. Fresh content and
selection still apply; deleted/replaced/locked cards must not be resurrected.

Phase 4B multi-selection uses only Project item occurrence IDs:

- Shift drag creates a partial-intersection selection box;
- Shift, Control, or Command click adds to or removes from the current selection;
- the most recently selected occurrence is the primary selection for Inspector,
  but that primary role is transient UI state;
- dragging any selected node or using an arrow key moves all selected committed
  occurrences together;
- one grouped movement becomes one client-session geometry history command;
- Inspector detail, resize, and content editing remain single-item operations;
  removal may target the whole committed selection through the bounded removal
  journal described below;
- pending placement ghosts and unsaved draft nodes do not become ordinary bulk
  selection targets;
- `ProjectPage` owns the accepted occurrence IDs. If an editor lock or unsafe edge
  operation rejects a React Flow selection proposal, the Map restores the current
  authoritative selection immediately instead of retaining a visual-only selection.

`Ctrl/Command+A` selects all committed Map occurrences, `Escape` clears selection,
`Ctrl/Command+Z` undoes, `Ctrl/Command+Shift+Z` or `Ctrl/Command+Y` redoes, and
`Ctrl/Command+S` saves the active editor first, otherwise flushes placement saves.
Canvas selection, movement, history, clipboard, and Delete/Backspace shortcuts do
not take over inputs, textareas, selects, contenteditable regions, textbox roles,
rendered reading text, or IME composition. The Save chord is the explicit exception
inside the active Project editor. It is still consumed when Save is
disabled by saved/saving/conflict or another active operation, so it becomes a
safe Project no-op rather than opening the browser Save Page dialog. Selection is
never persisted or exported.

A Project-local occurrence removal is a mutation boundary. It starts only from a
safely saved placement state, retains one exact lifecycle request and operation
ID until the outcome is known, and freezes Map geometry interaction while the
removal is unresolved. This prevents drag, keyboard move, resize, or undo/redo
from creating a placement write that races a committed removal. Navigation and
hard refresh/close remain protected until the removal is authoritatively
resolved.

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

Canvas viewport zoom and node resize remain different concepts. At the Phase 4C
representative target and larger envelope, three presentation-only contextual-zoom
bands use hysteresis: full detail mounts existing previews, excerpts, and edge
labels; compact keeps identity and context; overview keeps type and title. Ordinary
maps remain full-detail at every viewport zoom so their established labels, handles,
and actions never disappear merely because `fitView` selected a small scale. React
Flow connection handles remain mounted as geometry anchors, but are visually hidden
and non-connectable outside full detail on target/envelope maps unless the occurrence
is primary-selected. The primary selected occurrence retains a bounded action
surface. These bands never change persisted geometry or content.

### Geometry boundary

Shared TypeScript validation and SQLite use the same finite bounds:

- `x` and `y`: `-1,000,000` through `1,000,000`;
- `width` and `height`: greater than zero and at most `100,000`;
- integer `zIndex`: `-1,000,000` through `1,000,000`.

`NaN`, positive or negative infinity, and values outside these bounds are invalid
before persistence and are rejected again by the database.

## Edges

The first edge model uses:

- Bezier rendering only;
- top, right, bottom, and left handles;
- explicit source/target handles, mutable through guarded reconnection;
- endpoint marker values `none | arrow`;
- optional short free-text labels;
- no self-loop;
- reconnect either endpoint/handle while retaining the edge's identity, label,
  direction, and provenance.

Reconnection is a revisioned edge update carrying all endpoint IDs, handles, and
expected endpoint-item revisions together. The Worker validates active same-Project
endpoints, no self-loop, handles, duplicates, and the expected edge revision.
Migration `0036_project_edge_reconnection.sql` permits these semantic endpoint
changes while preserving immutable edge ID, Project ID, and creation provenance;
it requires one revision advance and a fresh mutation ID. Lost responses exact-retry
the frozen update; undo/redo uses a guarded inverse update, not delete/recreate.

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

Reading contains every active Project item occurrence and exposes Add through the
same page-owned content and placement operations as Map. It allows:

- complete rendering of existing items;
- editing existing Project-owned Markdown;
- moving an existing Project-owned Markdown occurrence to Trash through the
  guarded item/content lifecycle operation;
- editing attachment caption and optional source URL;
- removing and restoring attachment or reference occurrences through their
  Project-local lifecycle paths, without mutating an external source;
- never retargeting attachment bytes or intrinsic filename/type/size metadata;
- opening references and Inspector.

Reference blocks remain read-only for their external source. Reading and mobile
can place another reference without modifying the source. Edit/Open actions stay
at the card header, removal and export use More, and a new shared Markdown draft
renders before committed items until saved or safely canceled.

### Initial deterministic order

The first Project release orders Reading strictly by immutable Project-local
insertion sequence:

```text
created_sequence ascending
project_item.id ascending as a deterministic tie-breaker
```

`created_sequence` is assigned transactionally when the Project item occurrence
is created and is never rewritten by Map position, node movement, edge direction,
or content edits. Every committed active occurrence therefore appears in Reading
without a separate Reading-placement row.

The initial release has no manual Reading reorder, `position_key`,
`reading_role`, topological sort, or cycle-resolution UX. Visual arrows express
Map relationships only and never affect Reading order.

Phase 4C explicitly defers custom Reading ordering for v1. Immutable insertion
sequence remains predictable and avoids a second ordering model. Reopening this
decision after feature freeze requires a demonstrated use case and a separate
ordering contract rather than speculative columns or edge-derived ordering.

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
- create/update Project-owned Markdown or attachment description;
- create/update Map placement;
- create/update/delete edge.

Intrinsic attachment bytes and file metadata are create-once; replacing them is
a new content operation rather than an update mutation.

Drag and resize update the local working copy immediately. Placement persistence
is asynchronous and may remain `Unsaved` or `Saving` after the geometry already
behaves as the current UI truth. Text and attachment-description edits use an
idle debounce, blur, explicit Save, or another documented flush boundary.

Dirty or in-flight placement persistence is not a global workspace mutation lock.
Operations whose optimistic-concurrency tokens are independent of placement
revision — notably selecting or creating Project-local edges from stable item
occurrences — remain usable while geometry waits for autosave. Structural/content
mutations that share identity or authoritative revision domains keep their existing
serialization and retry rules.

The initial persistence model is:

```text
local draft
+ pending normalized deltas
+ explicit Save button
+ bounded autosave on idle and semantic operation boundaries
```

Save targets the active Markdown, attachment metadata, or edge editor before
placement deltas. Status must not say Saved while a draft remains uncommitted.
Correctable validation/server rejection keeps editable fields and the draft intact;
conflict requires reconciliation, while outcome-uncertain writes keep their exact
frozen payload and cannot be freely edited or discarded. UI distinguishes Saved,
Unsaved, Saving, Conflict, Error, and uncertain/reconciling state.

Expanded Markdown is the same editor session, not a second draft. Save and leave
may continue navigation only after that session commits and all existing
operation/navigation guards have cleared.

Undo/redo is client-session history, but persistence depends on command type:

- **Geometry undo/redo** applies one or several inverse placement geometries
  locally. A grouped drag or keyboard movement is one history command, while the
  restored current geometries still follow the ordinary bounded autosave / explicit
  Save path and persist as independent placement revisions.
- **Edge undo/redo** immediately dispatches the authoritative inverse edge
  mutation (`update`, `delete`, or `restore`) with the current authoritative edge
  revision and a new operation ID. The history stack advances only after that
  inverse mutation succeeds; an uncertain outcome must exact-retry the frozen
  inverse request before history may move.

### Recoverable item removal and Trash

Reference removal deletes only the Project occurrence, retaining the source record.
Markdown/attachment removal uses the existing Project-owned item/content lifecycle
operation. Trash exposes a restore path rather than an unrecoverable label.

Single and bulk removal freeze the target set and execute ordinary revision-guarded
item operations sequentially. Acknowledged removals stay visible as partial progress;
uncertain requests retain the exact payload/operation ID, stop later work, and keep
selection, geometry, and navigation guards until settlement and authoritative
snapshot reconciliation. The UI must not claim a bulk atomic transaction.

The latest deletion group can be restored through the recovery toast or Trash.
Immediately after deletion, global Undo prioritizes restoring that group. A later
geometry or edge-history action clears that priority so global Undo again targets
the newer history action; the dedicated restore paths remain available. This does
not place content typing, creation, or every user action into global Undo history.

Restoration restores the same item/content identity and original insertion sequence.
Cascaded edges may be restored only when both endpoints are active and their
`deletionOperationId` still identifies this removal; edges deleted independently
before the item removal must not be resurrected. Restore journals keep partial
acknowledgements and uncertain exact retries until authoritative reconciliation.

There is no requirement to permanently store every drag, resize, keystroke, or
undo command.

Coarse Project history/checkpoints may be added later, but they are separate
from session undo and should not promise restoration to every intermediate UI
state.

## Concurrency reservation

Real-time collaborative editing is not an initial goal. The initial system uses
optimistic concurrency:

- stable item/content/edge IDs;
- monotonic Project and content revisions or equivalent expected-version tokens;
- revision metadata that cannot be rewound, pre-bumped, or changed without a
  semantic mutation;
- `updated_at` and `updated_by` metadata;
- idempotent operation IDs for retryable mutations;
- `409` conflict instead of silent last-write-wins.

This boundary preserves a future path to multi-user editing without adding CRDT,
OT, WebSocket presence, or live cursor complexity now. A future collaboration
project may replace transport and conflict handling, but should not need to
replace Project identities or normalized storage.

## Preview boundary

PDF and webpage preview are not Project-alpha requirements.

The schema may later add derived preview metadata and thumbnails without
retargeting the stable intrinsic attachment. Later PDF support may render a
first-page thumbnail in a sufficiently large node and a fuller viewer in
Inspector/modal, with lazy loading and memory limits.

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

## Frozen Phase 3A schema implications

The first Project migration set uses:

```text
projects
project_contents                 markdown or attachment owner; revisioned caption/source URL
project_content_attachments      immutable intrinsic attachment -> blob record
project_items                    Project-local occurrences; content XOR reference; immutable created_sequence
project_map_placements           zero or one DB row per item; exactly one through authoritative creation
project_edges                    Project-local edges with explicit handles/markers; no Reading-order field in v1
```

Every committed active Project item occurrence has one Map placement and
automatically appears in Reading through `project_items.created_sequence`. The
first version does not persist a separate Reading placement.

The migration and service must not:

- collapse content and occurrence identity;
- impose uniqueness on one reference per Project;
- store React Flow JSON as the only representation;
- add editable local metadata to external references;
- permit intrinsic attachment locators or file metadata to be retargeted;
- commit an active item without its placement;
- accept non-finite or unbounded Map geometry;
- allow revision rewind, pre-bump, or duplicate-version reuse;
- assume any Map edge affects first-version Reading order;
- add speculative Reading-order tables or columns before a concrete later design;
- require permanent operation history or real-time collaboration.

## Implementation sequence

Phase 3 and Phase 4A are complete through PR #147. Phase 4B Canvas productivity is
active with this bounded sequence:

1. **Phase 4B1 — multi-selection and grouped geometry**: complete in PR #148,
   including bounded keyboard shortcuts and the permanent productivity gate.
2. **Phase 4B2 — authoritative copy/paste**: duplicate Project-owned content only
   through correct fresh identities, preserve Reference source identity, and define
   exact multi-object retry behavior.
3. **Phase 4B3 — alignment assistance and z-order**: helper lines and explicit
   layering over ordinary placement commands without persistent guide objects.
4. **Phase 4C — representative-scale performance and final include/defer
   decisions** before v1 feature freeze.

Groups/frames remain an explicit include/defer decision after the ordinary
productivity operations have been exercised in real Projects.

## Deferred questions

The following do not block the remaining Phase 4B work provided the frozen
contracts above are kept:

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
