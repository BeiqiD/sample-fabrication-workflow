# Read-only D1 migration observations

Status: local qualification of an input adapter for the read-only migration
planner. The separate [remote observation CLI](BACKEND_REMOTE_MIGRATION_OBSERVATION.md)
has offline transport tests and actual local D1 parity; a real remote observation
is still an operational gate. No deployment command, migration directory or
provider binding is changed. An observation is not migration or deployment
authorization.

`observeD1Migrations(database)` in `scripts/d1-migration-observer.mjs` accepts a D1
binding and returns the planner's `{ schema, ledger }` target input. The adapter
has no filesystem, subprocess, remote-connection setup or mutation SQL. A caller
must still supply an independently reviewed catalog and exact migration sources
to `planD1Migrations`; that planner continues to return
`executionAuthorized: false`.

## One complete snapshot

The adapter first issues a fixed `SELECT EXISTS` against `sqlite_schema` to find
whether naming `d1_migrations` in a query is legal. It does not create the ledger.
The probe's data is used only to choose the query list, not as returned schema or
ledger evidence.

The returned observation comes from one D1 batch:

1. A fixed JSON-producing SELECT captures every `sqlite_schema` object and full
   table/view columns, foreign keys, indexes and index columns. Table-valued
   PRAGMAs receive names from SQLite as values; no observed identifier becomes
   executable SQL text.
2. If the ledger exists, a SELECT captures its `id`, `name` and `applied_at` rows
   in ID order in the same batch.

If ledger existence differs between the probe and snapshot, the adapter rejects.
A ledger dropped before its planned SELECT also fails the whole batch. It never
combines probe-era schema or ledger rows with snapshot-era data. Missing results,
unsuccessful D1 results, invalid JSON, incomplete application metadata, malformed
ledger rows, duplicates and invalid row order all reject without a partial input.

## Explicit protected-platform exception

The installed Miniflare `4.20260714.0` / workerd `1.20260714.1` exposes a protected
`_cf_METADATA` table in `sqlite_schema`. D1 rejects both ordinary and table-valued
PRAGMA access to that table with `SQLITE_AUTH`. The workerd
[metadata implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite-metadata.h)
identifies this table as internal storage, including local D1 bookmarks.
Cloudflare separately documents the normal application
[schema inspection PRAGMAs](https://developers.cloudflare.com/d1/sql-api/sql-statements/).

Only these exact engine definitions are admitted without relation metadata:

```sql
CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB);
CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID;
```

Both CREATE definitions were verified in the installed workerd binary;
`_cf_METADATA` was also read from the live local D1 `sqlite_schema`. The observer
preserves these raw schema objects while deliberately omitting their inaccessible
PRAGMA relations. It does not fabricate columns, indexes or foreign keys.

The planner validates exact object kind, owner and conservatively tokenized SQL
before allowing this exception. A different definition or an index attached to
either protected table rejects for review. Application triggers on these tables
remain in the application fingerprint. No underscore or `_cf_` prefix rule hides
other objects; the ledger and every application table/view still require complete
metadata. A new engine definition requires a reviewed qualification change.

Local D1 can create its own `_cf_METADATA` bookmark table after its first SELECT.
That engine bookkeeping is separate from the adapter's read-only SQL. Tests
verify that observation creates neither a migration ledger nor application
objects and does not change application data.

## Verification and cost

Run:

```sh
node --test scripts/d1-migration-plan.test.mjs scripts/d1-migration-observer.test.mjs
```

Tests compare actual local D1 with an independent host SQLite observer using
ordinary PRAGMAs. They cover an empty database; a complex schema with generated
columns, quoted names, a partial/expression index, WITHOUT ROWID, foreign keys,
views and triggers; and the complete current 37-file migration chain with its
ledger. The real D1 schema and ledger produce a no-op legacy proposal without
receiving baseline SQL. The synthetic test baseline is a concatenation used only
to exercise planner wiring, not a qualified clean baseline.

For the current chain, observation uses one preliminary statement plus two
snapshot statements, independent of the number of tables. In the recorded local
run, snapshot `rows_read` was 1,946 for schema and 37 for ledger, and the schema
JSON was 338,984 bytes. These are fixture diagnostics, not production limits or a
latency guarantee. The tests retain a dedicated 60-second budget for constructing
and observing the complete real D1 fixture.

The binding adapter does not itself set up remote transport. Its companion
[remote CLI](BACKEND_REMOTE_MIGRATION_OBSERVATION.md) preserves the validation
contract while combining schema and ledger into a single SQL statement, because
the REST documentation does not establish the binding batch's transaction
guarantee. Real remote execution of that read, deployment serialization,
recovery evidence, serving-version retirement, migration execution and
clean-baseline activation remain separate operational or implementation gates.
