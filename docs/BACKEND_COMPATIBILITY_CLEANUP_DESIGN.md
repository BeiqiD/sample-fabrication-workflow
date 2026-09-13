# Compatibility-field cleanup by separate deployment bridges

Status: independently reviewed Phase 6A4 implementation sequence. Stage A is
merged in PR #194; E/B/C/D remain separate implementation and
deployment gates. This document changes no migration, provider binding or
deployed schema.

Reviewed: 2026-09-13 against the 37-file schema and routes at integration
`5787b32e202ac3fa2c55eb0b2c90e3b910e54d70`. Re-inventory the final implementation
head before generating SQL. The [stabilization plan](./V3_ARCHITECTURE_STABILIZATION_PLAN.md)
and [baseline planning design](./BACKEND_MIGRATION_BASELINE_DESIGN.md) retain the
existing migration/deployment/recovery gates.

## Stage A implementation evidence

Local commit `2a2e69d38dc21f3fdcb99ebaf62fea43f5915625`, based on
`4553b3e`, implements the read bridge without a schema or writer change. It is
replayed onto the completed ownership extractions. The integrated implementation
merged as [PR #194](https://github.com/BeiqiD/sample-fabrication-workflow/pull/194),
commit `2ffd3d8f88cdb6fda2cfc868d164f9613f25cc21`, tree
`224b771f38e25a0d275508df0cb05937b2622446`, after all 11 local leaves and
4 Verify / 14 commit contexts passed. Deployed-browser acceptance remains pending.

- Sample occurrence reads select canonical text by `submission_id`; only a
  legacy occurrence reads its own original `body`.
- Reference occurrence resolution uses the same ownership rule. A missing
  canonical submission is `inconsistent` and never revives duplicated text.
- Six legacy lifecycle target projections use canonical text in Comment/image
  deletion and restoration summaries. Their visibility guards, binding order,
  transaction writes, IDs and metadata are unchanged.
- Schema 7 exports retain the original 17 Sample columns and 18 occurrence
  columns, actual counters and original stored duplicate text. Explicit SQL
  projections stay in the existing complete D1 snapshot batch. This is not
  archive conversion or permission to enable future placeholder writes.
- Independent review passed. Nine actual Worker/SQLite cases cover canonical
  versus legacy text, empty canonical strings, broken canonical ownership,
  search deduplication, both lifecycle scopes, image deletion and exact v7
  stored rows/columns. Eight related files passed 77 tests; Worker and export
  contract type checks passed.

Stage A can deploy with the existing schema and writer. E must still implement
and qualify the negotiated v8 browser/archive/recovery protocol before B's
schema or canonical-placeholder behavior is enabled.

## Required final state

- Remove `samples.process_revision` from the operational schema; preserve actual
  retired values in immutable recovery evidence instead of synthesizing zero.
- Remove `run_step_comments.body`. Canonical text remains only in
  `comment_submissions.body`; an occurrence with a submission ID does not store
  another authoritative-looking copy.
- Keep legacy text as `run_step_comments.legacy_body`, populated only when
  `submission_id IS NULL`. Keep every existing occurrence ID, group, attachment,
  author/timestamp and deletion/mutation provenance unchanged.
- Preserve public Comment/Reference/lifecycle behavior. Do not manufacture
  submissions for legacy occurrences, change their `submissionId`, redirect the
  UI into canonical deletion, or merge occurrence identities.
- Version the changed complete-export contract and provide an explicit v7 archive
  conversion path while retaining the original archive byte-for-byte.

## Why a single drop migration is unsafe

`run_step_comments.body` is currently `TEXT NOT NULL` without a default.
Canonical finalization and legacy creation explicitly insert it. A new writer
cannot simply omit the column before contraction, and the current writer cannot
continue after the column is dropped.

The deployment command applies migrations before replacing the Worker. The
Worker already serving requests at that point must therefore work on the schema
both before and after the next migration. Merging new code alongside DROP does
not meet that requirement. Separate releases must establish compatible reads,
then compatible writes, before the final column removal.

The same principle applies to archives. The current `/exports/all` handler uses
`SELECT *` for both tables under schema 7, and the existing browser ZIP writer
copies `schemaVersion` without validating it while omitting unknown top-level
metadata. Returning v8 to that writer could create an archive labelled v8 without
its required provenance. Version negotiation and explicit serialization therefore
precede any changed text-writing behavior; simply changing the manifest number
is insufficient.

## Proposed PR sequence

Each row is independently reviewed and deployed before its successor is
admitted. A successful source build alone does not prove its prerequisite Worker
has reached the serving deployment or that earlier requests have finished.

| PR | Schema work | Worker/archive work and compatibility |
| --- | --- | --- |
| A: canonical read bridge | None | Every canonical read obtains `cs.body`; legacy reads still use `rsc.body`. Keep the live export at v7. Use explicit v7 SQL column projections for the two affected tables so later added columns cannot leak into the old shape. Existing writers retain their current columns. |
| E: negotiated export upgrade | None | Add explicitly requested v8 plus a new browser writer that validates and packages its complete metadata. Unversioned/unsupported requests return an error with no manifest. During rollout, A can still return valid v7 to an old browser because the physical schema and writers have not changed; the new writer rejects A's v7 response to a v8 request. E rollout and request drain are prerequisites to B. |
| B: additive/default bridge | Rebuild only `run_step_comments`, retaining all 18 existing columns, changing `body` to `TEXT NOT NULL DEFAULT ''`, and adding nullable `legacy_body`. Backfill legacy text; install temporary old-legacy-write synchronization. | New reads use `legacy_body` for legacy occurrences. Canonical insertion omits `body` and `legacy_body`; the compatibility column receives an empty placeholder. Legacy insertion temporarily supplies both equal body columns, so E's legacy readers remain correct during the overlap. E's canonical readers already use `cs.body`; pre-A Workers must be excluded before B writes placeholders. |
| C: contraction-compatible writer | None | Legacy insertion writes `legacy_body` only. Normal reads and mutation SQL stop referencing `run_step_comments.body` or `samples.process_revision`. Export keeps a generic raw-row snapshot internally, then serializes the fixed v8 shape and any actually present retired fields; it has no SQL dependency on the removed columns. B's readers already consume `legacy_body`. E/A Workers must be excluded before C's first legacy-only write. |
| D: actual cleanup | Remove temporary body synchronization triggers; verify final data conditions; drop `run_step_comments.body` and `samples.process_revision`; install the final legacy/canonical text guard. | C already supports the contracted schema, including before D's Worker deploy. Preserve original recovery artifacts and disallow rollback to Workers older than C. Qualify both upgraded and baseline-created schema paths. |

E is a separate reviewed PR between A and B, not a parallel schema track. Only
one live archive version is supported after E completes: explicit v8. Existing v7
archives remain supported by offline conversion, not an indefinitely maintained
live v7 export path.

E and B's serializers publish the same v8 logical rows although their physical
legacy-text source differs. C's export takes `SELECT *` rows only as internal
input: it emits approved fields explicitly and captures retired fields only when
the row actually contains them. Before D this preserves nonzero counters and
actual compatibility-body placeholders; after D absence is recorded as absence.
It never substitutes a counter or body merely because an optional property is
missing. This permits one C Worker to serve both schemas without SQL that names
a removed column, schema-cache races, or mutation retries after a schema error.

### Negotiation and old browser behavior

The proposed request is `/exports/all?archiveSchema=8&archiveWriter=1`. E accepts
only this supported pair; no query, duplicate/unknown values, or unsupported
versions receive `409` with a clear refresh/update message and no manifest.
The existing `request()` rejects non-2xx responses before its old ZIP writer
runs, so an already-open old browser reports an error rather than downloading a
mislabelled archive. No old-writer capability is inferred from authentication or
a shared browser session.

The new browser writer must reject a response whose archive version or required
provenance descriptors differ from the requested protocol before fetching blobs
or generating a ZIP. This also covers a new client reaching A during E's rollout:
A ignores the query and returns v7; the new writer rejects it. The new writer
explicitly packages the v8 provenance/retired-field files, records their names,
counts and hashes in the ZIP manifest, and verifies the completed ZIP inventory.
Do not route v8 data through the old writer or rely on it preserving unknown
response properties. This behavior changes only the export protocol, not normal
Comment UI, source navigation or deletion dispatch.

### Rollout, drain and rollback barriers

| Before advancing | Required serving-version and request evidence | Oldest allowed rollback once the next behavior starts |
| --- | --- | --- |
| A to E | No schema or text-write change; old and new export requests are exercised during overlap | A until B starts; v8 clients reject A safely |
| E to B, before the first canonical placeholder | E is the sole eligible serving version; all pre-E requests/exports and especially pre-A body readers have completed or been terminated under a verified bound | E; returning to A/pre-A would reintroduce v7 export or stale canonical-body reads |
| B to C, before the first legacy-only write | B is serving and all E/A requests that read legacy `body` have completed; B/C overlap is tested | B; E/A would read empty compatibility body for C-created legacy notes |
| C to D, before DROP | C is serving and all B-or-older body-dependent writers have completed; the exact C build passes the contracted-schema gate | C; pre-C writers cannot run after DROP |

Record exact deployment/version IDs, traffic allocation, completion of requests
from disallowed versions, the new data-mode boundary and the supported rollback
floor. A code merge, successful health response, or arbitrary waiting period is
not a drain proof. The executor/operations review must establish a verifiable
completion signal or documented upper bound for earlier request lifetimes. If
that cannot be established, retain the compatible writer and do not enable the
next behavior. This requirement applies to B and C as well as final D.

A later executor must enforce these predecessor/schema pairs together with
source hashes and recovery evidence. No remote reset or manual data cutover is
part of this design.

## Read and write conversion boundaries

Canonical body selection should express ownership explicitly:

```sql
CASE WHEN rsc.submission_id IS NULL
     THEN rsc.legacy_body
     ELSE cs.body
END AS body
```

A uses the same expression with `rsc.body` in the legacy branch, because the new
column does not exist yet. Preserve the existing source visibility, status,
authorization and whole-group guards. An empty canonical string remains an empty
canonical string; a missing canonical submission is an integrity problem rather
than permission to fall back to stale duplicate text.

Current required readers include Sample detail, legacy lifecycle summary text,
Reference occurrence resolution and legacy search. After the ownership extractions they
are in `worker/samples/routes.ts`, `worker/evidence/legacy-routes.ts`,
`worker/references/adapters.ts` and `worker/references/search.ts`. Complete export
is owned by `worker/export-routes.ts` and `worker/export-catalog.ts`.

Current writers are legacy `/run-step-comments` creation in `worker/evidence/legacy-routes.ts`
and canonical finalization in `worker/comment-submission-routes.ts`. Preserve
binding order, D1 batch atomicity, generated occurrence IDs, common-group guards,
step/sample updates and exact-request settlement checks. The temporary default
exists solely to allow those SQL column lists to change without dropping the
column first; it is not another canonical text store.

`src/components/MultiSampleRunGrid.tsx` currently selects legacy Comment/image
deletion when `submissionId` is absent. This remains unchanged. Source deep links,
Reference IDs and canonical-versus-legacy readable context must also remain
unchanged.

During B, temporary synchronization has a narrow purpose:

- after an old-writer legacy INSERT with `legacy_body IS NULL`, copy its provided
  `body` into `legacy_body`;
- if an admitted old-writer legacy body UPDATE exists, mirror only that change
  into `legacy_body`; never overwrite an explicitly supplied new legacy body
  merely because the compatibility column defaulted to empty;
- never copy canonical text into `legacy_body`, generate a submission, advance
  business timestamps/revisions or create timeline events.

The exact trigger conditions must be covered against both old and new column
lists. Do not add a BEFORE INSERT non-null legacy-body guard until old-writer
support is removed: an AFTER INSERT bridge cannot satisfy an earlier guard.
D's final guard can reject `submission_id IS NULL AND legacy_body IS NULL`, and
reject a non-null legacy body on canonical occurrences. It must permit empty
legacy text for image-only comments where that existing behavior is valid.

## Actual intermediate rebuild scope

The current table has 18 columns. Its outgoing foreign keys target `run_steps`,
`assets` and `comment_submissions`. No current table has an incoming foreign key
to `run_step_comments`. This last fact must be rechecked at the implementation
head; it makes a narrowly scoped rebuild possible without a child-table rewrite.

The rebuild must preserve all current column definitions, IDs and values, adding
only the approved default and legacy column. Create a new temporary table,
copy rows with an explicit 18-column list plus
`CASE WHEN submission_id IS NULL THEN body ELSE NULL END`, and compare copied
values before swapping. Do not rename the old table first: SQLite can retarget
dependent definitions to that temporary old name.

Owned explicit indexes to recreate unchanged:

- `run_step_comments_step_created_idx`
- `run_step_comments_operation_group_idx`
- `run_step_comments_asset_idx`
- `run_step_comments_submission_idx`
- `run_step_comments_visible_step_created_idx`
- `run_step_comments_visible_asset_idx`
- `run_step_comments_deletion_operation_idx`
- `run_step_comments_asset_deletion_operation_idx`

Owned triggers to recreate unchanged before committing the schema transaction:

- `run_step_comments_block_physical_delete`
- `run_step_comments_guard_blob_insert`
- `run_step_comments_guard_integrity_insert`
- `run_step_comments_guard_integrity_update`
- `run_step_comments_guard_publication_insert`
- `run_step_comments_guard_publication_update`

The primary-key automatic index is recreated by the table constraint. Do not
replace any of these guards with newly simplified application checks. Row copy
must preserve valid historical/unavailable/quarantined states; replaying ordinary
new-attachment insertion guards on every copied historical row is not equivalent
to preserving an already stored occurrence.

The dependent view closure at this head, in recreation order, is:

1. `blob_retention_edges_r2_occurrences`
2. `blob_retention_edges`
3. `fabublox_recovery_public_asset_edges_external`
4. `fabublox_recovery_public_asset_edges`

Temporarily drop those views in reverse order inside the same migration
transaction, then recreate their reviewed SQL after restoring the table and
owned objects. Dropping only the leaf leaves broken parent definitions that can
make SQLite reject a later ALTER operation. Re-inventory transitive dependencies,
including triggers owned by other tables, before preparing final SQL.

The table swap is a transactional schema operation, not permission to expose
ordinary physical Comment deletion. No view, guard or temporary table may be
left missing/active between successful migration boundaries. Prove rollback for
a fault injected during copy, swap and object recreation under actual local
D1/workerd, not only host SQLite.

At this head neither removed column appears in another stored view/index/trigger
SQL definition. Host SQLite accepts direct DROP COLUMN after the bridge without
another table rebuild. Verify that exact final SQL on local D1. If it does not
work, stop for a revised design; do not silently widen the migration to rebuild
`samples`, which has substantial incoming relationships.

## Export versioning, restore targets and retained values

V8 has one documented logical table shape: `samples` omits operational
`process_revision`; `run_step_comments` has `legacy_body` and no `body`. Other
business fields and the complete single-D1-batch snapshot boundary remain intact.
Internal SQL may read complete physical rows, but the API/ZIP serializers must
not pass them through directly.

The concrete v8 envelope must include a versioned `retiredFields` descriptor and
artifact, with at least:

- a conversion/provenance version and original v7 archive hash when applicable;
- actual `process_revision` values keyed by Sample ID, with exact coverage counts;
- actual former `run_step_comments.body` values keyed by occurrence ID, including
  empty placeholders, with exact coverage counts;
- explicit completeness/absence flags per field family; an empty map means
  complete only if there are no corresponding rows, never simply because the
source schema omitted the field;
- the physical source schema identity and hashes/counts of every retained artifact.

Observe source schema identity within the export snapshot; do not infer it from
the serving Worker build. E can briefly serve the expanded S1 database during
B's migration-before-deploy window, and C serves both S1 and S2. A fixed
schema-information query in the export batch can record that identity without
making mutation behavior depend on a cached schema probe.

E captures both retired field families from S0 raw rows. B/C capture them from
S1 raw rows; the raw `body` value may legitimately be the compatibility placeholder
while `legacy_body` or canonical `cs.body` holds display text. C running after D
exports S2 rows and declares unavailable retired families incomplete rather than
inventing values. Logical data and the retired values must come from the same
snapshot; a separate stale export cannot fill missing per-row coverage.

### Explicit archive-to-physical-schema restore matrix

Target schemas are S0 (A/E, original 18-column occurrence table with required
`body`), S1 (B/C, old `body` with default plus `legacy_body`), and S2 (D/final,
`legacy_body` only and no `process_revision`). The target is an explicit operator
choice validated against a reviewed schema fingerprint, never guessed from the
archive filename. Restoration occurs in a separate destination.

| Input archive | S0 target | S1 target | S2 target |
| --- | --- | --- | --- |
| Original valid v7 | Restore its original physical fields exactly | Copy original fields exactly, plus `legacy_body = body` only for legacy occurrences | Convert to v8 logical rows; retain removed values and original archive as provenance |
| V8 with complete, same-snapshot retired fields (E, B/C before D, or converted v7) | Only if the legacy-body equality condition below passes: reinsert recorded `process_revision` and occurrence `body` explicitly; omit `legacy_body`. No defaults; target runtime must have A/E-compatible canonical reads. | Reinsert recorded `process_revision`, recorded compatibility `body` and logical `legacy_body` explicitly. Do not let the default mask missing values. | Restore the logical v8 rows; retain retired fields as recovery provenance, not active columns |
| V8 without complete retired fields (normally after D) | Reject before any write | Reject before any write | Restore logical rows and retain the declared absent-field provenance |

There is a further S0 compatibility condition: for every legacy occurrence, the
recorded physical `body` must equal logical `legacy_body`. A C-created legacy row
can have recorded `body = ''` and nonempty `legacy_body`. Such an archive **cannot
be restored to S0** while preserving both its exact stored values and readable
legacy text, even if all retired metadata exists. Reject S0 for that case and
restore to S1 or S2. Do not silently replace the recorded value, and do not claim
that archive restoration makes E/A a valid live rollback after C. Canonical
placeholder bodies are safe only for target runtimes with A's canonical reader;
restoring to a pre-A Worker is outside the supported matrix.

For S0/S1, validate complete unique ID coverage, numeric counter types and exact
body strings before allocating/importing rows. Missing retired values never use
SQL defaults, including the existing Sample default zero or the bridge body
default. For S2, absence of retired values does not mean lost operational text:
legacy text is required in the logical rows and canonical text is required in
`comment_submissions`. Missing required operational text remains an error.

A v7-to-v8 conversion must validate the complete table/blob inventory, retain the
input archive byte-for-byte and record its hash, map the legacy text without
changing IDs or groups, and retain actual retired values in the artifact above.
It writes a new v8 artifact and conversion report. Missing canonical rows,
malformed legacy data or unexplained canonical-body disagreement are reported
for review rather than silently repaired. Before B introduces placeholders,
audit existing canonical duplicate differences so intentional bridge placeholders
can be distinguished from pre-existing divergent text.

Before D, retain an immutable precleanup S1 backup with complete actual retired
fields, a successfully inspected v8 ZIP, schema/build identity and applicable
recovery metadata. C's raw snapshot plus explicit retired-fields serializer can
provide this before DROP; after DROP it intentionally cannot recreate absent
values. Keep this backup, original older v7 archives and converted artifacts
separately. Recovery never overwrites the original archive or silently carries
zero-valued counters into an old target.

No public restore/import endpoint or data-overwriting UI is introduced here.
The converter and target-specific recovery adapter can remain operator/local
tools until a separate product decision defines such an endpoint.

## Required verification matrix

Use retained-data fixtures containing canonical and legacy individual/common
comments, image-only text, deleted sources and ancestors, partial group deletion,
independent image deletion, pending/retry state, shared/quarantined blobs, and
nonzero retired Sample counters.

For each A/E/B/C/D transition, test both the previously deployed Worker and the
new Worker against the post-migration schema. Exercise reads, canonical finalize,
legacy create, Comment/image delete and restore, Source focus/Reference search,
full export and uncertain-response retry settlement. Assert IDs, body text,
status codes, revisions, timestamps and atomic failure behavior. Include
simultaneous old/new writer column lists during B/C and verify compatibility
triggers do not erase new legacy text.

Rebuild and contraction must separately pass:

- copied original-row equality and legacy backfill conditions;
- full normalized schema comparison, including the eight indexes, six original
  triggers, four dependent views and intentional new bridge/final guards;
- foreign-key/integrity checks and rollback/resumption fault cases;
- actual local D1/workerd migrations and representative Worker transactions;
- old unversioned browser against E/B/C/D: non-2xx rejection before ZIP creation;
- new v8 browser against A: version mismatch rejection before blob fetch/ZIP;
- new v8 browser against E/B/C/D: inspect the ZIP itself for required provenance,
  exact artifact hashes/counts and logical/retired-field coverage;
- every permitted and rejected cell in the restore matrix, including nonzero
  counters, missing sidecars, placeholder canonical body, C legacy-only rows,
  empty tables and S2 archives with intentionally absent retired fields;
- pre-A in-flight readers held across B, E/A readers held across C, and B writers
  held across D: the corresponding barrier must prevent activation until settled;
- v7 conversion and v8 recovery with immutable original archive/provenance;
- existing required complete verification and final baseline equivalence gates.

A limited host-SQLite feasibility probe has been run in memory only: it applied
the current 37 files, loaded the reference fixture plus one legacy row, rebuilt
the table with the empty-string default and legacy column, recreated the listed
objects and directly dropped both final columns. All three original occurrence
rows were preserved during expansion; legacy text survived contraction;
`integrity_check` and `foreign_key_check` passed. This establishes basic DDL
feasibility, not D1 migration atomicity, old/new Worker compatibility, recovery
acceptance or remote deployment readiness. Production SQL and schemas remain
unchanged by this design work.
