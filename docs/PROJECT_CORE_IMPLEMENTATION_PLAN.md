# Project core implementation plan

Status: Phase 3A1 implementation contract

Last reviewed: 2026-08-09 against `v2/backend-foundation` at
`5047ad78a2679a1ea6c050bcb2c945a980db283e`, after PR #130

This document translates the active Project roadmap into a reviewable backend
sequence. The product direction remains governed by
[PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md), the ownership and identity rules by
[PROJECT_DESIGN_FOUNDATION.md](./PROJECT_DESIGN_FOUNDATION.md), the Map behavior
by
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md),
and physical-byte safety by
[BLOB_LIFECYCLE_CONTRACT.md](./BLOB_LIFECYCLE_CONTRACT.md).

## Decision

Phase 3A is split into two pull requests before Map UI work begins.

### Phase 3A1 — Project schema foundation

The current pull request installs and verifies the normalized persistence
kernel:

- `projects`;
- `project_contents`;
- `project_content_attachments`;
- `project_items`;
- `project_map_placements`;
- `project_edges`;
- shared Project enum and geometry contracts;
- Project attachment blob-retention edges;
- complete-export schema version 4 with all Project tables;
- focused host-SQLite, route, export, and D1/workerd migration gates.

No Project write route is enabled in 3A1. The migration can therefore be applied
without exposing a partially implemented mutation surface.

### Phase 3A2 — authoritative Project persistence service

The next pull request activates Project reads and writes on top of the frozen
schema:

- Project list, create, open, rename, recoverable delete, and restore;
- one project snapshot/read model for Map and Reading;
- expected-revision checks and idempotent operation IDs;
- authoritative Project-owned Markdown creation and save;
- authoritative reference insertion that resolves the source, registers the
  stable target, allocates `created_sequence`, creates the occurrence, and
  creates its placement in one transaction;
- authoritative attachment creation over the existing blob lifecycle;
- placement and basic-edge mutations;
- workerd route smokes and exact integration-head deployment verification.

Map rendering, drag interaction, React Flow integration, Inspector UI, and
Reading UI remain Phase 3B or later.

## Why the split is required

The roadmap-level Phase 3A scope combines six new tables, optimistic concurrency,
reference registration, blob occurrence ownership, complete export, route
composition, and several user-visible mutations. Implementing all of those in
one change would make it difficult to distinguish a schema error from a route,
transaction, or Canvas behavior error.

The split follows dependency order instead:

```text
identity and constraints
        ↓
export and blob reachability
        ↓
authoritative mutation service
        ↓
Map and Reading projections
```

3A1 is not a throwaway schema-only branch. It closes every invariant that can be
owned by SQLite and keeps export and physical-byte retention complete before any
Project row can be created through the application.

## Phase 3A1 schema contract

### `projects`

A Project is a stable, recoverable workspace identity. It stores:

- an immutable ID and creation identity;
- a mutable title;
- `revision` and `last_mutation_id` for optimistic, idempotent updates;
- `next_created_sequence` for later authoritative occurrence allocation;
- update metadata;
- recoverable deletion identity.

A Project has no Active, Completed, progress, task, or approval state.

### `project_contents`

Project-owned content has a stable identity and belongs to exactly one Project.
The first content types are:

- `markdown`, with mutable Markdown source and an explicit format version;
- `attachment`, whose bytes and file metadata live in the one-to-one attachment
  subtype table.

Content type and ownership are immutable. Markdown saves and lifecycle changes
advance exactly one revision and require a fresh mutation ID.

### `project_content_attachments`

The attachment table is a one-to-one subtype keyed by
`project_content_id`. Exactly one physical locator is present:

- `asset_id` for R2; or
- `storage_object_id` for managed storage.

The locator and attachment metadata are immutable. Replacing a file creates new
Project content rather than silently retargeting an existing stable identity.
Insertion is rejected unless:

- the parent is active attachment content in an active Project;
- the blob record is ready or recoverable;
- the locator has not entered `deleting` or `deleted` GC state.

Binding an orphaned locator atomically returns it to reachable state.

### `project_items`

A Project item is an occurrence, not the source object itself. It targets exactly
one of:

- one Project-owned `project_content_id`; or
- one immutable `reference_target_id`.

Owned content can have one occurrence. The same reference target can appear
multiple times because each occurrence can carry independent Map placement and
edge context.

Every item receives one immutable positive `created_sequence`, unique within the
Project. The first Reading projection orders active items by this sequence.
There is no Reading-placement table, manual Reading reorder, fractional
position key, or edge-derived order in the first implementation.

The `reference_target_id` index is the first real Project backlink surface for
future permanent-delete planning.

### `project_map_placements`

Map layout is separate from item identity. One item has at most one placement,
with:

- stable placement ID;
- `x` and `y`;
- positive `width` and `height`;
- integer `z_index`;
- revision and idempotency metadata.

Moving or resizing a card changes only the placement row. It never rewrites the
item, source record, Markdown body, Reading order, or edge endpoints.

### `project_edges`

Edges are Project-local records with stable IDs. The first contract stores:

