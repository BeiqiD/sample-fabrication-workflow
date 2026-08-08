# Project design foundation

Status: product and architecture contract; physical schema and UI details remain
subject to implementation review

Last reviewed: 2026-08-08 after PR #128 source-focus review

This document defines how Project, Text, and Map fit into Sample Fabrication
Workflow. It records product and identity decisions that must survive
implementation while keeping provisional table, route, and component names
separate from those decisions.

The source identity and soft-delete prerequisites are defined in
[v3 backend foundation](./V3_BACKEND_FOUNDATION.md). Physical byte retention,
export integrity, and permanent-delete safety are defined in
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md). Project implementation
must not bypass either contract.

## Purpose

Project is a hierarchy-aware, link-based research workspace. It combines
Project-owned text, images, and files with read-only references to Samples,
Runs, Steps, Comments, attachment occurrences, Recipe revisions, other
Projects, and content owned by other Projects.

Project is not:

- a task or progress system;
- a second editor for experimental records;
- a fixed tree or folder hierarchy;
- a replacement for the natural Sample → Run → Step hierarchy;
- a data-analysis environment.

Project exposes two complementary views over the same items:

- **Text** provides a deliberate reading and writing order.
- **Map** provides spatial organization and user-defined connections.

The views share content and references but keep independent placement data.

## Why source lifecycle came first

Project references cannot be made safe by adding Project tables alone. Before
PR #120, several ordinary delete paths physically removed source rows or
rewired their graph. A Project item pointing to such a row would either break,
disappear through cascade, or require a copied snapshot that immediately became
stale.

The source-lifecycle conversion therefore preceded Project work for five
reasons:

1. **Stable identity**: Sample, Run, Step, Comment, Recipe revision, and
   attachment occurrence IDs must survive ordinary Delete and Restore.
2. **Canonical meaning**: one logical Comment must not be reconstructed from
   duplicated step occurrences or timeline events.
3. **Read-only resolution**: a Project reference must resolve current source
   data and source path without gaining source mutation rights.
4. **Occurrence/blob separation**: Project references an attachment in context,
   while physical bytes may be deduplicated and shared by many occurrences.
5. **Deletion safety**: a future permanent delete must see backlinks and return
   a conflict instead of silently cascading through Project items.

PR #120 established the source side of those boundaries. PR #123 completed the
shared blob-lifecycle, export-integrity, and physical-delete protections, and PR
#124 corrected their D1/workerd migration compatibility. PR #125 established the
sparse reference registry and base batch resolver; the Phase 2A completion
slice then mounted reference routes into the core middleware stack and added
real Worker/D1 resolver execution to its gate. PR #127 completed Phase 2B1 with one opaque canonical destination and a lifecycle-aware read-only Reference page. PR #128 completes Phase 2B2 by applying exact URL-owned focus in the existing Sample, Processing, and metrology-template interfaces; together they close Phase 2B. Actual Project
backlinks remain deferred until `project_items.reference_target_id` exists, so
no ownerless parallel usage table is introduced.

## Product invariants

### Projects have no workflow status

A Project has no `Active`, `Completed`, `Archived`, progress, or completion
workflow. It can remain useful indefinitely or simply stop being used. The
research content expresses whether the work is ongoing.

Soft deletion is still available as a record-lifecycle operation, but it is not
a Project workflow status.

### Projects do not form a fixed parent tree

There is no `parent_project_id` and no database-level subproject hierarchy. A
Project can reference another Project, and the same Project can be referenced
from several places. Navigation through those references can feel hierarchical
without assigning one canonical parent.

### External references are strictly read-only

Project may display rich previews and source metadata, but it must not edit a
referenced Sample, Run, Step, Comment, attachment, Recipe revision, Project, or
content owned by another Project.

Within one Project, a user may edit only:

- content owned by that Project;
- whether the Project includes a reference;
- Map position and size;
- Text order;
- local edges and their optional labels.

Source edits remain available only in the source object's own interface.
`Open source` is navigation, not delegated write authority.

