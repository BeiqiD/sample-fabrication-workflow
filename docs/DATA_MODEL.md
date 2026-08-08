# Data model

## Current source and storage entities

| Entity | Purpose |
|---|---|
| `samples` | A physical wafer, chip, piece, or other tracked item. Self-reference represents parent/child splitting; a child can retain the parent's structure hash at the split boundary. |
| `events` | Append-oriented audit timeline records: creation, comments, images, location/status changes, and Run-step activity. Events are not the canonical Comment or attachment model. |
| `recipe_families` | Legacy internal table name for the stable identity shared by successive process-template versions. |
| `step_definitions` | SHA-256-addressed instructions; order and version are deliberately excluded from the hash. |
| `state_representations` | SHA-256-addressed expected Sample states, currently represented by ordered diagram assets. |
| `state_representation_assets` | Ordered attachment edges from a state representation to R2 asset metadata. |
| `template_versions` | Imported or cloned Recipe revisions with an ordered manifest of logical Step, definition, and expected-state hashes. |
| `template_steps` | Ordered logical references from a Recipe revision to hashed definitions and expected states. |
| `runs` | Ordered process or metrology Runs for one physical Sample, including the immutable initial substrate hash, predecessor, and anchor Step. |
| `run_plan_revisions` | Immutable records of which process-template version governed the unfinished plan at each revision. |
| `run_steps` | The actual execution chain. Template-derived rows reference definitions; corrections are nullable overrides and ad-hoc rows are explicit actual Steps. |
| `run_step_plan_links` | Links process-template plan entries to stable actual Run-step identities across plan revisions. |
| `run_step_assets` | Stable execution/observation image occurrences linked to shared R2 asset metadata. |
| `comment_submissions` | Canonical logical Comments and their upload/finalization lifecycle. A ready row owns body, author, and attached items once. |
| `comment_submission_targets` | Canonical Comment targets in Sample/Run/Step context. A common Comment may own several target contexts. |
| `comment_submission_items` | Stable inline-image, original-file, or link occurrences owned by a canonical Comment. |
| `run_step_comments` | Stable occurrence of a canonical Comment in one Run Step; legacy rows may directly carry an image asset. |
| `metrology_template_references` | Stable reference-file occurrences attached to a metrology template. |
| `reference_targets` | Sparse, idempotent polymorphic registry for durable external source identities. It stores identity and validation metadata, not copied source content. |
| `managed_storage_objects` | Metadata for unchanged original files stored through the provider-neutral `ManagedStorage` adapter. |
| `assets` | R2 object metadata and readiness state for imported and ordinary uploads. |
| `blob_retention_edges` | Derived shared view of every current reason that provider bytes must remain recoverable. |
| `blob_gc_ledger` | Provider-neutral orphan, deletion-claim, retry, and terminal cleanup work state. |
| `state_verifications` | Sparse observed-state anchors connected to the previous verification. |
| `state_verification_steps` | Immutable ordered snapshot of the actual Steps covered by a verification interval. |
| `recipe_change_proposals` | Evidence opened by mismatched verification; included in export and used as a historical reference blocker. |
| `imports` | Pending/ready/failed state and provenance for one confirmed FabuBlox workbook import. |

## Identity and lifecycle layers

A source or occurrence ID carries application meaning. A blob record carries
physical-byte metadata. Those identities are deliberately separate:

```text
source -> occurrence -> blob record -> provider object
```

Examples:

```text
canonical Comment
  -> comment attachment occurrence
    -> managed_storage_objects row
      -> SWITCHdrive/WebDAV object

Run Step
  -> execution image occurrence
    -> assets row
      -> private R2 object
```

Ordinary Delete sets lifecycle metadata on the source or occurrence. It does
not delete shared bytes and does not rewrite source hierarchy. Restore exposes
the same stable ID.

The complete source identity and soft-delete contract is in
[v3 backend foundation](./V3_BACKEND_FOUNDATION.md). Project, Text, Map, and the
reference model are specified in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md).

## Reference identity and resolution

The v1 reference type set is closed and versioned:

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

`reference_targets` is sparse. Existing source rows are not automatically
copied or backfilled into it. A row is registered only when a future durable
consumer needs a stable registry identity. Raw valid targets can still be read
through the batch resolver before registration.

The registry stores:

- public target type and stable source ID;
- registry version;
- first registration and last explicit validation time;
- future tombstone time;
- last-known structural contexts for integrity reporting.

It does not store authoritative titles, bodies, status, previews, file paths, or
provider locators. Normal resolution reads current source tables through
bounded source-specific adapters.

A target may have more than one context. In particular, one canonical common
Comment and each of its attachments may belong to several Sample/Run/Step
contexts. The read model therefore exposes ordered `contexts[]`, not one
arbitrarily selected path.

The resolver preserves soft-deleted sources, deleted ancestors, and archived
Recipe revisions as resolved read-only objects with lifecycle metadata. It
distinguishes them from truly missing, structurally inconsistent, and future
tombstoned targets. Ordinary resolution does not update registry timestamps.

