# Backend migration planning before baseline replacement

Status: pure planning, read-only observation and isolated local Wrangler
qualification for Phase 6A5; not an activated baseline, deployment change,
completed cleanup, or authorization to migrate remote resources.

Reviewed: 2026-09-13. Implementation starts from integration commit
`5787b32e202ac3fa2c55eb0b2c90e3b910e54d70`.

The [stabilization plan](./V3_ARCHITECTURE_STABILIZATION_PLAN.md) keeps compatibility
cleanup and clean-baseline activation after backend correctness and ownership
work. This design prepares a fail-closed planning boundary without changing that
order or the current [deployment gates](./DEPLOYMENT.md).

## Current deployment hazard

`package.json` currently runs verification, then the internal remote migration
command, then Worker deployment. `scripts/generate-wrangler-config.mjs` assigns
`migrations/` to Wrangler's `migrations_dir` for every database.

The current directory has 37 SQL files, including two distinct `0015_*` files.
Wrangler 4.112.0 in the reviewed local environment identifies applied migrations
by their complete filename in `d1_migrations`; its ledger does not store SQL
hashes. Replacing the directory with a newly named full baseline would therefore
present that baseline as unapplied to an existing database. It must not be
merged into the current automatic apply path without an independently reviewed
selection and execution mechanism.

Also, Wrangler's `d1 migrations list` initializes its ledger table. A future
strictly read-only observer must use schema/ledger queries instead of treating
that command as a side-effect-free probe.

## Implemented boundary

`scripts/d1-migration-plan.mjs` is an importable pure planner. It imports only
Node's hash implementation. It does not read files, open a database, launch
Wrangler, generate configuration, apply SQL, contact remote resources, modify a
ledger, or authorize deployment. No package script or deployment entry point
calls it in this prerequisite slice.

The public entry point is:

```js
planD1Migrations({ catalog, sourceFiles, target })
```

The three inputs have separate provenance:

- `catalog` is a reviewed version-1 inventory. Each source has `filename`,
  `sha256`, and `kind` (`historical`, `baseline`, or `incremental`). Each lineage
  has an ID, kind (`legacy` or `baseline`), ordered migration filenames and
  `supportedStates` containing an applied-file count and independently obtained
  expected schema. `freshLineage` identifies the one baseline lineage intended
  for empty databases.
- `sourceFiles` supplies exact UTF-8 SQL text alongside each catalogued filename.
  Its hashes must match the catalog. Missing, extra, duplicate or changed files
  reject the whole proposal; caller-supplied target observations cannot replace
  the reviewed catalog or source hashes.
- `target` contains the observed schema plus explicit ledger existence and
  ledger rows in ascending ID order. Names must match an admitted lineage prefix
  exactly. The observation must include the ledger table when its existence is
  asserted. The [read-only D1 observer](./BACKEND_MIGRATION_OBSERVATION.md) now obtains
  this input from a supplied D1 binding and is qualified on local workerd. Remote
  transport and execution integration remain outside this slice.

Each legacy lineage excludes baseline SQL. A baseline lineage contains exactly
one baseline followed only by incremental SQL. Every admitted lineage has an
expected final schema. Every boundary reachable after an admitted prefix must
also have an expected schema, so an interrupted sequence can be classified on
retry without guessing that missing migrations ran. An older, otherwise plausible
prefix is rejected unless the catalog explicitly supports it.

The result contains classification, lineage ID, observed and final schema
fingerprints, observed migration names and the remaining ordered filenames with
hashes. It always has `kind: "read-only-migration-proposal"` and
`executionAuthorized: false`. It supplies no shell command and no permission to
run one. Rejection throws without returning an executable partial plan.

| Observation | Proposal |
| --- | --- |
| No application objects; ledger absent or empty | Baseline lineage and its later increments |
| Complete current 37-file ledger with matching schema | Remaining reviewed legacy suffix; no-op if that catalog ends at S0 |
| Explicitly supported historical/cleanup prefix with matching schema | Remaining legacy/incremental suffix only |
| Known baseline prefix with matching schema | Remaining baseline-lineage increments only |
| Unknown, mixed, duplicate, misordered, gapped, ambiguous or unsupported ledger | Reject |
| Empty ledger with existing application table, view, index or trigger | Reject |
| Ledger/schema disagreement or changed schema structure | Reject |

