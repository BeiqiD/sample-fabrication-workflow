# Architecture

## Runtime

The application is one Cloudflare Worker deployment. React/Vite serves the interface, Hono serves `/api`, D1 stores relational state, a private R2 bucket stores workbooks and images, and an optional `ManagedStorage` adapter stores unchanged original files.

```mermaid
flowchart TD
  U[Authenticated browser] --> A[Cloudflare Access]
  A --> W[Unified Hono Worker]
  C[Daily scheduled trigger] --> W
  W --> D[(D1)]
  W --> R[(Private R2)]
  W --> M[(Optional ManagedStorage)]
```

Reference routes are mounted directly in the core Hono app. They inherit the
same error handling, same-origin write guard, Access authentication, identity,
and future authorization middleware as every other protected API route. There
is no reference-specific security stack or dispatching Worker entry to keep in
sync. The complete-export route includes `reference_targets` directly in its
existing table-query batch and performs no second registry query or manifest
augmentation.

The blob-lifecycle and reference-foundation implementations remain inside this
one deployment. They do not require Queues, Workflows, Durable Objects,
Containers, or a second Worker.

## Security boundary

- Production is fail-closed: `AUTH_MODE=access` is a Cloudflare Runtime Variable. Account-specific runtime values are preserved across Wrangler deployments and are never committed to the repository.
- Every API route except the shallow `/api/health` endpoint validates the `Cf-Access-Jwt-Assertion` signature, issuer, and application audience against the team's rotating JWKS.
- `ALLOWED_EMAILS` can add an application-level email allowlist after JWT validation.
- Unsafe browser requests must have the same `Origin` as the Worker.
- `/api/ready` is authenticated and verifies both D1 and R2 bindings; configured managed storage is checked separately.
- R2 is private; assets are returned only by authenticated application routes.
- Managed-storage credentials remain server-side and are never returned in export manifests or warnings.
- Reference responses expose source/occurrence identity and read-only summaries. They never expose R2 keys, managed-storage object keys, provider locators, credentials, or source mutation capabilities.

## Data invariants

- Sample codes and template version numbers are unique in D1.
- Stable Sample, Run, Run-step, canonical Comment, attachment occurrence, execution-image occurrence, metrology-reference, and Template identities use soft-delete/restore semantics. Accidental physical deletion of the protected source tables is rejected by database triggers.
- A process-template family owns immutable versions. A version is editable only before its first run-plan reference; the first reference atomically locks it.
- An unused template version can be moved to trash. Once a version has a run-plan or historical reference it can only be hidden/archived, preserving every historical link while removing it from future assignment choices.
- Metrology templates are flat, directly editable presets. A run entry stores the selected step-definition hash as its immutable snapshot, so edits in either direction never propagate between the template and an existing record.
- Metrology template equipment/method notes and reference files are template-only. They are intentionally excluded from run snapshots and run views.
- Step definitions and expected diagram states are content-addressed. Process-template versions, plans, and runs reference their hashes, so repeated content is stored once.
- A physical sample has at most one active process run, while metrology can run independently or sit between fabrication steps. Starting, completing, or editing metrology never changes sample status or current structure and never contributes to fabrication progress.
- Starting or reopening a process run makes the sample `active`; completing it returns an `active` sample to `stored`. Explicit physical states such as `consumed` or `lost` are never overwritten by run completion.
- Finished runs form an ordered predecessor chain; a new run anchors to the previous run's last actual step.
- Every run stores an immutable initial substrate hash confirmed when it begins. Before a new run starts, the server revalidates the displayed template and current-sample structure choices.
- Split children store the parent's current structure as an inherited substrate snapshot. Their first run requires the same confirmation when that structure differs from the selected template.
- Each run has immutable plan revisions. A newer version of the same process-template family becomes authoritative for the current plan's order, definitions, imported notes, and expected diagrams. Matched rows retain their execution status and user-entered evidence, ad-hoc execution remains in the chain, and newly inserted work behind the execution boundary is linked as skipped.
- Version alignment matches normalized step names independently of order. Repeated names prefer unchanged definitions, then stable logical keys, then occurrence order. Step numbers do not define cross-version identity.
- Run rows store actual overrides only when they differ from the hashed process-step definition. Comments, deviation reasons, execution diagrams, and ad-hoc steps remain sample-specific.
- State verification is a sparse fabrication-only chain. It ignores metrology records, snapshots the fabrication steps covered since the previous valid verification, and records the matched or mismatched outcome.
- Sample state changes and their history events are emitted by database triggers.
- Dedicated bench records update sample state and append the manual event in one D1 batch, guarded by the caller's last-seen timestamp and a per-mutation identifier.
- Processing reads omit the permanent Timeline and parent/child archive data; the Sample page uses the full archive view.
- Step state, notes, optional attachment event, sample timestamp, and run rollup are one D1 batch.
- Every user-originated record stores the validated Access email.

