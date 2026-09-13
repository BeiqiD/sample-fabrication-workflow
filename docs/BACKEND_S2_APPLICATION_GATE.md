# Final S2 application gate candidate

This branch prepares the final application's complete local gate. It is not a
remote activation or retirement record. The owner now permits discarding the
integration test data: use the [direct fresh-resource cutover](./BACKEND_DISPOSABLE_S2_CUTOVER.md),
with serialized builds and paired code/resource bindings. Do not merge while
automatic builds still target the original S0 resources. It contains the already prepared C Worker, which requires S1
or S2, plus a default **new-empty-database** S2 baseline.

## Schema selection and retained history

`migrations/` contains only `0001_v3_baseline.sql`. It is byte-for-byte identical
to the reviewed `scripts/fixtures/backend-schema/s2-baseline.sql`, including its
original inactive-candidate provenance comments. The schema and exact built-in
seed rows are unchanged from that reviewed candidate.

The 37 original SQL files are archived under `migrations-history/s0/`, with
filenames and bytes unchanged. They are not included in Wrangler's default
scan. `current-schema-source.test.mjs` verifies the exclusive default filename,
exact baseline bytes, historical inventory, and all 37 recorded SHA-256 values.
The baseline generator reads those archived bytes while retaining their original
logical source names in the provenance comments. Existing-ledger planner and
S0 → S1 → S2 rollback/retry tests still execute the original historical chain.

This is deliberately not a remote executor. Existing databases whose data must be retained must use the
reviewed lineage selection and staged migration procedure; they must never
receive the new-empty-database baseline. The qualified local staging preparation is included, with only its historical
source and fixture lookups adapted to the archived physical directory. Its
private-file checks, observed planning, actual Wrangler execution, post-apply
health checks, failure handling, and result checks are unchanged. No production database, resource binding, migration ledger,
or deployed Worker was changed by this qualification.

## Current application and historical qualifications

Ordinary Worker/API fixtures and all Wrangler application smokes use the default
baseline. Canonical Comment occurrences have `legacy_body = NULL`; legacy
occurrences store their original text in `legacy_body`. The public API still
exposes `body`. Deletion, restoration, events, ownership, IDs, retry, stale-target
and byte checks retain their existing assertions. Sample description and
metrology API tests now use the current schema; metrology seeds an explicit
test template instead of depending on retired built-in templates.

Historical migration tests explicitly read the archived chain. The original
reference graph is preserved separately as `reference-graph-s0.sql`; recovery
tests retain real historical counters including 37 and 9007199254740000 and
retain original duplicate Comment values. Tests that intentionally insert a
pre-guard FabuBlox state still do so before applying the subsequent historical
repair migrations.

The historical E/B4 Worker assertions on S1 remain unchanged. A test-only
esbuild overlay reconstructs its five exact source files from reviewed patches:
C → B, then B → E. It checks the current C and reconstructed E file hashes and
does not require Git history, mutate production files, or replace API handlers.
The patches and hash manifests are the exact qualification fixtures from the
separate B preparation. Canonical read regression tests also run the current C
reader against retained S1 rows, so stale duplicated text remains an actual
stored value that the reader must not expose.

## Complete local gate

Run `npm run verify:ci`. The existing 11 leaves remain intact: verification
scripts, complete source tests, mounted frontend tests, rich-text bundle,
export type contract, actual Wrangler local migrations, Reference Worker,
Reference search Worker, frontend/Worker build, Project Map bundle, and the
production-artifact Project Worker smoke.

The verification-scripts leaf additionally includes the actual C API matrix on
S1/S2 in host SQLite and workerd D1, and the exact current/history source check.
The migration leaf runs the installed Wrangler against a fresh local database
and applies the baseline plus its ledger entry. The Reference smoke still proves
that a trigger-doubled `meta.changes` does not replace exact `RETURNING id`
settlement. The production-artifact smoke verifies actual absent-field
provenance instead of inventing retired zero values.

The full ZIP recovery matrix retains all v7/v8 S0/S1/S2 cases. It also exercises
default-baseline S2 → negotiated Worker API → actual browser ZIP writer →
default-baseline S2 recovery, comparing every physical table, retention
projection, packaged blob byte, original archive, and provenance artifact. A
separate v7 → default-baseline case verifies the old nonzero counters survive in
the retired-field artifact while staying absent from final active rows.

These are local application and recovery checks. Passing them does not prove
that old serving requests ended, authorize B/C/D remote stages, demonstrate
deployment rollback, or replace the still-required browser acceptance.

## Recorded local result — 2026-09-13

The full `npm run verify:ci` command exited successfully on frozen commit
`6d9d634eec34d21147036c432b23130bd63031a6`, tree
`ed12acb9823a85d7c2537764512cb4a22e69abe2`. All 11 leaves passed:
81 verification-script cases, 1,107 source cases across 194 files, 467 mounted
cases across 62 files, rich-text bundle, export type contract, actual Wrangler
baseline migration, Reference Worker, Reference search Worker, build, Project
Map bundle, and the production-artifact Project Worker smoke. The final default
baseline migration ran 364 installed-Wrangler commands including its ledger
entry. The map bundle retained lazy ownership across 6 initial and 16 Map chunks.

The 24-case ZIP recovery matrix includes both new default-baseline restore
paths. Independent review additionally ran the 21 Sample/process/metrology
cases and the two baseline restore cases, and verified the unchanged history,
baseline, original S0 fixture, and historical Worker patch/hash bytes.

One earlier full-run attempt timed out waiting for the initial Reference card
in the existing mounted drag-continuity test. Its isolated rerun and the final
complete mounted suite passed without frontend, assertion, or timeout changes.
This record does not claim that the earlier initialization failure's cause was
identified or eliminated. No browser or remote-stage acceptance is recorded.

## Integration synchronization — 2026-09-13

The candidate incorporates integration commit
`b8fc0bb4f5ec25fe54879d5bf251c17131c809e7`, including the read-only observation
transport merged in PR #203 and the deployed S0 browser/roadmap evidence merged
in PR #204. That S0 browser evidence does not establish final S2 activation or
browser acceptance. The candidate remains an inactive Draft with the same
retirement, recovery and migration-selection barriers.

The newly added transport parity test originally read the default `migrations/`
directory while asserting the historical 37-file chain. Combining the branches
reproduced a `1 !== 37` failure. The S0 case now reads the explicit archived
history directory; a separate fresh-database case verifies the default S2
baseline. Both compare complete normalized schema and exact ledger rows with
the binding observer. No production observer or remote activation behavior was
changed. The verification-script command retains both the original S2 source/C
writer gates and the new remote-transport tests.

The combined `npm run test:verification-scripts` leaf passed all 90 cases and
the 34-file shared ownership gate. This includes actual local D1 S0/S2 observer
parity, C Worker qualification, baseline/history identity, and local Wrangler
selection/failure/retry checks. These tests made no live Cloudflare request.
The earlier complete-application result above belongs to its recorded frozen
commit. The synchronized complete gate at `48834069023a8751d7c9cc6752af01662329f2ac`
was subsequently recorded in PR #202 with all 11 leaves passing, followed by
successful CI on documentation head `ecbc7ee2985bb2e4870d967348e74c910d66a725`.
The later managed-storage configuration extension and current remote
write-authentication blocker are recorded in the
[activation checkpoint](./CLOUDFLARE_S2_ACTIVATION_CHECKPOINT.md). Neither result
constitutes final S2 deployment or browser acceptance.