### Content identity is separate from inclusion and presentation

Project-owned text, images, and files are first-class objects with stable IDs.
They are not temporary JSON embedded in a canvas node.

The same content can be:

- edited in its owner Project;
- referenced read-only by another Project;
- included more than once only when the product explicitly permits distinct
  local items;
- placed differently in different Maps;
- ordered differently in different Text views;
- opened at its exact owner location.

A content object, a Project's inclusion of that object, and its presentation in
Text or Map are separate identities.

### Natural hierarchy remains source-owned

The experimental source path remains authoritative:

```text
Sample
├─ Sample comment or attachment
└─ Run
   └─ Step
      ├─ Step comment
      └─ Step attachment
```

Project reads and displays that path; it does not copy, edit, or reinterpret
it. Referencing one Comment does not automatically add its Sample, Run, and
Step as separate Project items.

The following relationships must stay distinct:

| Relationship | Meaning | Editable from Project |
|---|---|---:|
| Source hierarchy | Sample → Run → Step → Comment/Attachment | No |
| Project inclusion | The Project chooses to show a target | Add/remove only |
| Project edge | A relationship expressed by this Project | Yes |
| Map placement | Position and size in this Project | Yes |
| Text placement | Reading order in this Project | Yes |

## Identity layers

The Project model has four identity layers:

1. **Source/content identity** — the referenced source row or Project-owned
   content object.
2. **Reference-registry identity** — one idempotent registry row for an external
   target type and stable target ID.
3. **Project-item identity** — this Project's inclusion of content or a
   reference.
4. **View-placement identity** — the Text or Map presentation of one Project
   item.

Edges point to Project items because edges express local meaning. They do not
point directly to source rows or blob records.

## Conceptual data model

The first version has two Project-item classes:

1. **Project-owned content**: text, images, files, or a small composite owned by
   the current Project.
2. **External reference**: a read-only target elsewhere in the system,
   including a Project or content owned by another Project.

The following model is illustrative. Names and columns must be reconciled with
the D1 schema before a migration is written.

```text
projects
- id
- title
- created_by
- updated_by
- created_at
- updated_at
- deleted_at
- deleted_by

project_contents
- id
- owner_project_id
- content_kind
- body_json / text
- created_by
- updated_by
- created_at
- updated_at
- deleted_at
- deleted_by

project_content_attachments
- id
- project_content_id
- attachment_kind
- asset_id / storage_object_id / external_url
- position
- created_at
- deleted_at
- deleted_by

reference_targets
- id
- registry_version
- target_type
- target_id
- first_registered_at
- last_validated_at
- tombstoned_at
- last_known_contexts_json
- UNIQUE(target_type, target_id)

project_items
- id
- project_id
- item_kind                  # content | reference
- project_content_id         # exactly one target column is populated
- reference_target_id
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
- updated_at

project_text_placements
- id
- project_item_id
- position_key
- updated_at

project_edges
- id
- project_id
- source_item_id
- target_item_id
- label
- created_at
- updated_at
- deleted_at
```

The previous shorthand in which every `project_item` stored only a
`reference_target_id` was incomplete: Project-owned content also needs a direct,
owner-controlled inclusion path. Project-owned content must not be registered
as an external source merely to make the table shape uniform.

Required constraints:

- `project_items` never stores an editable copy of an external source object.
- a Project item targets exactly one Project-owned content object or one
  reference-registry row;
- a Project-owned content item belongs to its owner Project when edited;
- content owned by another Project is included through a read-only reference;
- Map placement and Text placement are independent;
- removing a Project item removes only local placements and local edges;
- edges and placements point to Project items, not directly to source rows;
- Project attachment occurrences point to shared storage records through the
  same occurrence-to-blob boundary as existing attachments;
- a React Flow serialization is never the only persistent representation.

Local Project-owned rows such as placements and edges may use deliberate
cascade from a Project item because those rows have no meaning outside that
local inclusion. Source rows, registry targets, and other Projects MUST NOT
cascade when a Project item is removed.

