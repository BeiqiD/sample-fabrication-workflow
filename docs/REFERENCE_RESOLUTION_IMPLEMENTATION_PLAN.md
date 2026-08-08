# Reference registry and batch resolver implementation plan

Status: implementation contract and record for PR #125

Last reviewed: 2026-08-08 during PR #125 review

This document defines the exact scope of the first reference-registry and
read-only resolution implementation. It follows the completed source lifecycle,
blob lifecycle, export-integrity, physical-delete protection, and D1/workerd SQL
compatibility work.

The product invariants remain in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md). Source lifecycle is
defined in [v3 backend foundation](./V3_BACKEND_FOUNDATION.md). Blob retention
and garbage collection remain governed by
[blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md). D1 SQL must satisfy
[D1 SQL compatibility](./D1_SQL_COMPATIBILITY.md).

## Purpose

Project, Text, search, and later Map features need one stable way to identify
and read application objects without copying them or acquiring mutation rights.
This slice establishes that boundary before any Project-owned data or UI is
introduced.

The implementation provides:

1. a closed and versioned set of reference target types;
2. a sparse, idempotent, identity-immutable `reference_targets` registry;
3. bounded batch resolver adapters for every current referenceable source type;
4. a domain resolver that enforces its own runtime and 200-target boundary;
5. a read-only API endpoint that preserves caller order and partial failures;
6. an internal registration service for later Project-item creation;
7. one mapping from public target types to permanent-delete blocker types;
8. single-batch export, migration, CI, and D1/workerd coverage for the new
   foundation.

The resolver reads current source data. The registry stores identity and
validation metadata only; it is not a title, body, preview, or path snapshot.

## Current prerequisite state

The branch begins after:

- PR #120: recoverable source and occurrence deletion lifecycles;
- PR #123: shared blob reachability, safe GC, warning-tolerant export, and
  physical-delete protection;
- PR #124: D1/workerd compound-select compatibility and mandatory workerd
  migration verification.

No implementation in this slice may weaken those contracts. In particular:

- soft-deleted sources retain the same stable IDs;
- attachment references target occurrences, not blob records or provider keys;
- complete export keeps every table/view snapshot in one D1 batch;
- permanent deletion remains disabled;
- new SQL must pass both host SQLite tests and Wrangler local D1/workerd;
- no remote migration or deployment is run from the feature branch.

## Pull-request boundary

The implementation targets `v2/backend-foundation` and includes only backend,
schema, shared types, tests, CI, and documentation.

### Included

- `reference_targets` schema and indexes;
- immutable registry identity and physical-delete protection;
- public reference type definitions;
- source-specific batch resolver adapters;
- bounded batch resolution service;
- internal idempotent registration service;
- `POST /api/references/resolve`;
- permanent-delete type mapping consistency;
- complete-export table inclusion in the core table-query batch;
- focused reference-foundation verification;
- roadmap and data-model documentation updates.

### Excluded

- `projects`, `project_contents`, `project_items`, Text, Inspector, or Map;
- Project attachment occurrences;
- a generic `reference_usages` or backlinks table;
- object-level deep-link routes or archived source pages;
- deterministic or semantic search;
- public reference registration endpoints;
- force delete, tombstone creation, or privileged permanent deletion;
- provider `HEAD`/`stat`, blob GC, or export-archive redesign;
- frontend routes, pages, components, styles, or dependencies;
- remote D1 migration or Worker deployment.

## Why Project backlinks are not stored yet

A durable Project backlink is a relationship from a future
`project_items.reference_target_id` to one registry row. There is no Project
item identity in this slice. Creating a generic usage table now would either
have no authoritative owner or duplicate the future `project_items` model.

This slice therefore provides:

- stable registry IDs;
- source structural blocker queries;
- a common target-type mapping;
- batch resolution suitable for future Project-item reads.

The later Project-data slice creates the actual Project backlink relationship
through `project_items`. No placeholder usage table is introduced here.

## Closed v1 target-type registry

The public v1 target types are:

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

They map to stable source identities as follows:

