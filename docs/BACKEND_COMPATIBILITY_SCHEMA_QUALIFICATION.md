# Inactive compatibility schema qualification

These fixtures qualify the proposed Stage B expansion (S0 → S1) and Stage D
contraction (S1 → S2) against the existing 37-file migration chain. They are
outside `migrations/`, are not deployment inputs, and grant no migration execution
authorization. The existing verification-scripts gate runs these checks; no
deployment, database configuration or active migration is changed.

Run the local host SQLite and actual Miniflare/workerd D1 checks with:

```sh
node --test scripts/backend-compatibility-schema.test.mjs
```

## Candidate behavior and dependency inventory

`scripts/fixtures/backend-schema/s1-compatibility-bridge.sql` rebuilds
`run_step_comments`, retaining all 18 original stored columns and values. It gives
the existing `body` column a default of `''` and adds nullable `legacy_body`.
Only rows with `submission_id IS NULL` are backfilled from their stored `body`;
canonical occurrences retain their original duplicate text and receive a null
`legacy_body`. The copy precedes guard recreation, so preserved historical rows
are not subjected to fresh attachment-ingestion checks.

The source schema inventory contains eight explicit indexes and six triggers
owned by `run_step_comments`. Their original SQL and relative creation order are
retained. There are no incoming foreign keys and no additional externally owned
trigger or index dependencies on this table in the current chain. The complete
transitive view dependency order is:

1. `blob_retention_edges_r2_occurrences`
2. `blob_retention_edges`
3. `fabublox_recovery_public_asset_edges_external`
4. `fabublox_recovery_public_asset_edges`

The candidate drops these views in reverse order and recreates them in dependency
order. It copies to a new table, drops the old table, then renames the replacement;
it does not rename the original table and accidentally retarget stored references.
An assertion compares all 18 original columns in both directions before swapping.
The test compares every retained row and stored schema object, allowing only the
listed changes and rejecting leftover replacement or assertion tables.

The only additional S1 trigger backfills `legacy_body` after an old-style legacy
INSERT. Explicit dual-field or `legacy_body`-only writes are preserved, including
empty strings; canonical INSERTs are never backfilled. This is an INSERT bridge,
not a general synchronization of two editable text owners.

`scripts/fixtures/backend-schema/s2-final-schema.sql` checks the S1 ownership
invariant, removes the bridge, drops `run_step_comments.body` and
`samples.process_revision`, and installs INSERT/UPDATE guards. A legacy occurrence
must have non-null `legacy_body`; a canonical occurrence must have null
`legacy_body`. Empty legacy strings remain valid. The retired sample column has no
other stored schema dependency in the qualified source chain. All other objects
and all retained values remain unchanged.

## Worker prerequisite and qualification evidence

The uncorrected Stage A Worker is **not** safe to serve S1: D1 includes trigger
UPDATEs in `meta.changes`, causing the old legacy-create ACK to return 409 after
the new occurrence rows have committed. A permanent real D1 probe demonstrates
two inserted IDs, two bridge updates and `meta.changes = 4`.

The independent B4 correctness fix changes that ACK to use the exact generated ID
set returned by `INSERT ... RETURNING id`. An actual empty result preserves the
write-guard conflict; malformed acknowledgements report an uncertain server error.
This qualification requires Stage A plus B4. It bundles and runs that Worker both
against host SQLite and inside real Miniflare/workerd with a D1 binding. It covers
canonical, legacy and empty text reads, individual/common legacy creates,
canonical create/finalize, identity-preserving repeated finalize, and occurrence
delete/restore after S1.

Retained snapshots include legacy/common/canonical occurrences, independently
deleted image metadata, partially deleted groups, empty canonical text, failed
submission retry metadata and a nonzero retired sample counter. The full rows,
identities and events are preserved. Raw INSERT tests separately qualify old,
dual-field and contracted writer column lists; they do not certify a complete C
Worker or permit mixed serving versions after C begins legacy-only writes.

Actual D1 migration qualification follows the repository's existing smoke method:
Wrangler's SQL splitter prepares statements, and one D1 `batch` contains the whole
candidate and its migration ledger INSERT. Forced failures during copy, after
swap, after object recreation, after each column contraction, and after the ledger
write restore the complete schema, rows, ledger and `sqlite_sequence` values.
Each failed candidate is retried successfully with the same SQL. Host execution
uses SQLite transactions and executes the complete SQL text, avoiding a false
comparison from preparing only the first statement of a splitter chunk.

Both engines retain foreign key enforcement and pass `foreign_key_check` and
`quick_check`. Host SQLite also passes `integrity_check`. The installed real D1
authorizer rejects `PRAGMA integrity_check`, so that unsupported check is not
claimed as D1 evidence. D1's protected `_cf_METADATA` platform object is excluded
from data snapshot reads; application schema, data and the migration ledger are
fully compared.

## Remaining activation gates

The integrated qualification passed all 11 ordinary verification leaves:
71 verification-script tests, 1105 source tests and 467 mounted tests, including
the actual source and production-artifact D1 smoke. These ordinary application
gates still exercise the active S0 schema. The additional schema tests explicitly
exercise S1/S2 in disposable databases; they do not relabel the whole application
suite as final-S2 acceptance.

`worker/export-v8-restore-matrix.test.ts` adds 22 actual API/ZIP/recovery cases.
V8 sources S0, S1, S1 with contracted-write placeholders, and S2 each target all
three physical schemas. Original v7 archives also target all three. Complete
rows, provider bytes, original archive bytes and provenance are compared. S2
sources reject older targets with unavailable retired values; S1 contracted
legacy placeholders reject S0 when original `body` and readable legacy text
cannot both be preserved. Target-schema mismatch and corrupt/missing provenance
remove the new destination without changing the source archive. Rehashed source
SQL remains inert evidence and is never used to construct the destination.

The [baseline qualification](./BACKEND_MIGRATION_BASELINE_DESIGN.md#inactive-final-baseline-qualification)
compares this incremental S2 result with a generated fresh schema on both engines,
including retained data and independent migration ledgers.

These local candidates remain inactive. Remote Stage B still requires the accepted
E recovery/export support and retirement of incompatible serving versions. Stage C
requires its own full Worker qualification on S1/S2 and retirement of old readers
before contracted writes begin. Stage D requires verified immutable S1 recovery
evidence, complete archive/retired-field preservation, the restore matrix and
drain/rollback barriers. The separately qualified S2 fresh baseline must match this
incremental S2 schema; it does not replace or reset the existing migration ledger.
Local fixture success is neither evidence that these remote gates have been met
nor permission to apply B, C or D remotely.