## Reference registry and resolver boundary

SQLite cannot use one foreign key from `target_type + target_id` to many source
tables. The reference registry therefore requires layered enforcement:

- a closed, versioned target-type registry in application code;
- resolver validation when a target is registered or inserted;
- `UNIQUE(target_type, target_id)` for idempotent registration;
- immutable registry identity once a row is created;
- source-specific permanent-delete blockers;
- foreign keys from Project items to the registry;
- foreign keys from placements and edges to Project items;
- periodic consistency checks for invalid targets.

`reference_targets` is not a content snapshot and is not the source of truth for
title, status, path, or preview. It stores stable identity, registration and
validation metadata, and an eventual tombstone. Normal resolution reads source
tables in bounded batches through source-specific adapters.

The implemented v1 registry covers the nine existing stable source and
occurrence identities:

```text
sample
run
run_step
comment
comment_occurrence
comment_attachment
execution_image
metrology_reference
recipe_revision
```

Project, Project-content, and Project-attachment target types are future
extensions added only when those stable source identities and lifecycles exist.
The type set remains closed and tested; unknown strings are not accepted.

The registry does not duplicate source content. It supports base batch
resolution, permanent-delete blocker mapping, and a minimal future tombstone.
Actual Project backlink counts come from `project_items.reference_target_id`
once Project-item identity exists.

## Text, Map, and Inspector

### Text

Text is the first Project workspace to implement. It provides:

- editable Project-owned text;
- read-only embedded references;
- a source path and `Open source` action for every reference;
- an order independent from Map geometry and Project edges;
- exportable continuous reading without pretending edges form a heading tree.

Text is not an automatic linearization of the Map. `position_key` or an
equivalent ordering scheme should allow insertion without renumbering every
following item in one large mutation.

### Map

Map provides spatial organization and user-defined edges. The intended
interaction is:

- click a card to select it and open Inspector;
- drag a card to change its local placement;
- use connection handles to create a local edge;
- click a title, source path, or `Open source` to navigate;
- optionally double-click a card as a navigation shortcut.

A single click on the whole card must not navigate because selection, dragging,
and edge creation need that gesture.

`@xyflow/react` is the intended interaction layer. It must be dynamically
loaded when Map opens and must not become the database model. Dagre may later
provide optional initial or local layout, but layout output changes only view
data.

Map writes should persist compact placement and edge changes, not one opaque
serialized canvas document.

### Inspector

Inspector carries detail that would make Map cards too large. It may:

- show complete content and the dynamically resolved source path;
- expand a Step's directly related Comments and attachments read-only;
- add one of those child objects as a separate Project reference;
- open the source object;
- remove the selected item from the current Project.

Inspector does not expose source mutation controls.

## Resolution, deep links, and search

### Base batch resolver

Project cards must not load one complete Sample per target. PR #125 establishes
a bounded base resolver that accepts stable `target_type + target_id` pairs and
returns:

- stable identity and type;
- a read-only source summary;
- current ordered source contexts;
- source and ancestor lifecycle metadata;
- `resolved`, `not_found`, `inconsistent`, or `tombstoned` state.

It preserves caller order and duplicate requests, reports per-target failure,
and never returns source mutation capability or physical storage locators. Its
query count is bounded by the distinct target types present, with a small fixed
number of source queries per adapter rather than one query per target object.

### Enriched Project read model

PR #127 Phase 2B1 enriches the base result with:

- a versioned opaque canonical `referenceUrl` that preserves stable-ID identity;
- lifecycle-aware destination mode;
- one safe `openSourceUrl` when an existing source route can represent the
  identity exactly; and
- ordered per-context source destinations without choosing one arbitrary path.

PR #128 Phase 2B2 consumes these destinations in the mature source interfaces,
including exact Step and Comment focus, context-preserving attachment previews,
stable execution-image occurrence reads, metrology-reference focus, and
refresh/Back/Forward restoration. The focus layer remains read-only and returns
no physical storage locator.