| Public type | Source identity |
|---|---|
| `sample` | `samples.id` |
| `run` | `runs.id` |
| `run_step` | `run_steps.id` |
| `comment` | ready canonical `comment_submissions.id` |
| `comment_occurrence` | `run_step_comments.id` |
| `comment_attachment` | `comment_submission_items.id` |
| `execution_image` | `run_step_assets.id` |
| `metrology_reference` | `metrology_template_references.id` |
| `recipe_revision` | `template_versions.id` |

Unknown strings are rejected. The type set is defined once in shared TypeScript
and is covered by schema, resolver, route, and permanent-delete consistency
tests. Project, Project-content, and Project-attachment types are future
extensions; they are not part of the current v1 set.

## Registry schema

Migration `0018_reference_registry.sql` adds:

```text
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
```

### Required constraints

- `registry_version` is `1` for this type set;
- `target_type` is restricted to the closed v1 list;
- `target_id` is non-empty;
- `last_known_contexts_json` is a valid JSON array;
- registry rows cannot be physically deleted;
- `id`, `registry_version`, `target_type`, `target_id`, and
  `first_registered_at` are immutable after insertion;
- only validation/context metadata and the future tombstone field may change;
- the registry has no foreign key to one polymorphic source table;
- no source table cascades into the registry;
- no automatic backfill registers every existing source.

The immutability trigger is essential: a future
`project_items.reference_target_id` must never keep the same foreign key while
its registry row is silently retargeted from one source object to another.

The registry is sparse. A valid raw target can be resolved without already
having a registry row. A registry row is created only when a later durable
consumer needs one or when an internal test explicitly registers it.

## Contexts, not one canonical path

A canonical common Comment may target several Run Steps. It therefore has
several valid source contexts rather than one canonical path. The resolver and
registry use an ordered `contexts` array.

Examples:

```text
Sample A -> Run 1 -> Step 3 -> Comment
Sample B -> Run 2 -> Step 3 -> Comment
```

A Comment attachment inherits every context of its canonical Comment. The
implementation must not choose one target arbitrarily or silently discard the
others.

`last_known_contexts_json` stores only the most recently validated structural
identity needed for a future minimal tombstone or integrity report. Normal
resolution always reads live source tables.

## Shared base read model

Each requested target resolves to one uniform base result:

```text
target
- type
- id

resolution
- resolved
- not_found
- inconsistent
- tombstoned

source
- title
- subtitle
- excerpt
- kind
- state
- updatedAt
- deletedAt
- archivedAt

contexts[]
- segments[]
  - type
  - id
  - label
  - deletedAt
  - archivedAt
```

### Resolution meanings

- `resolved`: the source identity exists, including when it or an ancestor is
  soft-deleted or archived;
- `not_found`: no registry tombstone exists and the source ID does not exist;
- `inconsistent`: a live registry row exists but the source identity is missing
  or structurally invalid;
- `tombstoned`: a future tombstone is present. This slice can read such rows for
  tests but does not create them through an endpoint.

Lifecycle metadata and resolution are separate. A Step under a deleted Run is
still `resolved`; the deleted ancestor is represented in its context.

The following enriched fields are intentionally deferred:

- `openSourceUrl` and archived destinations belong to the deep-link slice;
- expandable child summaries belong to Project/Inspector reads;
- backlink counts belong to the Project-item relationship.

## Resolver architecture

The implementation lives under:

```text
worker/references/
  adapters.ts
  resolver.ts
  registry.ts
```

### Source adapters

Each target type has one adapter that accepts a batch of IDs and issues a small,
documented number of bounded source-specific queries. Adapters must:

- use one JSON-array binding through `json_each(?)` rather than one binding per
  ID;
- include soft-deleted source rows;
- include ancestor lifecycle metadata;
- return deterministic context ordering;
- never return R2 keys, managed-storage object keys, provider locators,
  credentials, or temporary download URLs;
- avoid complete Sample-detail reads and N+1 queries.

Ordinary single-context adapters normally use one source query. Canonical
Comment and Comment-attachment adapters intentionally use additional bounded
queries to resolve Sample contexts and multi-Step contexts without exceeding
D1/workerd compound-select limits.

