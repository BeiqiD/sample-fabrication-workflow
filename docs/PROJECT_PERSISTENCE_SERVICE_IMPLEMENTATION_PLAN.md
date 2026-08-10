# Project persistence service implementation plan

Status: current Draft PR #132 implementation contract under review

Last reviewed: 2026-08-10 against `v2/backend-foundation` at
`21d535a243ae4adbe10330980fe6fc57a0b85366`, during implementation and review of
Draft PR #132 after Phase 3A1 was merged in PR #131

This document defines the authoritative Project read/write service that sits on
top of the normalized schema from `0019_project_core.sql`. Product ordering is
governed by [PRODUCT_ROADMAP.md](./PRODUCT_ROADMAP.md); identity and ownership by
[PROJECT_DESIGN_FOUNDATION.md](./PROJECT_DESIGN_FOUNDATION.md); Map/Reading
behavior by
[PROJECT_CANVAS_INTERACTION_CONTRACT.md](./PROJECT_CANVAS_INTERACTION_CONTRACT.md);
and physical-byte safety by
[BLOB_LIFECYCLE_CONTRACT.md](./BLOB_LIFECYCLE_CONTRACT.md).

## Goal

Phase 3A2 makes the Phase 3A1 schema usable through one authenticated,
conflict-aware, retry-safe backend boundary before React Flow or a Markdown
editor is introduced.

The completed service must be able to:

- list, create, open, rename, recoverably delete, and restore Projects;
- return one Project snapshot consumed later by both Map and Reading;
- create Project-owned Markdown and attachment occurrences;
- insert repeated read-only references through the canonical resolver and
  registry;
- persist placement and basic-edge mutations;
- remove and restore local occurrences without mutating source records;
- reject stale revisions with explicit `409` responses;
- replay an immediately retried operation without duplicating rows or consuming
  a second creation sequence;
- preserve export and blob-retention guarantees from Phase 3A1.

This phase does not add React Flow, Project pages, a Markdown editor, upload UI,
Reading UI, real-time collaboration, permanent delete, or an unbounded operation
history.

## Service composition

Project routes move behind a dedicated `project-routes` aggregate. The aggregate
owns:

- Project CRUD and snapshot routes;
- content, item, placement, and edge mutation routes;
- Project attachment media access by stable Project/content identity;
- the complete-export route introduced in Phase 3A1.

The existing Reference aggregate remains responsible for read-only resolution,
search, and reference media. It must not remain the accidental owner of Project
routes after 3A2.

All Project routes inherit the core Hono middleware for:

- authenticated actor identity;
- same-origin browser-write protection;
- shared error handling;
- the existing `/api` base path.

## Stable API identities

All create operations receive client-generated stable IDs. IDs and operation IDs
must be URL-segment-safe opaque tokens:

```text
first character: A-Z, a-z, or 0-9
remaining characters: A-Z, a-z, 0-9, dot, underscore, tilde, or hyphen
maximum length: 256
```

This excludes slash, encoded slash ambiguity, empty values, and relative-path
segments such as `..` while allowing UUIDs and other portable opaque IDs.

A create request supplies the identities of every row it intends to create:

- Project creation: `projectId`;
- Markdown creation: `contentId`, `itemId`, and `placementId`;
- attachment creation: `contentId`, `itemId`, and `placementId`;
- reference insertion: `itemId` and `placementId`;
- edge creation: `edgeId`.

The server never needs an operation ledger merely to rediscover the result of a
network retry.

## Idempotency contract

Phase 3A2 provides bounded retry idempotency, not permanent command history.

### Create operations

A create request is replayed successfully when all of the following are true:

- the requested stable IDs already exist in the expected Project;
- every created row carries the same `last_mutation_id` or
  `creation_operation_id`;
- immutable targets and the current semantic state match the request.

The service returns the existing canonical result without advancing
`next_created_sequence` again.

Reusing an ID or operation ID for a different payload returns `409`.

### Update, delete, and restore operations

A mutation is replayed successfully only when every row whose state is owned by
the operation still contains the same `last_mutation_id` and the requested
semantic state. For an item lifecycle operation with Project-owned content, both
the item and its content must still carry that operation ID. Reusing an operation
ID with different state returns `409`.

If any participating row has been advanced by a later mutation, replaying the
older operation returns `409`; Phase 3A2 does not retain an unbounded historical
response log.

This contract covers browser/network retry and duplicate submission while
keeping permanent operation history out of the first Project release.

## Revision ownership

The service does not invent one global revision for every Project child row.
Revision ownership follows the schema:

- `projects.revision` covers title, Project lifecycle, and allocation of
  `created_sequence`;