A legacy and baseline database intentionally keep different ledger histories.
The mechanism never inserts a fake baseline ledger row, renames historical
entries, clears the ledger or treats a matching maximum numeric prefix as proof.

## Schema observation and normalization

The planner requires all `sqlite_schema` table/view/index/trigger objects,
including their SQL and owning table, plus metadata for every table and view:

- complete `table_xinfo` columns, including defaults, primary-key order and
  generated/hidden-column flags;
- `foreign_key_list` rows, including composite ordering, targets and actions;
- `index_list` properties and complete `index_xinfo` columns, including expression
  markers, sort direction, collation, key membership and partial-index status.

Object and metadata order is normalized. SQL is tokenized to ignore SQLite ASCII whitespace
and comments outside quoted tokens while preserving quoted strings/identifiers
exactly. Non-ASCII identifier adjacency and adjacent blob literals remain distinct
from separate aliases. It deliberately does not attempt general SQL semantic equivalence;
other harmless rewrites can require a reviewed expected observation rather than
being silently accepted. Expected observations can therefore be specific to a
lineage even when separate baseline-equivalence verification proves two final
schemas behave identically.

Only the explicit platform tables `d1_migrations`, `_cf_KV` and `_cf_METADATA`, their admitted indexes,
`sqlite_sequence` and SQLite's named statistics tables are excluded from the
application fingerprint. Application triggers on platform tables are retained. The two protected `_cf_`
tables must match the engine definitions qualified in the observer; only their
inaccessible relation metadata may be absent. Unknown definitions or attached
indexes reject rather than disappearing from the application fingerprint.
Other underscore-prefixed application objects are never ignored. Automatic
indexes remain represented through schema objects and index metadata; WITHOUT
ROWID primary-key metadata is retained even when SQLite has no separate schema
object for that index.

A fingerprint protects observed schema structure, not business row contents or
past execution provenance. Repository source hashes do not prove which historic
SQL bytes were run remotely. The observer must provide complete, consistent
results; catalog validation cannot recover observations omitted by a defective
adapter. Data invariants and restore validation remain separate gates.

## Proposed later integration slices

1. Qualify independent catalog generation and a local D1 read-only observer.
   Compare host SQLite and actual Wrangler/workerd observations. Add any
   intentional engine differences explicitly; do not weaken the fingerprint
   until mismatches are understood.
2. Preserve historic SQL byte-for-byte outside the default scan directory.
   Generate migration-only staging directories/configuration from an accepted
   proposal. Historical targets receive their original filenames and authorized
   increments; fresh targets receive baseline and subsequent increments. Keep
   runtime database/provider bindings unchanged.
3. Add an execution wrapper only after review. Verify exact source hashes and
   target state again before applying; serialize competing deploy attempts,
   capture required recovery evidence and check each resulting schema/ledger
   state. Stop Worker deployment on any rejection or migration/postcheck failure.
   D1's per-file failure behavior and restart handling require direct local
   integration tests before enabling that path.
4. Qualify a clean baseline against both an empty database and a retained-data
   copy upgraded by the historical path. Compare schema objects, constraints,
   stable identities, normalized rows, references, deletion/revision/retry state,
   export coverage and available blob outcomes/hashes. Run the complete required
   Worker, frontend and production-build gates against the baseline-created DB.
5. Review deployment documentation and remote eligibility separately. No remote
   reset, resource recreation, ledger rewrite or cutover is introduced by this
   proposal. Enabling an executor remains subject to the existing exact-head,
   recovery and deployment requirements.

The pure planner does not execute these slices. The subsequent
[isolated local staging qualification](./BACKEND_LOCAL_MIGRATION_STAGING.md) now
implements selection, private staging, preflight re-observation and actual
installed Wrangler local apply for new fixtures, including failure/retry tests.
Remote admission, deployment serialization and remote execution remain pending.
The current `migrations/` directory and automatic deployment command remain
unchanged.

## Inactive final baseline qualification