### Batch resolver

The domain resolver:

1. returns an empty result for an empty internal batch;
2. rejects more than 200 targets with a typed error;
3. validates every target's runtime type and stable-ID shape;
4. groups and deduplicates IDs by type;
5. runs a small fixed number of source queries for each type present;
6. performs one registry lookup for the requested targets;
7. restores original request order and duplicate entries;
8. reports missing targets per item without failing unrelated results.

Query count is `O(number of distinct target types)` with a documented small
constant per adapter. It never grows with the number of target objects. The
contract is not “exactly one query per type.”

### D1/workerd SQL boundary

No resolver query uses a compound `SELECT` chain exceeding the workerd limit.
When multiple context classes are required, the implementation uses separate
bounded queries or D1-safe views rather than one oversized `UNION ALL` chain.
The complete migration chain must continue to pass
`npm run verify:d1-migrations`.

## Target-specific rules

### Sample

Returns code, title, description excerpt, status, location, timestamps, and
Sample lifecycle metadata.

### Run

Returns the immutable template name/version snapshot, Run kind, status,
timestamps, and the `Sample -> Run` context.

### Run step

Uses `COALESCE(run_steps.title, step_definitions.name)` and returns the
`Sample -> Run -> Step` context with lifecycle metadata for every segment.

### Canonical Comment

Only a ready `comment_submissions` row is a durable logical `comment` target.
Draft, uploading, failed, or cancelled submissions do not become logical
Comment references.

Sample Comments return a Sample context. Run-step Comments return every row in
`comment_submission_targets`, ordered deterministically.

### Comment occurrence

A `run_step_comments` row is a context-specific occurrence. When it links to a
canonical submission, logical body and author data come from that submission.
A legacy occurrence with no submission ID can resolve only as a
`comment_occurrence`; it must not manufacture a logical `comment` target.

### Comment attachment

Returns occurrence metadata such as kind, display title, filename, description,
MIME type, status, and lifecycle fields. It inherits all canonical Comment
contexts. Blob identifiers and provider locations are excluded.

### Execution image

Resolves `run_step_assets.id` in its Sample, Run, and Step context. Asset
metadata may supply a display filename, but the response never exposes the
physical locator.

### Metrology reference

Resolves `metrology_template_references.id` in its exact Recipe-revision
context.

### Recipe revision

Returns name, version, template kind/type, lock state, archive state, deletion
state, and source filename. Archived or soft-deleted historical revisions remain
resolvable.

## Registry service

`registry.ts` provides internal operations equivalent to:

```text
registerReferenceTarget
refreshReferenceTarget
getReferenceTargets
```

Registration:

1. resolves and validates the target through the same bounded domain service;
2. rejects `not_found` or `inconsistent` targets;
3. inserts with `INSERT OR IGNORE`;
4. returns the canonical row selected by `(target_type, target_id)`;
5. updates validation time and last-known contexts explicitly.

Ordinary resolution does not update `last_validated_at`. Read-only Project or
search pages must not create database writes merely by displaying references.

There is no public registration endpoint in this slice. A later Project-item
creation route calls this service server-side.

## API boundary

The only new route is:

```text
POST /api/references/resolve
```

Request:

```json
{
  "targets": [
    { "type": "sample", "id": "..." },
    { "type": "run_step", "id": "..." }
  ]
}
```

Rules:

- the HTTP endpoint requires 1 to 200 targets;
- the domain service independently permits 0 to 200 targets and enforces the
  upper bound for future internal callers;
- unknown type, empty/whitespace-padded ID, or excessive ID length returns a
  typed domain error mapped to `400`;
- the endpoint is authenticated by the existing application middleware;
- the endpoint is read-only;
- results preserve request order and duplicate requests;
- one missing target does not fail the batch;
- no source mutation capability is returned.

## Permanent-delete blocker integration

The public reference type list and existing permanent-delete planner use one
explicit mapping:

```text
comment              -> comment_submission
comment_occurrence   -> run_step_comment
comment_attachment   -> comment_submission_item
execution_image      -> run_step_asset
metrology_reference  -> metrology_template_reference
recipe_revision      -> template_version
```

