# Data model

The tables below describe the current schema. The proposed provider-neutral
`File`/`FileLocation` model and purpose-based storage rules are defined in
[file storage architecture](./FILE_STORAGE_ARCHITECTURE.md). The
[compatibility plan](./FILE_DATA_PORTABILITY_IMPLEMENTATION_PLAN.md#schema-and-api-transition-strategy)
requires preserving business identities, classifying existing file uses and
updating export/recovery with every schema slice. [FP1a](./FP1_FILE_REGISTRY_FOUNDATION.md)
adds four dormant identity/observation tables; provider-neutral runtime publication
and consumer conversion remain later work. Subsequent accepted-operation ledgers
preserve import, byte-upload, metrology-reference and Comment publication history alongside
the business tables and required exported retention view.

Original S2 review: integration commit
`4e78fa76b727f81b1431b60ff481bd686d83cb4c`; accepted-operation additions through
[FP1j](./FP1_COMMENT_ACCEPTANCE.md) extend that retained schema. The
[repository compatibility audit](./FILE_DATA_PORTABILITY_REPOSITORY_COMPATIBILITY.md)
maps the proposed transition to existing modules, schema guards and test gates.

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
| `comment_submission_acceptances` | Immutable actor-bound Comment input, fixed seven-day deadline, frozen multi-target publication plan and original result. Auxiliary history preserves the canonical submission identity and adds no byte-retention root. |
| `comment_item_acceptances` | Per-item checksum, purpose, frozen physical profile/candidate, one execution owner and original verified upload result. Cancellation does not rewrite the original submission manifest. |
| `run_step_comments` | Stable occurrence of a canonical Comment in one Run Step; legacy rows may directly carry an image asset. |
| `metrology_template_references` | Stable reference-file occurrences attached to a metrology template. |
| `reference_targets` | Sparse, idempotent polymorphic registry for durable external source identities. Its registry identity and source target are immutable; it stores validation metadata rather than copied source content. |
| `managed_storage_objects` | Metadata for unchanged original files stored through the provider-neutral `ManagedStorage` adapter. |
| `assets` | R2 object metadata and readiness state for imported and ordinary uploads. |
| `r2_upload_requests` | Actor-bound ordinary-image/Project byte-upload acceptance with fixed identity and replay lifetime; no new byte-retention root. |
| `metrology_reference_upload_requests` | Actor- and Template-bound metrology upload, frozen occurrence publication plan and immutable business result; no asset/occurrence retention root. |
| `storage_profiles` | Immutable, explicitly identified historical storage namespace; fixed configuration source and environment credential reference, without credentials. |
| `files` | First legacy metadata observation with purpose or explicit unresolved classification, expected bytes and no verified hash or active location. |
| `file_locations` | Immutable unresolved legacy physical address scoped to a storage profile. Not an independent retention root or published file. |
| `legacy_file_mappings` | Deterministic legacy locator to File/Location mapping and bounded classification evidence. Old domain locators remain authoritative. |
| `attachment_derivatives` | Source-content-addressed browser-preview registry with generator, status and retention metadata; a separate trusted producer is not implied. |
| `blob_integrity_quarantine` | Integrity findings that prevent ordinary reuse or publication of affected physical locators. |
| `projects` | Project identity, lifecycle, optimistic revision and next creation-sequence watermark. |
| `project_contents` | Project-owned Markdown source or attachment presentation; not copied experimental source records. |
| `project_content_attachments` | One attachment subtype per owned content row, with occurrence presentation and exactly one current asset/managed-object locator. |
| `project_items` | Project-local content or Reference occurrences, with immutable creation sequence and recoverable deletion metadata. |
| `project_map_placements` | At most one stored Map placement per item; authoritative active-item creation supplies the stronger exactly-one guarantee. |
| `project_edges` | Project-local item-to-item connections, handles, markers, labels, revisions and deletion groups. |
| `blob_retention_edges` | Derived shared view of every current reason that provider bytes must remain recoverable. |
| `blob_gc_ledger` | Provider-neutral orphan, deletion-claim, retry, and terminal cleanup work state. |
| `state_verifications` | Sparse observed-state anchors connected to the previous verification. |
| `state_verification_steps` | Immutable ordered snapshot of the actual Steps covered by a verification interval. |
| `recipe_change_proposals` | Evidence opened by mismatched verification; included in export and used as a historical reference blocker. |
| `imports` | Pending/ready/failed state and provenance for a FabuBlox import, including immutable accepted request input, frozen placement and original result. |

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
[v3 backend foundation](./V3_BACKEND_FOUNDATION.md). Project, Map, Reading, and
the reference model are specified in
[Project design foundation](./PROJECT_DESIGN_FOUNDATION.md).


Recovery may discover that two stable occurrences in the same context refer to
provider-verified identical bytes. It never deletes either row. The legacy
occurrence becomes an immutable soft-supersession tombstone linked to the
surviving occurrence and recovery operation. This explicit supersession, unlike
ordinary soft deletion, transfers only the redundant byte-retention edge; both
occurrence identities and all audit metadata remain in export and reference
history.

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
copied or backfilled into it. A row is registered when a durable consumer,
including a Project item, needs a stable registry identity. Raw valid targets
can still be read through the batch resolver before registration.

The registry stores:

- public target type and stable source ID;
- registry version;
- first registration and last explicit validation time;
- future tombstone time;
- last-known structural contexts for integrity reporting.

The registry row ID, registry version, target type, target ID, and first
registration time are immutable after insertion. Project items keep foreign keys
to those rows, so a registry row cannot be updated in place to represent a
different source. Only validation metadata, last-known contexts, and the future
tombstone field may change.

The registry does not store authoritative titles, bodies, status, previews,
file paths, or provider locators. Normal resolution reads current source tables
through bounded source-specific adapters.

A target may have more than one context. In particular, one canonical common
Comment and each of its attachments may belong to several Sample/Run/Step
contexts. The read model therefore exposes ordered `contexts[]`, not one
arbitrarily selected path.

The domain resolver accepts zero to 200 targets, validates runtime target
shape, and preserves caller order and duplicate entries. The HTTP route requires
one to 200 targets. Query count grows with the distinct target types and a small
fixed per-adapter constant, not with the number of target objects.

The resolver preserves soft-deleted sources, deleted ancestors, and archived
Recipe revisions as resolved read-only objects with lifecycle metadata. It
distinguishes them from truly missing, structurally inconsistent, and future
tombstoned targets. Ordinary resolution does not update registry timestamps.

Actual Project consumer relationships are represented by the existing
`project_items.reference_target_id` rows, not a parallel generic usage table.
This is a persisted relationship, not a claim that every possible backlink UI
has been implemented.

See [reference registry and batch resolver implementation plan](./REFERENCE_RESOLUTION_IMPLEMENTATION_PLAN.md).

Phase 2C1 deterministic search adds no table or mutable index. It reads the
authoritative source and occurrence rows through type-specific SQLite queries,
then revalidates candidates through the resolver. The current source scan bounds
query count, bindings, candidate output, and resolver work, but rows examined
still grow with source-table size.

A later performance slice may add a rebuildable SQLite FTS5 virtual table behind
the candidate-backend interface. That index is derived data in both D1 and a
future Docker/self-hosted SQLite deployment: it is not an identity owner, is not
the source of lifecycle truth, and may be omitted from canonical export and
rebuilt after restore. See [deterministic reference search implementation plan](./REFERENCE_SEARCH_IMPLEMENTATION_PLAN.md).

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

The shared ingestion/registration paths persist candidate metadata before the
provider write, then conditionally publish or reconcile the outcome. Failed or
unknown writes remain tracked; they do not authorize deleting a competing winner.
See [registration](../worker/blob-lifecycle/registration.ts). Recorded content
hashes support deduplication, but existing managed-provider size/ETag checks are
not independently verified whole-object SHA-256 evidence. The FP transition
must preserve that distinction rather than strengthen old evidence by relabelling it.

A physical blob may be shared by active, unfinished, retryable, archived, or
soft-deleted sources. The provider object therefore cannot be collected from
one source status alone. Reference resolution targets source or occurrence IDs
and never exposes a provider object key.

## Complete export

The full export inventories canonical application tables and the required
retention view, and packages available physical bytes using relative paths.
Other views are explicitly classified as reconstructible by
[the schema-coverage test](../worker/export-schema-coverage.test.ts). Failed,
deleted, orphaned, and missing blob metadata remain in table JSON as audit data.

The current exporter is availability-aware:

- the canonical table catalog and required retention view, including
  `reference_targets`, are read through one D1 batch;
- metadata-not-ready rows are not treated as guaranteed bytes;
- ready objects are deduplicated by physical locator;
- missing or unavailable objects produce structured warnings;
- one failed byte retrieval does not abort the entire ZIP;
- `export-manifest.json` records final outcomes after retrieval attempts;
- `export-warnings.json` is always written;
- registry rows remain ordinary table data and do not create blob occurrences.

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

The current S2 schema has no `samples.process_revision` column. Sample
concurrency uses `updated_at` and mutation IDs; Project APIs use their explicit
revision fields. S2 stores legacy occurrence text in `run_step_comments.legacy_body`,
not the retired `body` column; canonical Comment text belongs to its submission.
The current v9 profile retains the negotiated v8 compatibility projection, which preserves observed retired values from supported
historical schemas in `provenance/retired-fields.json`; it does not invent values
for absent S2 columns. V9 additionally captures the four dormant registry tables.
See [the actual snapshot](../worker/export-v9-snapshot.ts)
and [S2 schema assertions](../worker/export-schema-coverage.test.ts).

Reference registration uses `UNIQUE(target_type, target_id)` plus
`INSERT OR IGNORE` and then reads the canonical row. The database rejects any
attempt to update a registry row's stable identity. Ordinary resolution is
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

<a id="planned-project-entities"></a>

## Current Project entities

Project persistence is already implemented in the six tables listed above.
Map and Reading project the same item occurrences. Reading follows immutable
`created_sequence`; there is no separate Text-placement table or independent
Reading-order model. Repeated references are allowed, while an owned content row
belongs to one item. Active-item creation publishes its placement together with
its content/reference relationship. Edges connect item IDs, not File IDs.

Project source references remain read-only. Owned Markdown stays a plain source
string in `project_contents`; storage portability does not turn it into a file
upload or make the React Flow representation authoritative. The current
[Project API](../shared/contracts/project-api.ts) owns revisions, operation IDs,
geometry and mutation response shapes. Native import needs an explicit identity
and publication mapping; a raw insertion of Canvas JSON does not satisfy it.

The conceptual model is defined in
[PROJECT_DESIGN_FOUNDATION.md](./PROJECT_DESIGN_FOUNDATION.md); current phase
priority belongs to [the product roadmap](./PRODUCT_ROADMAP.md).