- `project_contents.revision` covers Markdown, attachment description, and
  content lifecycle;
- `project_items.revision` covers local occurrence lifecycle;
- `project_map_placements.revision` covers geometry and z-index;
- `project_edges.revision` covers marker, label, and edge lifecycle.

Therefore:

- Project create/rename/delete/restore use Project revision;
- every item-creation operation uses Project revision because it reserves one
  immutable creation sequence;
- content, placement, item, and edge updates use their own expected revisions;
- edge creation also supplies expected revisions for both endpoint items;
- moving a node does not advance Project or content revision;
- editing Markdown does not advance placement or Project revision.

A stale expected revision returns `409` and never silently overwrites current
state.

## Authoritative transaction templates

Cloudflare D1 `batch()` is the transaction boundary. Every multi-row mutation is
constructed so a failed precondition either changes zero rows or causes a
constraint failure that rolls the whole batch back.

### Item and placement creation

Every Markdown, attachment, or reference insertion performs this sequence in one
batch:

```text
1. conditionally advance projects.revision
2. reserve and increment projects.next_created_sequence
3. create or validate the content/reference target
4. insert the Project item using the reserved sequence
5. insert exactly one placement
```

The item insert obtains its sequence from a scalar subquery that requires the
Project row to contain the current operation ID and expected next revision. If
the reservation did not occur, the subquery returns `NULL`, the item insert
violates a required field, and D1 rolls back every earlier statement.

This prevents a stale request from committing only content, registry metadata,
or a consumed sequence.

### Reference insertion

Reference insertion first performs a read-only canonical resolution. Only a
`resolved` target can proceed.

The transaction then:

```text
Project sequence reservation
+ INSERT OR IGNORE canonical reference_targets row
+ monotonic registry metadata refresh
+ reference item insert
+ placement insert
```

The item uses a scalar subquery requiring a non-tombstoned registry row. A
registry tombstone before commit aborts the entire batch. The source target is
resolved immediately before the batch and is re-resolved whenever a snapshot is
read; D1 cannot hold a source-row lock across the resolver read and the later
batch. A source lifecycle change in that interval therefore cannot copy stale
editable data into Project, but the committed occurrence may subsequently
resolve as retained, missing, or tombstoned. Repeated occurrences remain valid
because each request has a distinct item ID.

### Attachment insertion

The API accepts exactly one existing blob-record identity:

- `assetId`; or
- `storageObjectId`.

Original filename, MIME type, and byte size are read from the authoritative blob
record; clients cannot supply or overwrite intrinsic metadata. The Phase 3A1
attachment trigger performs the GC claim/release check inside the same batch.

This phase binds already uploaded/registered bytes. Upload transport remains the
existing asset/managed-storage responsibility and later Project UI composes the
two operations.

### Local occurrence removal

Removal is recoverable and never mutates the referenced source.

The transaction:

1. soft-deletes active connected edges while the item is still active;
2. for owned content, soft-deletes the content using its expected revision;
3. soft-deletes the item using its expected revision after the content transition;
4. leaves the placement row physically present but invisible through the active
   item join.

Connected-edge updates are conditioned on the same expected item revision, so a
stale item request cannot commit only edge deletion.

Restoring an occurrence restores owned content first, then the item. Connected
edges are not restored implicitly; they have independent recoverable lifecycle
and may be restored only when both endpoints are active.

## Snapshot read model

`GET /projects/:projectId` returns one normalized snapshot:

```text
project
contents
attachments
items
placements
edges
references
```

The Project rows are read in one D1 batch. Active snapshots include only:

- active Project-owned content linked from active items;
- active items;
- placements whose item is active;
- active edges with active endpoints;
- reference-registry entries used by active reference items.

After the Project batch, the service performs canonical read-only Reference
resolution for the distinct active targets and returns the ordered resolution
array. Reference source data remains dynamic and is never copied into editable
Project columns.

Map and Reading later consume the same item occurrence IDs. Reading orders items
by `createdSequence`; Map uses the corresponding placement rows.

`includeDeleted=1` returns a Trash snapshot: it may open a recoverably deleted
Project and includes recoverably removed items, owned content, attachment
metadata, placements, edges, and their revisions so restore operations remain
discoverable. Ordinary Project lists and snapshots hide deleted Projects and
removed child rows.

No physical blob locator, R2 key, managed-storage object key, temporary URL, or
provider credential appears in the JSON snapshot.

## Attachment media route

Project attachment bytes are read through:

```text
GET /projects/:projectId/contents/:contentId/file
```

The route resolves the stable Project/content identity to an internal blob
locator, applies the existing `deleting`/`deleted` GC guard, reads through the
shared storage adapter, and returns safe private media headers.