## Presentation invariants

- User-authored Project Markdown and displayed Sample-note and process-Comment bodies remain authoritative plain strings. The browser derives sanitized HTML and MathML; neither representation is stored in D1 or returned as an authoritative API field.
- `src/lib/rich-text.ts` owns one URL, raw-HTML, and bounded-TeX safety contract with two presentation policies: document mode for Project Reading and compact mode for Comments.
- Comment creation remains an ordinary textarea plus the existing image, file, and link controls. There is no WYSIWYG state, editor AST, generated-HTML column, inline attachment reference, or Comment-specific content schema.
- Markdown image syntax is not an inline media channel in Comments. It becomes a safe link, while uploaded images and files retain their existing occurrence, lifecycle, retry, export, and deletion boundaries.
- Comment rendering is lazy below route/component boundaries so Marked and Temml do not become part of the application shell or the desktop Project Map path merely because the shared renderer exists.

## Reference resolution invariants

- The v1 public target-type set is closed and shared by schema validation, resolver adapters, API validation, and permanent-delete blocker mapping.
- `reference_targets` is sparse and idempotent under `UNIQUE(target_type, target_id)`. It stores stable identity and explicit validation metadata, not copied source content.
- A registry row's `id`, `registry_version`, `target_type`, `target_id`, and `first_registered_at` are immutable. Validation contexts and a future tombstone may change, but an existing registry identity cannot be retargeted.
- Raw valid source identities can resolve before registration. Registration exists for later durable consumers such as Project items.
- Normal resolution reads source tables and never updates `last_validated_at`; display reads remain read-only.
- Soft-deleted sources, deleted ancestors, and archived Recipe revisions remain resolved with lifecycle metadata rather than becoming accidental `404`s.
- A canonical common Comment and its attachment occurrences may have several valid Sample/Run/Step contexts. The read model returns ordered `contexts[]` and never selects one arbitrary path.
- Each adapter accepts a JSON-array ID binding, performs a small fixed number of bounded source-specific queries, and returns no blob or provider locator.
- Query count grows with the number of distinct target types, not with the number of target objects. Comment and Comment-attachment adapters intentionally use additional bounded context queries.
- The domain resolver accepts zero to 200 targets, validates the runtime type/ID shape, preserves caller order and duplicates, and returns an empty result for an empty internal batch. The HTTP endpoint requires one to 200 targets.
- A missing or inconsistent target does not abort unrelated results.
- A live registry row whose source cannot resolve is `inconsistent`; an unregistered missing source is `not_found`; a future tombstone is `tombstoned`.
- Actual Project backlinks are deferred to `project_items.reference_target_id`; no parallel generic usage table is introduced before Project-item identity exists.
- Registry rows reject physical deletion. Permanent deletion and tombstone creation remain disabled.

## Deterministic reference search invariants

- Search covers exactly the closed nine-type v1 reference set and returns
  the same stable `ReferenceTarget` identity used by the resolver and
  canonical destination model.
- The first implementation reads authoritative source tables directly and
  adds no denormalized index, FTS table, background synchronizer, Queue,
  Workflow, Durable Object, or second Worker.
- New-reference discovery excludes deleted sources and deleted required
  Sample/Run/Step ancestors. A common Comment remains discoverable when at
  least one deterministic context is active. Archived but not deleted
  Recipe revisions and metrology references remain historical targets.
- Canonical Comment body search returns the logical ready Comment rather
  than duplicating one result per occurrence. Canonical occurrences remain
  addressable by exact occurrence ID; legacy occurrences without a logical
  Comment retain body search.
- Ranking exposes exact-ID, exact-primary, primary-prefix, target-content,
  and metadata tiers. Candidate backends also carry one private specificity:
  byte-exact ID, folded ID, byte-exact primary, folded primary, prefix, content,
  then metadata. SQL candidate caps and cross-type merging use that same order
  before timestamp, closed type order, and stable ID.
- Query count, bindings, returned candidates, and resolver work are bounded per
  selected type. The first source-scan backend still examines work proportional
  to source-table size; result `LIMIT` does not make scan CPU independent of data
  volume.