The executable candidates now live in `scripts/fixtures/backend-schema/`, outside
Wrangler's active migration scan. The S1/S2 schema qualification and generated
`s2-baseline.sql` run in the existing verification-scripts gate. Reproduce them with:

```sh
node --test scripts/backend-compatibility-schema.test.mjs scripts/backend-schema-baseline.test.mjs
node scripts/generate-backend-s2-baseline.mjs --check
```

Host SQLite and actual workerd D1 prove that incremental S2 and a fresh candidate
have the same 34 tables, 93 explicit indexes, 15 views, 200 triggers and 20 exact
built-in seed rows. The normalized application schema SHA-256 is
`71e082ee9bbf00f8844c5580bbc81c8dec3894025fc0d17b88584a8ce984c4b2`.
All original trigger definitions and their relative creation order within each
table remain intact; the fresh baseline follows final S2 creation order.

The retained-data rehearsal compares every stored row, allowing only the two
retired column removals and the explicit legacy text projection. It covers
canonical/common/legacy and image-only occurrences, partial deletion, ancestor
trash, pending retry, shared quarantine, and original retired counters of 37 and
9007199254740000. Retained ledgers extend from 37 to 39 entries with the original
37 rows unchanged; the separate fresh ledger contains one candidate entry. The
planner never selects baseline SQL for the retained S0 target.

Both engines pass foreign-key and quick checks; host SQLite also passes
`integrity_check`, which D1's authorizer does not support. Injected failures during
copy, swap, object recreation, contraction, and ledger recording roll back fully
and allow the exact candidate to succeed on retry. A fresh-baseline failure also
leaves no application objects or applied ledger row.

The generator preserves quoted text and comments and adds only token-equivalent
spacing around compound SQL keywords for the installed Wrangler splitter. All
308 index, view and trigger definitions retain their SQL tokens. Actual Wrangler splits the
candidate into 363 statements, at most 3851 UTF-8 bytes each; it does not submit
the over-limit combined trigger statement produced by naive concatenation.

This is qualified local schema preparation. It is not a deployed baseline,
remote cleanup, retirement proof, or complete application acceptance against an
activated final schema. The remaining execution and full final-schema gates above
still apply; the active directory contains the original 37 migrations.

## Compatibility fields and schema-7 archives

The original schema-7 export preserves complete `samples` and `run_step_comments`
rows, including explicit physical-column projections introduced by Stage A.
`samples.process_revision` has no explicit runtime
reader/writer, but dropping it still changes exported row structure. Do not keep
the same archive schema number while silently removing that field, and do not
synthesize zero without proving all retained values and agreeing a lossless
compatibility policy. Versioned export/recovery conversion or a reviewed
compatibility projection is a separate prerequisite to removal.

`run_step_comments.body` is duplicate text only for canonical occurrences. It is
still the original text for legacy occurrences without a submission ID. Sample
reads, Reference fallback/search, lifecycle summaries, legacy creation and
canonical finalization still depend on it. Convert all relevant readers/writers
and preserve legacy text, stable occurrence IDs, common-group behavior,
attachments and deletion provenance before removing that column. The canonical
`comment_submissions.body` remains the authoritative text and is not a removal
candidate.

Because deployment currently migrates before replacing the Worker, destructive
column cleanup cannot rely on new code arriving in the same commit. First deploy
and accept code compatible with both schema states; only then qualify and apply
a separately reviewed contraction. A schema-equivalent baseline retaining the
compatibility columns is a possible smaller precursor, not permission to skip
the final authorized cleanup or change archive contracts.

## Local verification and limits

Run the prerequisite tests with:

```sh
node --test scripts/d1-migration-plan.test.mjs
```

The planner and observer tests cover both admitted lineages, empty and populated targets, supported
cleanup recovery, no-op repetition, ledger rejection cases, metadata and SQL
drift, quoted-content preservation, malformed observations and source hashes.
They build the current 37-file chain in memory and prove its complete ledger gets
no baseline SQL. The test-only baseline for that case concatenates the chain;
it is explicitly not a newly generated or qualified clean baseline.

The local D1 observer is qualified by the separate observation record. This
record does not claim production restore, remote database inspection, remote
apply, deployment integration, compatibility cleanup or Phase 6A5 completion.
