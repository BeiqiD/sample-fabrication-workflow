# Project design foundation

Status: product and architecture contract; physical schema and UI details remain
subject to implementation review

Last reviewed: 2026-08-08 against `v2/backend-foundation` at `12b41d76`

This document defines how Project, Text, and Map fit into Sample Fabrication
Workflow. It records the product decisions that must survive implementation,
while keeping provisional table and route names clearly separate from those
decisions.

The lifecycle prerequisites are defined in
[v3 backend foundation](./V3_BACKEND_FOUNDATION.md). Project implementation must
not bypass those identity, deletion, blob-retention, or deployment gates.

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

The views share content and references, but keep independent placement data.

## Product invariants

### Projects have no workflow status

A Project has no `Active`, `Completed`, `Archived`, progress, or completion
workflow. It can remain useful indefinitely or simply stop being used. The
research content expresses whether the work is ongoing.

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

### Content identity is separate from presentation

Project-owned text, images, and files are first-class objects with stable IDs.
They are not temporary JSON embedded in a canvas node.

The same content can be:

- edited in its owner Project;
- referenced read-only by another Project;
- placed differently in different Maps;
- ordered differently in different Text views;
- opened at its exact source location.

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

## Conceptual data model

The first version needs two target classes:

1. **Project-owned content**: text, images, files, or a small composite owned by
   the current Project.
2. **Reference**: a read-only target elsewhere in the system.

The following model is illustrative. Names and columns must be reconciled with
the D1 schema before a migration is written.

```text
projects
- id
- title
- created_at
- updated_at
- deleted_at

project_contents
- id
- owner_project_id
- content_kind
- text
- created_at
- updated_at
- deleted_at

project_content_attachments
- id
- project_content_id
- attachment_kind
- asset_id / storage_object_id / external_url
- position
- created_at
- deleted_at

reference_targets
- id
- target_type
- target_id
- first_registered_at
- tombstoned_at
- last_known_path_json

project_items
- id
- project_id
- reference_target_id
- created_at
- deleted_at

project_map_placements
- project_item_id
- x
- y
- width
- height

project_text_placements
- id
- project_item_id
- position

project_edges
- id
- project_id
- source_item_id
- target_item_id
- label
```

Required constraints:

- `project_items` never stores an editable copy of a source object.
- Map placement and Text placement are independent.
- Removing a Project item removes only that presentation and its local edges.
- Edges and placements point to Project items, not directly to source rows.
- Project attachment occurrences point to shared storage records through the
  same occurrence-to-blob boundary as existing attachments.
- A React Flow serialization is never the only persistent representation.

SQLite cannot use one foreign key from `target_type + target_id` to many source
tables. The reference registry therefore requires layered enforcement:

- resolver validation when a target is registered or inserted;
- source-specific permanent-delete guards;
- foreign keys from Project items to the registry;
- foreign keys from placements and edges to Project items;
- periodic consistency checks for invalid targets.

The registry does not duplicate source content. It supports batch resolution,
backlinks, and a minimal tombstone when a source no longer exists.

## Text, Map, and Inspector

### Text

Text is the first Project workspace to implement. It provides:

- editable Project-owned text;
- read-only embedded references;
- a source path and `Open source` action for every reference;
- an order independent from Map geometry and Project edges;
- exportable continuous reading without pretending edges form a heading tree.

Text is not an automatic linearization of the Map.

### Map

Map provides spatial organization and user-defined edges. The intended
interaction is:

- click a card to select it and open Inspector;
- drag a card to change its local placement;
- use connection handles to create a local edge;
- click a title, source path, or `Open source` to navigate;
- optionally double-click a card as a navigation shortcut.

A single click on the whole card must not navigate, because selection,
dragging, and edge creation need that gesture.

`@xyflow/react` is the intended interaction layer. It must be dynamically
loaded when Map opens and must not become the database model. Dagre may later
provide optional initial or local layout, but layout output changes only view
data.

### Inspector

Inspector carries detail that would make Map cards too large. It may:

- show complete content and the dynamically resolved source path;
- expand a Step's directly related Comments and attachments read-only;
- add one of those child objects as a separate Project reference;
- open the source object;
- remove the selected item from the current Project.

Inspector does not expose source mutation controls.

## Resolution, deep links, and search

### Batch read-only resolver

Project cards must not load one complete Sample per target. A batch resolver
accepts stable `target_type + target_id` pairs and returns a uniform read model:

- stable identity and type;
- card summary and Inspector detail;
- current source path;
- `updatedAt` and `deletedAt`;
- precise `openSourceUrl`;
- directly expandable child summaries where appropriate;
- backlink counts;
- unavailable or tombstone state.

The resolver returns no capability for editing external source objects.

### Object-level deep links

Every referenceable object needs a refresh-safe URL containing its stable ID.
The final syntax should follow the established router, but it must support at
least:

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

Deleted sources need a read-only archived destination instead of an ordinary
`404` when an existing Project reference opens them.

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

Initial ranking remains explainable: exact ID, exact title or filename,
prefix, body text, then weaker metadata. Semantic search is later work.

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

Backlinks are required for both navigation and deletion safety. Before a
permanent delete, the system must be able to report, for example, “Referenced
by 3 items in 2 Projects.” A Project or Project-owned content may itself be
soft-deleted without cascading into references held by another Project.

Permanent deletion is disabled until the registry, backlink checks, and
tombstone behavior exist. If a future privileged force-delete is introduced,
it must create the tombstone before removing the source. The tombstone keeps
only stable identity, last-known type/path, and deletion metadata; it does not
retain permanently deleted text or file bytes.

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
They do not pass through Comment-specific finalization routes.

The precise reachability and export contract is specified in
[v3 backend foundation](./V3_BACKEND_FOUNDATION.md#blob-reachability-contract).

## Export and restore

Adding Project requires a new full-export schema version that includes:

- Projects and Project-owned contents;
- attachment occurrences;
- Project items and reference registry rows;
- Text placements, Map placements, and edges;
- backlink/tombstone records needed to restore reference behavior;
- every reachable Project-owned blob.

Restore must preserve source and Project IDs exactly so references do not
silently retarget. Exported Markdown or other human-readable output uses
relative asset paths and contains no authenticated or temporary URLs.

## Implementation roadmap

Project UI is not the next implementation step. Each phase has a clear exit
condition:

| Phase | Scope | Status at `12b41d76` |
|---|---|---|
| 0. Reference identity | Target list, canonical Comment, attachment occurrence/blob boundary, lifecycle vocabulary | Complete |
| 1. Source lifecycle | Soft-delete/restore, ordinary read guards, blob reachability, permanent-delete protection | Source conversion complete; blob cleanup and permanent-delete guard remain |
| 2. Read and locate | Registry, backlinks, batch resolver, deep links, deterministic search | Not started |
| 3. Project and Text | Project data, Project-owned content, Text workspace, Inspector, insertion, export | Not started |
| 4. Map | React Flow placements and edges, dynamic loading, Inspector integration | Not started |
| 5. Later capabilities | Revision pinning, semantic search, LLM insight, advanced consistency tooling | Deferred |

Within those phases, the dependency order is:

1. stable object identity;
2. deletion and blob lifecycle;
3. Recipe revision and execution snapshot verification;
4. object-level deep links;
5. unified read-only object resolution;
6. deterministic search and insertion;
7. Project contents, items, and edges;
8. Text and Inspector;
9. Map;
10. later revision, semantic, and insight capabilities.

Recipe revision and Run snapshot foundations already exist; the verification in
step 3 is not a new Recipe redesign.

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
No Map dependency is required during the backend, resolver, or Text phases.