The route never accepts or returns an R2 key or managed-storage object key.

## Route contract

### Project lifecycle

```text
GET    /projects
POST   /projects
GET    /projects/:projectId
PATCH  /projects/:projectId
DELETE /projects/:projectId
POST   /projects/:projectId/restore
```

### Project-owned content and occurrences

```text
POST   /projects/:projectId/items/markdown
POST   /projects/:projectId/items/reference
POST   /projects/:projectId/items/attachment
DELETE /projects/:projectId/items/:itemId
POST   /projects/:projectId/items/:itemId/restore
PATCH  /projects/:projectId/contents/:contentId/markdown
PATCH  /projects/:projectId/contents/:contentId/attachment
GET    /projects/:projectId/contents/:contentId/file
```

### Map placement and edges

```text
PATCH  /projects/:projectId/placements/:placementId
POST   /projects/:projectId/edges
PATCH  /projects/:projectId/edges/:edgeId
DELETE /projects/:projectId/edges/:edgeId
POST   /projects/:projectId/edges/:edgeId/restore
```

All JSON mutation bodies carry `operationId`. Every mutation of an existing row
also carries the corresponding expected revision. Item removal/restoration
carries an expected content revision when the item owns content.

## Validation boundaries

Shared TypeScript validation and the database both enforce:

- API-safe stable IDs and operation IDs;
- JavaScript-safe positive revisions and sequence values;
- Project title length;
- bounded Markdown source length;
- attachment caption and source-URL length;
- `http` or `https` attachment source URLs;
- finite bounded geometry and integer z-index;
- closed edge handle/marker enums and edge-label length;
- exactly one attachment locator identity;
- source/target item identity and expected revision for edge creation.

Malformed input returns `400`. Missing visible resources return `404`. Stale
revision, operation reuse, unavailable reference/blob state, or incompatible
lifecycle returns `409`.

## Error and rollback rules

The service exposes typed domain errors to the Hono route layer. Constraint text
is not returned to clients.

The following are mandatory rollback tests:

- stale Markdown creation leaves no content, item, placement, or consumed
  sequence;
- stale attachment creation leaves no Project rows and does not claim an orphan
  blob;
- stale reference insertion leaves no Project occurrence and does not refresh
  registry metadata;
- placement failure rolls back content/item/sequence creation;
- item-removal conflict leaves item, content, and connected edges unchanged;
- endpoint-revision conflict creates no edge;
- duplicate retry returns the first result and consumes no second sequence.

## Export and retention

Phase 3A2 does not change the complete-export schema version. It reuses schema
version 4 from Phase 3A1 because no new persistence table is introduced.

All created Project rows already appear in the Phase 3A1 export query set.
Project attachment bytes remain reachable through `blob_retention_edges` and the
existing blob export planner.

## Verification gate

The dedicated Phase 3A2 gate includes:

1. shared API-contract tests;
2. host-SQLite service transaction and rollback tests;
3. Hono route status/shape tests;
4. Project attachment media tests without locator disclosure;
5. exact route-composition tests proving Project routes inherit core middleware;
6. full ordered migration verification;
7. a real Miniflare/workerd Project smoke covering create, retry, reference
   insertion, snapshot, conflict, attachment binding/media, and deletion;
8. existing Blob, Reference, full test, mounted-test, and production-build gates.

CI records a dedicated `pre-pr/project-persistence` status after the Phase 3A1
foundation gate.

## Implementation order

1. add this contract and shared Project API validators/types;
2. add runtime-neutral Project serializers and typed service errors;
3. implement Project list/create/snapshot/lifecycle operations;
4. implement rollback-safe Markdown and reference insertion;
5. implement attachment binding, metadata update, and stable media route;
6. implement item removal/restore, placement updates, and edge lifecycle;
7. move Project export ownership into the Project route aggregate;
8. add host SQLite and Hono route tests;
9. add the real workerd smoke, package script, and CI status;
10. run the exact-head gates and keep the pull request Draft for schema/service
    review.

## Definition of done

Phase 3A2 is complete when:

- every documented route is authenticated and same-origin protected;
- create retries are idempotent and do not consume extra sequence values;
- stale revisions return `409` without partial commits;
- Project creation, owned content, repeated references, attachments, placements,
  and edges can be saved and reopened through one snapshot model;
- local removal never mutates source records;
- attachment bytes are readable by stable Project/content identity without
  locator disclosure;
- export and blob retention remain complete at schema version 4;
- host SQLite, Hono, real workerd, migration, full tests, mounted tests, and
  production build all pass on the exact PR head.

Only then should Phase 3B1 introduce React Flow and the Project UI shell.
