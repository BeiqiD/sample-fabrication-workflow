# Project design foundation

Status: current product and architecture contract before Phase 3 schema work

Last reviewed: 2026-08-09 after the Map-first Project interaction review

This document defines the durable Project identity and ownership model. The
canonical phase order is in [PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md). Detailed
Map, Reading, save, edge, mobile, preview, and performance behavior is in
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md).

The longer Text-first design record that preceded the Map-first decision is
preserved in `PROJECT_DESIGN_FOUNDATION_LEGACY.md` for history. Where it
conflicts with this document, the current roadmap and Canvas contract govern.

Source identity and recoverable deletion are defined in
[V3_BACKEND_FOUNDATION.md](./V3_BACKEND_FOUNDATION.md). Physical-byte retention,
export integrity, and permanent-delete safety remain defined in
[BLOB_LIFECYCLE_CONTRACT.md](./BLOB_LIFECYCLE_CONTRACT.md).

## Purpose

Project is a Map-first research workspace over one set of Project-local item
occurrences. It combines:

- Project-owned Markdown;
- Project-owned generic attachment occurrences; and
- read-only references to external source objects.

It exposes two projections over the same occurrences:

- **Map** is the primary desktop creation and spatial-organization interface.
- **Reading** is one linear review/editing projection and the default mobile
  interface.

Map and Reading never own separate copies of content. Editing one Project-owned
Markdown item changes what both views render.

Project is not:

- a task, approval, progress, or Project-status system;
- a second editor for Samples, Runs, Steps, Comments, Recipes, or source files;
- a fixed folder or subproject tree;
- a data-analysis notebook or simulation database;
- a page-layout or desktop-publishing system;
- a React Flow JSON document used as the database;
- a real-time collaborative whiteboard in the initial release.

## Source and Project ownership

External experimental records remain authoritative and editable only in their
source interfaces. Project can include, resolve, inspect, connect, remove, and
navigate references, but it cannot mutate those sources.

Project owns only:

- Markdown source created inside the Project;
- generic file/image/PDF attachment occurrences uploaded to the Project;
- Project-local item occurrences;
- Map placements and sizes;
- Reading positions;
- Project-local edges and labels; and
- Project metadata such as title and lifecycle fields.

Existing Comment attachments, execution images, metrology references, Recipes,
Runs, Steps, Samples, and future external Projects enter through the reference
boundary. They are not copied into Project-owned attachments.

## Product invariants

### No Project workflow status

A Project has no Active, Completed, or progress workflow. Recoverable deletion
is a record-lifecycle operation, not a Project status.

### No fixed parent tree

Projects do not require `parent_project_id`. A future Project can reference
another Project, and several Projects may reference the same target.

### External references are strictly read-only

A reference occurrence has no editable local title, caption, description, or
annotation override. Its visible source fields come from the resolver.
Interpretation belongs in a separate Markdown occurrence or an optional edge
label.

`Open reference` is an explicit hover/selected/focused control. Clicking a node
body selects it and opens Inspector; it does not navigate.

### Repeated reference occurrences are valid

The same `reference_target` may appear several times in one Project and in
several Projects. Every appearance is a distinct `project_item.id` with its own:

- Map placement and dimensions;
- Reading position;
- incoming and outgoing edges; and
- creation order.

No `UNIQUE(project_id, reference_target_id)` constraint is permitted.

If backlink UI is added later, the ordinary product measure is Project presence
through `COUNT(DISTINCT project_id)`, not the raw occurrence count. A dedicated
backlink table or backlink UI is not required for Project alpha or MVP.

### Content, occurrence, and placement identities stay separate

The Project model preserves these layers:

1. source or Project-content identity;
2. external reference-registry identity;
3. Project-local item occurrence identity;
4. Map placement identity;
5. Reading placement identity.

Edges point to Project item occurrences because they express local Project
meaning. They never point directly to source rows or blob records.

### Every active occurrence appears in both projections

Each active Project item occurrence has:

- one active Map placement; and
- one active Reading placement.

One may initially be auto-generated, but Map-only and Reading-only content are
not first-version states. Coordinates and Reading order are different metadata
over the same occurrence.

## Conceptual data model

Names and exact columns remain subject to migration review, but the first schema
must preserve this shape:

