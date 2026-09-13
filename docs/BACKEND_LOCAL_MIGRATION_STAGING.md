# Isolated local Wrangler migration staging

This Phase 6A5 qualification runs the actual installed Wrangler migration command
inside newly created private fixture directories. It completes the locally
testable selection/staging/apply boundary. It does not activate the baseline,
change active migrations or deployment configuration, open an existing database,
or provide a remote executor.

```sh
node scripts/rehearse-local-migration-staging.mjs --destination NEW_DIRECTORY
node --test scripts/local-migration-staging.test.mjs
```

The command accepts only that argument pair and creates both empty and retained
fixtures. The destination must not exist. Successful artifacts include original
schema/data/ledger evidence, exact source hashes, staged SQL, accepted proposals,
Wrangler process receipts, and verified result reports. Existing directories,
symlinks and linked persistence files are rejected. Test-created fixtures are
removed after the tests; the manual command preserves its new directory for
inspection. No provider data is touched.

## Selection and execution

The script constructs its catalog from the repository's 37 historical files
in `migrations-history/s0/`,
the reviewed inactive S1/S2 candidates, and the generated S2 baseline. It requires
the baseline to match the exact historical/stage source bytes and obtains
expected schema states independently with host SQLite. The target observation
cannot supply a catalog, source SQL or expected schema.

| Local fixture | Staged migration names | Final ledger |
| --- | --- | --- |
| Empty | `0001_v3_baseline.sql` | One baseline entry |
| Retained S0 | `0037_compatibility_bridge.sql`, `0038_final_schema.sql` | Original 37 rows followed by two entries |
| Retained S1 retry | `0038_final_schema.sql` | Original 38 rows followed by one entry |

Staged SQL is byte-for-byte identical to its reviewed source. The baseline alone
already contains the generator's separately qualified formatting. This wrapper
does not rewrite historical SQL or rely on a numeric migration-prefix shortcut;
both historical `0015_*` filenames remain distinct ledger entries.

The script launches installed Wrangler with constructed `d1 migrations apply
DB --local --config ... --persist-to ...` arguments, a private configuration,
random local binding identity, and a credential-free subprocess environment.
Retained fixture setup also uses real Wrangler for the original migration chain
and fixed fixture SQL. No replacement CLI or hand-built migration batch is used.

The read-only observer opens the same local database using `getPlatformProxy`
with `persist.path = CLI_PERSIST_PATH/v3`, remote bindings disabled and no
environment files. Each proxy is disposed before invoking Wrangler. Observation
itself does not initialize `d1_migrations`; Wrangler's apply command does.

Immediately before apply, the script rechecks source hashes, source inventory,
private configuration, staging files and hashes, and the complete schema/ledger
observation. An in-process operation lock and exclusive private directory bound
this rehearsal; they are not a distributed lock or a serving-request retirement
proof. Persistence directory identities, symlinks and hard links are checked
before opening the local state.

## Actual CLI qualification and failure handling

Five permanent tests run in the existing verification-scripts leaf. They prove
raw-source execution, complete final schema and data, exact original ledger
preservation, no-op selection, rejection before apply on source/staging/config/
schema/ledger drift, and protection against linked external paths.

The failure case begins with an actual CLI-created retained S1 database. A fixed
test-only data fault violates the S2 text-owner assertion. Wrangler fails after
creating the assertion table; that DDL rolls back, every row stays unchanged,
and no failed migration ledger entry is recorded. The assertion fails before
Wrangler reaches the appended ledger INSERT. The original 38 ledger rows remain unchanged. After correcting
only the fixture data, a fresh plan stages the identical S2 SQL hash and bytes,
and the actual CLI retry succeeds.

Wrangler commits migration files independently. A failed attempt may therefore
leave a valid earlier prefix; the planner reclassifies the actual schema and
ledger before retry. Failure reports use `outcome: apply-failed`. A result reports
`verified-local-success` only after final schema, exact ledger suffix, every
retained row, foreign-key enforcement, empty foreign-key violations and one
successful `quick_check` result have all been checked. Unexpected postcheck
failure leaves process receipts/proposals, without a success result.

The preserved original JSON retains actual retired counters (including 37 and
9007199254740000), occurrence bodies and all original ledger fields. This fixture
evidence supplements the separately qualified complete ZIP restore matrix; it
does not replace a real immutable remote backup, historical source provenance,
retirement evidence, rollback floor or remote deployment gates. Every proposal
keeps `executionAuthorized: false`; every local result keeps
`remoteExecutionAuthorized: false`.