Later Project and Inspector slices add:

- directly expandable child summaries where appropriate;
- Project backlink and location counts;
- Project/Inspector-specific navigation capabilities.

These fields were deliberately not part of the PR #125 completion boundary.
Their staged addition does not turn the base resolver into a copied or partial
source record.

### Object-level deep links

Every referenceable object needs a refresh-safe URL containing its stable ID.
PR #127 establishes `/references/:type/:encodedId` with a shared opaque,
reversible codec and a lifecycle-aware read-only destination for all nine
current target types. Deleted, archived, missing, inconsistent, and tombstoned
references therefore no longer depend on ordinary source routes remaining
visible.

PR #128 Phase 2B2 integrates the stable focus hints into existing source
interfaces. Phase 2B therefore supports at least:

| Target | Required destination |
|---|---|
| Project | Project workspace |
| Project content | Owner Project focused on that content |
| Sample | Sample details |
| Run | Matching process or metrology Run |
| Step | Matching Run, Step scrolled into view and expanded |
| Comment | Owning context, Comment highlighted |
| Attachment | Preview with source context preserved |
| Recipe revision | The exact referenced revision |

Deleted sources keep the canonical read-only destination instead of returning
an ordinary `404` when an existing Project reference opens them.

### Deterministic search and insertion

Global search, Project insertion search, and search within one Project share
one index/read model. The first version covers:

- Project titles and Project-owned text;
- Sample code, title, and description;
- Run and Step titles;
- Comment bodies;
- attachment names, descriptions, and source paths;
- Recipe titles and revisions;
- type, Sample, and time filters.

Results can expose `Open source`, `Add to project`, or `Locate in project`
according to context. A Comment result inserts that Comment; its ancestors are
displayed as source path, not silently inserted.

Initial ranking remains explainable: exact ID, exact title or filename, prefix,
body text, then weaker metadata. Semantic search is later work.

## Lifecycle and history

Project depends on the source lifecycle contract rather than replacing it.

| Operation | Source effect | Existing Project result |
|---|---|---|
| Edit source | Update the original object | Shows latest content and an edited indication |
| Remove from Project | Remove one local item and edges | Source unchanged |
| Move source to trash | Recoverable soft-delete | Read-only deleted source remains resolvable |
| Restore source | Clear deletion metadata | Same stable ID becomes active again |
| Permanently delete | Privileged, reference-guarded operation | Minimal unavailable tombstone if force is ever supported |

All referenceable source objects need stable IDs, `updated_at`, deletion
metadata, and a usable audit or revision model. References show the latest
source version by default. Pinning a historical revision may be added later,
but it must point to source history rather than create a Project-owned copy.

Backlinks are required for navigation and deletion safety. Before a permanent
delete, the system must be able to report, for example, “Referenced by 3 items
in 2 Projects.” The authoritative Project backlink relationship is the future
`project_items.reference_target_id`; a Project or Project-owned content may
itself be soft-deleted without cascading into references held by another
Project.

Permanent deletion is still disabled. The source/blob lifecycle slices block
accidental physical deletion, and PR #125 added the registry and blocker type
mapping, but Project backlinks, privileged authorization, final concurrency
checks, and tombstone creation are not all present.

If a future privileged force-delete is introduced, it must create the tombstone
before removing the source. The tombstone keeps only stable identity,
last-known type/contexts, and deletion metadata; it does not retain permanently
deleted text or file bytes.

## Recipe and attachment rules

Project distinguishes a Recipe family, a specific revision, and the snapshot
used by a Run. A completed or historical Run continues to resolve the revision
or snapshot that governed it. Retiring or deleting a Recipe prevents new
assignment but does not rewrite historical execution.

Project references attachment occurrences, never R2 keys or shared blob rows.
Renaming an occurrence can preserve its ID; replacing its bytes creates a new
occurrence. Removing one occurrence must not delete bytes reachable from any
active, archived, soft-deleted, retryable, or Project-referenced occurrence.