```text
projects
- id
- title
- created_by
- updated_by
- created_at
- updated_at
- revision
- deleted_at
- deleted_by

project_contents
- id
- owner_project_id
- content_kind                # markdown | attachment
- markdown_source             # markdown only
- format_version
- created_by
- updated_by
- created_at
- updated_at
- revision
- deleted_at
- deleted_by

project_content_attachments
- id
- project_content_id
- asset_id / storage_object_id
- original_filename
- media_type
- size_bytes
- caption
- source_url                  # optional screenshot provenance
- created_at
- updated_at
- deleted_at
- deleted_by

project_items
- id
- project_id
- item_kind                   # content | reference
- project_content_id          # exactly one target column populated
- reference_target_id
- created_sequence
- created_at
- deleted_at
- deleted_by
- CHECK(exactly one target matches item_kind)

project_map_placements
- project_item_id
- x
- y
- width
- height
- z_index
- updated_at

project_reading_placements
- project_item_id
- position_key
- updated_at

project_edges
- id
- project_id
- source_item_id
- target_item_id
- source_handle               # top | right | bottom | left
- target_handle
- marker_start                # none | arrow
- marker_end                  # none | arrow
- label
- reading_role                # reserved: none | precedes
- created_at
- updated_at
- deleted_at
```

Required constraints:

- a Project item targets exactly one Project-owned content object or one
  reference-registry row;
- Project-owned content is edited only from its owner Project;
- external source content is never copied into editable Project columns;
- repeated reference occurrences are allowed;
- removing an occurrence removes only local placements and local edges;
- source rows, registry rows, other Projects, and shared blobs never cascade from
  local occurrence removal;
- Project-owned attachment occurrences reuse the existing occurrence-to-blob,
  retention, GC, and export contracts;
- React Flow serialization is never the sole persistent representation.

## Map

Map is the main desktop editor. The first interaction model supports:

- pan and zoom;
- selection and Inspector focus;
- node move and border resize;
- sidebar reference search and exact-position drop;
- double-click empty space to create Markdown;
- explicit or context-menu generic attachment insertion;
- top/right/bottom/left connection handles;
- Bezier edges with none/arrow markers at each endpoint;
- optional short free-text edge labels;
- explicit Save plus bounded autosave;
- client-session undo/redo.

Node resize changes width, height, wrapping, and visible range, not font size or
source content. A Reference node changes information density by size. Markdown
and attachment content remain complete in Reading regardless of Map dimensions.

Reference insertion starts no write at drag start. A successful drop invokes one
authoritative server operation that validates the Project, re-resolves the
target, registers or refreshes `reference_targets`, creates the item occurrence,
creates both placements, and returns the new Project revision.

## Reading

Reading renders every active occurrence linearly and provides no creation
controls. It may:

- read complete Markdown, attachments, and references;
- edit existing Project-owned Markdown;
- edit allowed Project-owned attachment metadata;
- open references and Inspector; and
- adjust linear order through an accessible control.

Mobile defaults to Reading. The initial mobile experience excludes item
creation, file upload, Canvas placement, resize, edge editing, and bulk Canvas
operations.

### Reading order reservation

Reading order should combine:

1. stable insertion/manual order; and
2. explicit ordered-arrow constraints.

The exact algorithm is intentionally deferred. The schema preserves:

- immutable `created_sequence`;
- editable insertion-friendly `position_key`; and
- edge `reading_role = none | precedes`, separate from visual arrow direction.

The leading candidate is a stable topological order over `precedes` edges, with
`position_key` and then creation sequence as deterministic tie-breakers. Cycles
must be surfaced instead of silently rewriting the Project. Until that phase,
new occurrences receive deterministic insertion order and Reading may use manual
reorder.

Map coordinates never continuously rewrite Reading order. Not every directed
semantic edge is automatically a narrative-order edge.

## Markdown and mixed media

Project-owned text uses canonical Markdown source rather than editor-specific
JSON. The target dialect is CommonMark/GFM-style Markdown plus TeX math.

The first version excludes raw HTML, MDX/JSX, floating media, text wrapping,
columns, and page-layout controls.

Mixed media is occurrence based:

```text
Markdown occurrence
Reference occurrence
Image/file occurrence
Markdown occurrence
```

References and Project attachments are not editor-internal custom nodes inside a
single mega-document. Only the active Markdown occurrence loads the full editor;
read mode and ordinary Map nodes use lightweight renderers.

## Edges

The first edge contract uses:

- Bezier rendering only;
- four fixed connection handles per node;
- fixed source/target handles after creation;
- `none | arrow` at each endpoint, supporting undirected, forward, reverse, and
  bidirectional edges;
- an optional short free-text label;
- deletion and recreation to change endpoints or handles;
- no self-loop;
- no obstacle avoidance, control points, automatic handle reassignment, or
  relation-type ontology.

