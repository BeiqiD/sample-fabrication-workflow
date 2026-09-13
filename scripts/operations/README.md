# Manual disposable S0 reset

`reset-disposable-s0.sql` supports the owner's current
[in-place S2 rebuild](../../docs/BACKEND_DISPOSABLE_S2_CUTOVER.md). It discards
application data inside the existing D1 database; it does not replace the Worker,
D1 ID/binding, R2 bucket/binding, or SWITCHdrive root and credentials. It is not
part of `migrations/`, an npm deployment command, or an automatic recovery path.

Before execution, confirm the disposable target and the complete expected S0
schema from the 37 ordered files in `migrations-history/s0/`, including its
migration ledger. Unknown application tables, views, triggers, indexes or
foreign-key dependencies require review before proceeding. Establish the
maintenance conditions in the linked procedure: stop builds, HTTP writers,
scheduled jobs and old requests. The SQL file does not enforce these conditions.

The fixed allowlist drops 198 known triggers, 15 views, 34 application tables
in child-before-parent order, and `d1_migrations` last. Application-owned indexes
(including `sqlite_autoindex_*`) disappear with their tables. It never explicitly
drops `_cf_*` or `sqlite_*` objects, disables foreign keys, or generates SQL from
a live remote object inventory. It contains no baseline or synthetic ledger rows.

`IF EXISTS` permits retrying a recorded interrupted reset under the same
maintenance conditions, before baseline initialization. Reinspect the remaining
objects before a retry; a successful baseline or reopened application must never
be followed by this reset. After the reset, require an empty application schema
and absent migration ledger, then let ordinary migrations initialize
`migrations/0001_v3_baseline.sql`. A baseline failure belongs to migration recovery,
not an automatic repeat of this destructive operation.

## Local reproduction

Run from a trusted repository checkout after `npm ci`, with Node 24 and the
installed Wrangler. These commands create only a new local fixture. The two
configurations deliberately keep the same local database name, ID and `DB`
binding; only `migrations_dir` changes. Keep the same persistence path throughout.

```sh
mkdir -p .wrangler
export RESET_REHEARSAL_DIR="$(mktemp -d "$PWD/.wrangler/disposable-s0-reset.XXXXXX")"
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const destination = process.env.RESET_REHEARSAL_DIR;
for (const [stage, migrations] of [['s0', 'migrations-history/s0'], ['s2', 'migrations']]) {
  writeFileSync(join(destination, `${stage}.jsonc`), JSON.stringify({
    name: 'disposable-s0-reset-rehearsal', compatibility_date: '2026-07-20',
    d1_databases: [{ binding: 'DB', database_name: 'disposable-s0-reset-rehearsal',
      database_id: '00000000-0000-4000-8000-000000000001',
      migrations_dir: resolve(migrations) }],
  }));
}
JS
cat worker/fixtures/reference-graph-s0.sql scripts/fixtures/backend-schema/retained-data.sql > "$RESET_REHEARSAL_DIR/fixture.sql"
wrangler_local() {
  node node_modules/wrangler/bin/wrangler.js d1 "$@" --local --persist-to "$RESET_REHEARSAL_DIR/state"
}
wrangler_local migrations apply DB --config "$RESET_REHEARSAL_DIR/s0.jsonc"
wrangler_local execute DB --config "$RESET_REHEARSAL_DIR/s0.jsonc" --file "$RESET_REHEARSAL_DIR/fixture.sql"
wrangler_local execute DB --config "$RESET_REHEARSAL_DIR/s0.jsonc" --command 'SELECT count(*) AS historical_migrations FROM d1_migrations; SELECT count(*) AS disposable_samples FROM samples;'
wrangler_local execute DB --config "$RESET_REHEARSAL_DIR/s0.jsonc" --file scripts/operations/reset-disposable-s0.sql
wrangler_local execute DB --config "$RESET_REHEARSAL_DIR/s0.jsonc" --command 'SELECT type,name,tbl_name FROM sqlite_schema ORDER BY type,name;'
# Confirm only system objects remain, then apply the normal baseline migration.
wrangler_local migrations apply DB --config "$RESET_REHEARSAL_DIR/s2.jsonc"
wrangler_local execute DB --config "$RESET_REHEARSAL_DIR/s2.jsonc" --command 'SELECT name FROM d1_migrations ORDER BY id; PRAGMA foreign_keys; PRAGMA foreign_key_check; PRAGMA quick_check;'
```

The final ledger must contain only `0001_v3_baseline.sql`; foreign keys must be
`1`, `foreign_key_check` empty, and `quick_check` `ok`. For a separate fresh control,
apply the same S2 config with `--persist-to "$RESET_REHEARSAL_DIR/fresh-state"`,
then compare complete normalized application schemas and every table's seed rows.
The repository's `observeD1Migrations`, `normalizeSchema` and `generateS2Baseline`
helpers provide those comparisons. Local `getPlatformProxy` observations must
use `state/v3` beneath Wrangler's `--persist-to` directory.

## Recorded local result — 2026-09-13

Actual Wrangler **4.112.0** commands passed against the 37-file historical S0
chain plus both fixtures above: 53 application rows existed before reset.
The same database ID, `DB` binding and persistence directory were reused for
reset and ordinary baseline migration. Checks confirmed:

- Complete empty application schema and absent ledger after reset.
- `_cf_METADATA` and `sqlite_sequence` definitions survived reset and baseline;
  these were the system objects present in this local fixture.
- Repeating the completed reset succeeded before baseline initialization.
- In a separate populated fixture, execution was interrupted after all
  trigger/view drops and the first five table drops; rerunning the complete
  allowlist finished the reset with no application objects or ledger remaining.
- The final ledger contained only `0001_v3_baseline.sql`; all 34 tables and
  their 20 baseline seed rows exactly matched both the reviewed baseline model
  and an independently initialized local D1 control, including indexes, views,
  triggers, columns and foreign-key definitions.
- Foreign keys remained enabled, `foreign_key_check` returned no violations,
  and `quick_check` returned `ok` before reset and after each checked stage.

Normalized schema fingerprints:

| State | SHA-256 |
| --- | --- |
| Reviewed S0 | `472baeaa7c5cbc1de6a813bbedabd52ac035cc34ec2cb14b47784a7a2787ee5f` |
| Final S2 | `71e082ee9bbf00f8844c5580bbc81c8dec3894025fc0d17b88584a8ce984c4b2` |
| Reset SQL bytes | `c27fc28ac3d47fc08f3bcb893b899b89e687795d896acd5df9d804ff1efc621e` |

This is local D1 evidence. No remote reset, maintenance activation, deployment,
R2 operation or SWITCHdrive operation was performed by this rehearsal.