Project-owned uploads reuse the existing hashing, deduplication, R2, and
managed-storage services while creating their own stable attachment occurrence.
They do not pass through Comment-specific finalization routes, but they emit the
same retention-edge shape and use the same GC/export services.

The precise reachability and export contract is specified in
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md).

## Export and restore

The current schema-v3 complete export already includes `reference_targets` in
the same D1 table-snapshot batch as the source tables. Adding Project requires a
new full-export schema version that additionally includes:

- Projects and Project-owned contents;
- Project attachment occurrences;
- Project items;
- Text placements, Map placements, and edges;
- backlink/tombstone records needed to restore Project reference behavior;
- every reachable Project-owned blob;
- structured warnings for unavailable bytes.

Restore must preserve source, registry, and Project IDs exactly so references
do not silently retarget. Exported Markdown or other human-readable output uses
relative asset paths and contains no authenticated or temporary URLs.

## Implementation roadmap

Project UI is not the next implementation step. Each phase has a clear exit
condition:

| Phase | Scope | Current state |
|---|---|---|
| 0. Reference identity | Target list, canonical Comment, attachment occurrence/blob boundary, lifecycle vocabulary | Complete |
| 1A. Source lifecycle | Soft-delete/restore and ordinary read/mutation guards | Complete after PR #120 |
| 1B. Blob lifecycle | Shared reachability, safe cleanup/export, physical-delete protection, deployment gate | Complete after PR #123, with D1/workerd compatibility corrected by PR #124 |
| 2A. Registry and base resolution | Sparse registry, immutable registry identity, bounded batch resolver, lifecycle contexts, unified middleware, workerd runtime smoke | Complete after PR #125 and the reference-runtime completion slice |
| 2B. Deep links | Object-level canonical URLs, lifecycle destinations, and exact source focus | Complete after PR #128 |
| 2B1. Canonical destinations | Opaque route codec, resolver destination fields, lifecycle-aware read-only Reference page | Complete in PR #127 |
| 2B2. Source focus integration | Step centering, Comment highlighting, attachment/execution-image preview, metrology-reference focus | Complete in PR #128 |
| 2C. Deterministic search | Shared search/read model and reference insertion | Next |
| 3. Project and Text | Project data, `project_items` backlinks, Project-owned content, Text workspace, Inspector, insertion, export | Not started |
| 4. Map | React Flow placements and edges, dynamic loading, Inspector integration | Not started |
| 5. Later capabilities | Revision pinning, semantic search, LLM insight, advanced consistency tooling | Deferred |

Within those phases, the dependency order is:

1. stable object identity;
2. source deletion lifecycle;
3. blob reachability, export integrity, and physical-delete protection;
4. Recipe revision and execution snapshot verification;
5. sparse registry and base read-only resolution;
6. opaque canonical destinations and lifecycle-aware read-only pages;
7. exact Step, Comment, attachment, execution-image, and metrology focus;
8. deterministic search and insertion;
9. Project contents, items, backlinks, and local edges;
10. Text and Inspector;
11. Map;
12. later revision, semantic, and insight capabilities.

Recipe revision and Run snapshot foundations already exist; the verification in
step 4 is not a new Recipe redesign.

## First-version non-goals

- Project status, progress, or task management;
- a fixed subproject tree or unique parent Project;
- editing source objects from Project;
- automatically expanding the full source hierarchy into nodes;
- deriving one mandatory Text hierarchy from Map edges;
- a structured Simulation entity;
- semantic search as a first-version dependency;
- storing React Flow output as the only Project representation;
- allowing an LLM to mutate experimental source records.

LLM-based read-only insight may be explored only after the deterministic read
and reference model is stable. Project itself does not absorb experimental data
analysis into the record system.

## Dependency and licensing boundary

Before adding Map dependencies, verify both the repository license and each
third-party license. React Flow and Dagre are expected to be MIT-licensed, but
that expectation must be rechecked at the version selected for implementation.
No Map dependency is required during the blob, resolver, deep-link, search, or
Text phases.