- source and target item IDs in the same active Project;
- immutable endpoint handles from `top`, `right`, `bottom`, and `left`;
- independent `none` or `arrow` markers at each end;
- an optional short label;
- revision and recoverable deletion metadata.

Changing an endpoint or handle is represented as delete-and-create. Marker and
label changes are revisioned updates. Exact duplicate active edges are rejected,
while parallel edges with meaningfully different labels or marker semantics are
allowed.

## Database-owned invariants

Migration `0019_project_core.sql` owns the following rules even if a future
caller bypasses TypeScript validation:

1. stable IDs, owners, targets, creation metadata, occurrence sequence, and edge
   endpoints cannot be retargeted in place;
2. semantic updates require `revision = previous + 1` and a fresh
   `last_mutation_id`;
3. Project-owned content and graph endpoints must belong to the same active
   Project at creation time;
4. a new reference occurrence cannot target a tombstoned registry row;
5. repeated references are allowed, repeated owned-content occurrences are not;
6. one placement exists per item and dimensions are positive;
7. physical deletion of every Project table is disabled;
8. ordinary lifecycle fields are all-null or all-present;
9. attachment locators participate in the existing GC claim/release boundary;
10. Project attachment bytes remain in `blob_retention_edges`, including after
    recoverable deletion.

The schema deliberately does not allocate `created_sequence` by trigger. Phase
3A2 must compare the expected Project revision, reserve the current sequence,
advance `next_created_sequence`, insert the item, and insert its placement in one
transaction. Keeping orchestration in the authoritative service makes retry and
conflict results explicit rather than hiding a multi-row operation inside
triggers.

## Export contract

Applying a migration creates database state even before write routes exist.
Therefore 3A1 also raises the full-export schema version from 3 to 4 and exports
all six Project tables.

The Project export route is mounted ahead of the legacy monolithic export
handler and performs every table/view read in one D1 batch. A consistency test
parses the legacy table list and fails if a pre-existing export table is lost.
This is a compatibility bridge, not the final route composition. Phase 3A2 must
move the authoritative export query set into the dedicated Project/backend
composition root and remove the superseded monolithic handler.

Project attachment rows extend the stable `blob_retention_edges` public view
through a fourth D1-safe leaf. The public compound view remains below workerd's
five-term limit, and the existing blob export planner automatically packages the
newly reachable R2 or managed bytes once an attachment exists.

## Runtime activation gate

Phase 3A1 permits:

- migration application;
- read-only complete export;
- schema and contract verification.

Phase 3A1 does not permit:

- `POST`, `PATCH`, or `DELETE` Project endpoints;
- direct frontend writes to any Project table;
- reference registration without a Project item transaction;
- Project attachment upload/binding from the UI;
- Map or Reading UI backed by placeholder client state.

A Project write endpoint is a merge blocker until 3A2 demonstrates all of the
following in one authoritative service boundary:

- authenticated actor identity;
- bounded input validation;
- expected revision comparison;
- idempotent operation replay;
- same-Project ownership validation;
- transaction rollback on partial failure;
- export and blob-reachability preservation;
- host SQLite and workerd runtime coverage.

## Verification

The 3A1 gate consists of:

1. `worker/project-core-schema.test.ts`
   - table and column installation;
   - occurrence ordering and repeated-reference rules;
   - ownership and tombstone rejection;
   - revision/idempotency triggers;
   - placement and edge constraints;
   - attachment GC guards and retention view;
   - physical-delete protection.
2. `shared/project-types.test.ts`
   - closed enum sets;
   - finite positive geometry;
   - basic edge-shape validation.
3. `worker/project-foundation-routes.test.ts`
   - Project export route precedence;
   - one-batch complete snapshot;
   - schema version 4;
   - preservation of every legacy table plus all Project tables.
4. `npm run verify:d1-migrations`
   - the complete migration chain through Wrangler/workerd.
5. the existing full test and production build gates.

CI records a dedicated `pre-pr/project-foundation` status between the reference
foundation and the general test/build stages.

## Implementation order

The implementation order for this pull request is fixed:

1. add this implementation contract;
2. add shared Project constants and validators;
3. add migration `0019_project_core.sql` and the Project attachment retention
   leaf;
4. add the authoritative full-export query set and schema version 4;
5. mount the export route before the legacy handler;
6. add focused schema, shared-contract, and route/export tests;
7. add the dedicated package script and CI status;
8. run host validation, D1/workerd migration verification, the full test suite,
   and the production build;
9. keep the pull request Draft until the exact head passes all gates and a review
   confirms that no Project write route was introduced.

## Phase 3A1 definition of done

The pull request is complete when:

- all six tables migrate on fresh SQLite and Wrangler local D1;
- malformed ownership, target, geometry, edge, lifecycle, revision, or blob rows
  are rejected by the database;
- complete export contains every legacy and Project table at schema version 4;
- Project attachment locators are visible through the canonical retention view;
- no Project write API or placeholder Canvas persistence is present;
- `pre-pr/project-foundation`, general tests, and production build pass on the
  exact pull-request head.

Only then should Phase 3A2 begin.