Actual Project backlinks are not represented by a generic placeholder table.
They will arise from future `project_items.reference_target_id` rows when
Project-item identity exists.

See [reference registry and batch resolver implementation plan](./REFERENCE_RESOLUTION_IMPLEMENTATION_PLAN.md).

## Blob reachability and GC metadata

Blob reachability is derived from source and occurrence relationships. It is
not stored as a mutable boolean on `assets` or `managed_storage_objects`.
Cancel, scheduled cleanup, export, and future permanent-delete planning query
one shared `blob_retention_edges` surface.

`blob_gc_ledger` records cross-provider cleanup work without replacing
occurrence-to-blob edges or upload readiness. Upload readiness, reachability,
provider availability, and GC state remain distinct concepts. Cleanup uses a
guarded `orphaned -> deleting -> deleted` operation-ID flow.

The normative contract and concrete implementation record are:

- [Blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md)
- [Blob lifecycle implementation record](./BLOB_LIFECYCLE_IMPLEMENTATION_PLAN.md)
- [Blob lifecycle activation and operations](./BLOB_LIFECYCLE_OPERATIONS.md)

## R2 and managed-storage behavior

R2 object keys are stored in D1. The bucket stays private and the Worker returns
assets only through application routes. Original files use the
`ManagedStorage` adapter; provider credentials and requests stay server-side.

Ordinary uploads are registered only after provider writes succeed. Newly
received content is SHA-256-addressed and deduplicated. A failed registration
removes the object or records a recoverable failure according to the upload
path.

A physical blob may be shared by active, unfinished, retryable, archived, or
soft-deleted sources. The provider object therefore cannot be collected from
one source status alone. Reference resolution targets source or occurrence IDs
and never exposes a provider object key.

## Complete export

The full export includes every database table and packages available physical
bytes using relative paths. Failed, deleted, orphaned, and missing blob metadata
remain in table JSON as audit data.

The current exporter is availability-aware:

- metadata-not-ready rows are not treated as guaranteed bytes;
- ready objects are deduplicated by physical locator;
- missing or unavailable objects produce structured warnings;
- one failed byte retrieval does not abort the entire ZIP;
- `export-manifest.json` records final outcomes after retrieval attempts;
- `export-warnings.json` is always written;
- `reference_targets` rows are preserved as table data without creating blob
  occurrences.

The browser currently assembles the ZIP in memory. Streaming/server-side or
desktop export remains a later scalability slice.

## Concurrency and audit

Location, lifecycle status, and pinned changes are recorded by database
triggers. Process-Run triggers keep normal lifecycle synchronized: starting or
reopening a Run makes its Sample `active`, and completing the final active Run
returns an `active` Sample to `stored` without overriding an explicit
`consumed` or `lost` state.

Update APIs require the caller's last-seen revision, usually `updated_at`.
`last_mutation_id` values are internal concurrency tokens that let dependent
writes prove that the preceding conditional mutation succeeded within the same
D1 batch.

Validated Cloudflare Access email addresses are stored on events and mutable or
imported records. Older rows created before attribution remain valid with a
null actor.

`samples.process_revision` remains only for compatibility with the deployed
alpha schema. Current concurrency control uses `updated_at` and mutation IDs;
removing the legacy column requires an explicit migration.

Reference registration uses `UNIQUE(target_type, target_id)` plus
`INSERT OR IGNORE` and then reads the canonical row. Ordinary resolution is
read-only; explicit registration or refresh is the only operation that updates
validation metadata.

## Template and Run history

A process-template version states what should happen and what state should
result. A process Run records what did happen. `run_step_plan_links` connect
those views without treating an execution correction as a template edit.

Plan updates align normalized Step names independently of order. Repeated names
prefer exact unchanged definitions, then stable logical keys, then occurrence
order. Step numbers are display metadata; parameter, note, custom-field, and
diagram changes normally do not determine identity.

The newest assigned Template version is authoritative for every matched plan
entry's order, definition, imported Comments, and expected diagrams. Matched
Run-step identities retain status, actual overrides, user Comments,
attachments, and execution images. Removed Template entries become superseded
without deleting their execution evidence.

A Recipe revision used by a Run remains historical data. Ordinary deletion is
recoverable and prevents new assignment; archive and deletion do not rewrite
existing Runs or plan revisions. Historical revisions remain valid reference
resolver targets.

## Verification

Verification is not inferred from `done`. A user may verify after any Step once
every current Step in the interval is done or skipped. The verification stores
its predecessor and an explicit ordered coverage snapshot; a mismatch also
opens process-change evidence without mutating execution history.

## Planned Project entities

Project schema does not belong in the reference-registry PR. The later Project
phase adds stable Project/content/item identities, `project_items` relationships,
independent Text and Map placements, and local edges. Project items, rather than
a premature generic usage table, become the authoritative consumer/backlink
relationship for registry targets.

The conceptual model and phase order are fixed in
[PROJECT_DESIGN_FOUNDATION.md](./PROJECT_DESIGN_FOUNDATION.md).