- Matching uses byte-exact `BINARY` identity/title branches and an explicit
  ASCII-only fold for fallback text comparison. It does not use locale-dependent
  JavaScript casing, silently truncate tokens, or treat `\`, `%`, and `_` as
  wildcard syntax. NFC and NFD remain distinct in the source-scan backend.
- Candidate discovery is behind a runtime-neutral backend interface. The current
  backend uses portable SQLite `INSTR`, `LOWER`, `CASE`, and bound parameters;
  D1 is one adapter. A Docker-hosted SQLite runtime can implement the same
  interface, and a later derived FTS5 backend can replace scans without changing
  ranking, lifecycle, selection, or resolver contracts.
- Search reads do not register targets or mutate source rows. Phase 3
  re-resolves and registers at Project-item write time.
- Search responses contain canonical application destinations but no R2
  key, managed-storage object key, provider locator, credential, or
  temporary URL.

## Blob lifecycle invariants

- Sources and occurrences own meaning. `assets` and `managed_storage_objects` own physical-byte metadata and deduplication.
- `blob_retention_edges` is the shared definition used by Cancel, scheduled cleanup, export mapping, and future permanent-delete planning.
- Soft deletion and archival do not remove durable retention edges. Unfinished/retryable submissions retain already-registered bytes until retryability is explicitly closed.
- Sample-record primary images and distinct `events.metadata_json.thumbnailKey` images are separate retention edges.
- `assets.status` expresses upload/registration readiness. `blob_gc_ledger` expresses cross-provider cleanup work; they are not interchangeable.
- GC uses `orphaned -> deleting -> deleted` with a unique operation ID. Edge creation clears only an unclaimed orphan and rejects `deleting` or `deleted` locators.
- Cancel does not delete provider bytes. The daily scheduled handler is the ordinary physical-cleanup entry point.
- A `deleted` locator is terminal and must not be silently reused for different bytes. Recovery registers a new locator.
- Ready R2 content is unique among live locators. Historical metadata for a collected locator remains, and the same content may be registered again at a new live locator after the old locator reaches `deleting` or `deleted`.
- A legacy pre-blob-lifecycle migration rewires unfinished Comment items away from an orphaned managed object when an already-ready content-identical winner exists. This prevents the old partial uniqueness rule from blocking migration 0016.
- Canonical recovery never physically merges stable execution-image or metrology-reference occurrences. An exact same-content duplicate is soft-superseded with an immutable successor/operation audit link; only that superseded edge stops retaining the old locator.
- Provider absence is an integrity condition, not permission to remove source or occurrence rows.

## Export invariants

- Full export reads all table/view snapshots through one D1 batch and keeps every active, archived, failed, cancelled, and soft-deleted database row.
- `reference_targets` is included in that same table-snapshot batch and does not create blob occurrences.
- Physical blobs are deduplicated by provider locator and downloaded at most once.
- Final outcomes include packaged, missing, provider unavailable, metadata not ready, download failed, size mismatch, and hash mismatch.
- One failed blob does not abort unrelated entries. The final ZIP always contains `export-manifest.json` and `export-warnings.json` when browser ZIP creation itself succeeds.
- Export download URLs are authenticated application routes and are not written into the final archive.

## Platform limits

- Bulk inserts keep each statement below D1's 100-bound-parameter limit.
- Resolver IDs are passed through `json_each(?)`; the domain batch is capped at 200 without consuming one binding per target.
- Deterministic search accepts at most 200 Unicode code points, eight tokens, and 50 returned results; it caps each type's candidate output and revalidates at most 200 candidates. Query count grows with selected target types, while source-scan row examination still grows with table size until a derived FTS5 backend is introduced.
- D1 migrations pass both host SQLite tests and Wrangler local D1/workerd verification. Resolver services remain host-tested for detailed behavior, while all nine v1 adapters, the unified middleware path, and a 200-target request also execute through the real Worker endpoint against Wrangler local D1 in Miniflare/workerd. Oversized compound `SELECT` chains are not accepted merely because host SQLite permits them.
- A confirmed import is capped at 180 steps and 180 images, uses at most five concurrent R2 writes, and divides persistence into bounded batches behind the pending-import visibility gate.
- Scheduled blob cleanup uses bounded discovery/deletion batches; a large backlog may require repeated daily runs rather than one unbounded execution.
- Full export downloads blobs sequentially but builds the ZIP in browser memory with JSZip. Missing blobs are non-fatal, but a sufficiently large valid archive can still exceed browser memory or Blob limits. A streaming/server-side or desktop export path is a later scalability slice.
- The first deduplication implementation checks metadata and GC claim state but does not perform provider `HEAD`/`stat` before every reuse. Missing-provider self-healing is deferred to storage-integrity maintenance.

See [the blob lifecycle contract](./BLOB_LIFECYCLE_CONTRACT.md) for normative blob rules, [blob lifecycle activation and operations](./BLOB_LIFECYCLE_OPERATIONS.md) for monitoring and incident handling, and [reference registry and batch resolver implementation plan](./REFERENCE_RESOLUTION_IMPLEMENTATION_PLAN.md) for the current reference boundary.

See [deterministic reference search implementation plan](./REFERENCE_SEARCH_IMPLEMENTATION_PLAN.md) for the Phase 2C search, portability, and future FTS5 boundary.