Tests require every public target type to have exactly one blocker mapping and
one resolver adapter. Permanent deletion remains disabled and database physical-
delete triggers remain authoritative.

## Export behavior

The current complete-export manifest remains schema version 3 because its table
snapshot map is open to additional tables and the archive shape does not change.

`reference_targets` is part of the core `/api/exports/all` `tableQueries` map.
Every registry row is therefore read in the same `DB.batch` as Samples, Runs,
Comments, occurrences, blob metadata, the GC ledger, and retention views. The
Worker entry does not issue a second registry query or mutate a completed
manifest.

The export preserves IDs, validation timestamps, tombstone metadata, and
context JSON exactly. Registry rows do not create blob occurrences or download
entries.

A future Project-data/export slice will introduce the next export schema version
when Projects, contents, items, placements, and edges become part of restore
semantics.

## Verification

Focused tests cover:

- the complete 0001 -> 0018 migration chain in host SQLite;
- the same chain through Wrangler local D1/workerd;
- the closed target-type constraint and JSON-array constraint;
- rejection of registry-ID or source-identity retargeting;
- allowed updates to validation contexts/time and the future tombstone field;
- idempotent registration and duplicate races;
- active, soft-deleted, archived, and deleted-ancestor resolution;
- all nine target adapters;
- common Comment multi-context behavior;
- logical Comment versus occurrence identity;
- attachment occurrence versus blob identity;
- result ordering, duplicate requests, and 200-target batches;
- domain rejection of a 201-target batch and malformed runtime targets;
- bounded query count by target-type composition;
- no locator or provider-key leakage;
- `not_found`, `inconsistent`, and tombstoned results;
- read-only route behavior and validation;
- registry inclusion in the core complete-export batch;
- exact resolver/blocker/type-set consistency.

Repository commands are:

```text
npm run test:reference-foundation
npm run verify:reference-foundation
```

The CI order is:

```text
pre-pr/install
pre-pr/blob-lifecycle
pre-pr/reference-foundation
pre-pr/tests
pre-pr/build
```

`verify:v3-deployment` includes the reference-foundation gate before any remote
migration or deployment command can run.

## Documentation updates

This slice keeps the following documents synchronized:

- `PROJECT_DESIGN_FOUNDATION.md`: Phase 1B complete after PR #123/#124 and Phase
  2 split into base resolution, deep links, and deterministic search;
- `V3_BACKEND_FOUNDATION.md`: registry and resolver implementation state;
- `DATA_MODEL.md`: blob lifecycle stated as implemented and registry added;
- `ARCHITECTURE.md`: read-only reference, service-bound, registry-identity, and
  single-batch export invariants;
- blob implementation/operations documents: the next boundary now begins with
  deep links rather than re-listing the registry as unimplemented;
- `README.md`: implementation-plan link where appropriate.

## Completion criteria

The PR is complete when:

1. one shared v1 target-type list governs schema validation, adapters, routes,
   and blocker mapping;
2. registry creation is sparse and idempotent;
3. registry identity cannot be updated to represent another target;
4. all nine target classes resolve in bounded batches;
5. the domain resolver itself enforces the 200-target and runtime-shape
   contract;
6. soft-deleted sources and deleted ancestors remain resolvable;
7. common Comments retain every deterministic context;
8. no resolver response exposes a physical storage locator;
9. the public endpoint is read-only and order-preserving;
10. complete export preserves registry rows in the same D1 batch as all other
    table snapshots;
11. host SQLite, Wrangler local D1/workerd, focused tests, the complete test
    suite, and production build pass;
12. the PR targets only `v2/backend-foundation`;
13. no remote D1 migration or Worker deployment is run.

## Next slices

After this slice:

1. object-level deep links and archived read-only destinations;
2. deterministic search and reference insertion;
3. Project-owned data, `project_items` backlinks, Text, and Inspector;
4. dynamically loaded Map placements and edges.

Map remains last so its interaction model is built on stable source identity,
resolution, Project-item identity, and read paths rather than becoming the
persistent data model itself.