Visual direction and Reading-order participation are separate fields.

## Inspector

Inspector carries detail that would make Map nodes or Reading blocks too large.
It may show:

- complete content and current source path;
- lifecycle state;
- directly related child summaries;
- exact `Open reference` and canonical Reference destinations;
- local removal actions; and
- later Project presence/backlink information.

Inspector never exposes source mutation controls. Adding a child reference uses
the same authoritative insertion operation as the sidebar.

## Search and insertion

The Phase 2C service is the common reference-discovery backend. Draft PR #130
provides the Project-embeddable `ReferenceSearchSurface`. The current `/search`
page is temporary integration scaffolding.

Search returns only a stable `ReferenceTarget` intent. Project insertion always
re-resolves at write time. A stale browser result cannot bypass lifecycle or
concurrency checks.

Project-owned Markdown and attachments use their own creation paths and do not
pass through reference search.

## Save, undo, history, and concurrency

React Flow state is not saved as one opaque document. The server persists
normalized mutations for items, content, placements, Reading order, and edges.

The first save model is:

```text
local draft
+ pending normalized deltas
+ explicit Save
+ bounded autosave on idle and semantic operation boundaries
```

Drag and resize update local state continuously but persist only at stop/end.
Save flushes pending changes and exposes Saved, Saving, Unsaved, and
Conflict/Error states.

Undo/redo exists only in the current client session. A later coarse checkpoint
or Project-version feature may preserve meaningful snapshots, but permanent
history does not record every move, resize, keystroke, or undo command.

Real-time collaboration is deferred. Initial APIs reserve a future path through:

- stable item/content/edge IDs;
- monotonic Project and optional content revisions;
- `updated_by` and `updated_at`;
- idempotent operation IDs; and
- explicit `409` conflicts instead of silent last-write-wins.

No CRDT, OT, WebSocket presence, or live cursor system is required now.

## Lifecycle, export, and portability

Ordinary Project deletion is recoverable. Removing one occurrence changes only
the current Project. External sources and shared bytes remain unchanged.

Adding Project requires a new complete-export schema version containing:

- Projects and Project-owned contents;
- Project attachment occurrences and reachable bytes;
- repeated Project item occurrences;
- Map and Reading placements;
- Project-local edges;
- revision metadata; and
- structured warnings for unavailable bytes.

Restore preserves all stable IDs exactly. Human-readable Markdown export uses
relative attachment paths and no authenticated or temporary URLs.

Cloudflare is the current deployment, not the domain model. Project logic,
revision rules, search contracts, and normalized persistence must remain usable
through later D1/SQLite, R2/local-object-storage, and authentication adapters.

## Preview boundary

PDF and webpage preview are not alpha requirements.

The attachment schema permits derived preview metadata. A later PDF feature may
show a first-page thumbnail in a sufficiently large node and a fuller viewer in
Inspector/modal.

Live webpage iframe embedding is excluded. A later security-reviewed capture
service may store a screenshot attachment with title, domain, and source URL
metadata.

## Roadmap

The active sequence is:

1. Phase 2C2 reusable Project discovery surface;
2. Phase 3A Project core schema, save/revision contract, placements, basic-edge
   schema, authoritative insertion, and export;
3. Phase 3B1 Map kernel;
4. Phase 3B2 reference sidebar and drag/drop placement;
5. Phase 3B3 Markdown and generic attachment creation;
6. Phase 3B4 basic Bezier directional edges;
7. Phase 3C no-creation Reading projection;
8. Phase 3D Markdown/TeX, media, save/conflict, and export hardening;
9. Phase 4 advanced Canvas, Inspector, PDF preview, screenshot capture, and
   performance work.

See [PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md) for completion criteria,
milestones, portability, search-performance, deletion-safety, and later-feature
tracks.

## First-version non-goals

- Project status, progress, or task management;
- fixed subproject hierarchy;
- source mutation from Project;
- local annotation overrides on references;
- one-reference-per-Project uniqueness;
- automatic expansion of a complete source hierarchy;
- assuming every directed edge defines Reading order;
- complex page layout;
- live webpage embedding;
- real-time collaboration;
- semantic search as a dependency;
- React Flow JSON as the sole Project representation;
- allowing an LLM to mutate experimental source records.

## Dependency and licensing boundary

React Flow is selected and license-verified when Phase 3B1 begins. It is not
required for Phase 3A schema work. Any Markdown editor, TeX renderer, PDF
renderer, or preview dependency is selected only in its corresponding slice and
must not determine the persistent Project model.
